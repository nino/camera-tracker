import type { VideoSample } from "mediabunny";
import type { FrameRenderer } from "./frame-renderer";

/**
 * Fullscreen triangle that samples the frame texture.
 *
 * The pipeline alpha-blends the output over what is already in the target, using
 * `opacity`, and multiplies colours by `tint` (onion-skin layers).
 *
 * `rotation` is the sample's display rotation in quarter turns clockwise. The
 * canvas is sized to the *display* (rotated) dimensions, so for each output
 * pixel we map display UV back to the coded frame's UV.
 */
export const FRAME_SHADER = /* wgsl */ `
struct Params {
   tint: vec3f,
   opacity: f32,
   rotation: u32,
}

@group(0) @binding(0) var frameSampler: sampler;
@group(0) @binding(1) var frame: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

struct VsOut {
   @builtin(position) position: vec4f,
   @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
   // (0,0), (2,0), (0,2): one triangle that covers the whole viewport.
   let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
   var out: VsOut;
   out.position = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
   // Clip space is y-up; texture space is y-down.
   out.uv = vec2f(xy.x, 1.0 - xy.y);
   return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
   let d = in.uv;
   var s: vec2f;
   switch params.rotation {
      case 1u: { s = vec2f(d.y, 1.0 - d.x); }
      case 2u: { s = vec2f(1.0 - d.x, 1.0 - d.y); }
      case 3u: { s = vec2f(1.0 - d.y, d.x); }
      default: { s = d; }
   }
   let color = textureSample(frame, frameSampler, s);
   return vec4f(color.rgb * params.tint, params.opacity);
}
`;

/**
 * Draws a video frame into any render target of `format`. Split from the
 * canvas so frames can also be drawn into offscreen textures (onion-skin
 * layers, tests that read pixels back).
 *
 * Each frame is copied into a regular texture with
 * `copyExternalImageToTexture`, which also converts the video's colour space
 * to sRGB. We chose this over `importExternalTexture`; see PLAN.md, "Key
 * design decisions".
 */
export interface DrawOptions {
   load?: GPULoadOp;
   opacity?: number;
   tint?: readonly [number, number, number];
}

export interface FrameDrawer {
   /**
    * Draws `sample` into `target`. With `load: "clear"` (the default) the
    * target is cleared first; with `"load"` the frame is blended over it.
    */
   draw(
      sample: VideoSample,
      target: GPUTextureView,
      options?: DrawOptions,
   ): void;
   dispose(): void;
}

export function createFrameDrawer(
   device: GPUDevice,
   format: GPUTextureFormat,
): FrameDrawer {
   const module = device.createShaderModule({ code: FRAME_SHADER });
   const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: {
         module,
         entryPoint: "fs",
         targets: [
            {
               format,
               blend: {
                  color: {
                     srcFactor: "src-alpha",
                     dstFactor: "one-minus-src-alpha",
                  },
                  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
               },
            },
         ],
      },
      primitive: { topology: "triangle-list" },
   });
   const sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
   });
   // Params: tint vec3f @0, opacity f32 @12, rotation u32 @16; 32 bytes total.
   const paramData = new ArrayBuffer(32);
   const paramFloats = new Float32Array(paramData);
   const paramUints = new Uint32Array(paramData);
   const params = device.createBuffer({
      size: paramData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
   });

   // One texture, reused while the frame size stays the same.
   let texture: GPUTexture | null = null;
   let bindGroup: GPUBindGroup | null = null;

   function ensureTexture(width: number, height: number) {
      if (texture?.width === width && texture.height === height) {
         return;
      }
      texture?.destroy();
      texture = device.createTexture({
         size: [width, height],
         format: "rgba8unorm",
         usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            GPUTextureUsage.RENDER_ATTACHMENT,
      });
      bindGroup = device.createBindGroup({
         layout: pipeline.getBindGroupLayout(0),
         entries: [
            { binding: 0, resource: sampler },
            { binding: 1, resource: texture.createView() },
            { binding: 2, resource: { buffer: params } },
         ],
      });
   }

   return {
      draw(
         sample,
         target,
         { load = "clear", opacity = 1, tint = [1, 1, 1] } = {},
      ) {
         // This VideoFrame is ours (the sample stays in the cache). The copy
         // is enqueued synchronously, so we can close it straight after.
         const frame = sample.toVideoFrame();
         try {
            const width = frame.displayWidth;
            const height = frame.displayHeight;
            ensureTexture(width, height);
            device.queue.copyExternalImageToTexture(
               { source: frame },
               { texture: texture! },
               [width, height],
            );
         } finally {
            frame.close();
         }
         paramFloats.set(tint, 0);
         paramFloats[3] = load === "clear" ? 1 : opacity;
         paramUints[4] = ((sample.rotation / 90) | 0) % 4;
         // Queue writes and submits run in order, so each layer's draw sees
         // its own params and texture even though both are reused.
         device.queue.writeBuffer(params, 0, paramData);

         const encoder = device.createCommandEncoder();
         const pass = encoder.beginRenderPass({
            colorAttachments: [
               {
                  view: target,
                  loadOp: load,
                  storeOp: "store",
                  clearValue: [0, 0, 0, 1],
               },
            ],
         });
         pass.setPipeline(pipeline);
         pass.setBindGroup(0, bindGroup);
         pass.draw(3);
         pass.end();
         device.queue.submit([encoder.finish()]);
      },
      dispose() {
         texture?.destroy();
         params.destroy();
      },
   };
}

/** A FrameRenderer that draws to a canvas through WebGPU. */
export async function createWebGpuRenderer(
   canvas: HTMLCanvasElement,
): Promise<FrameRenderer> {
   const gpu = navigator.gpu;
   if (gpu == null) {
      throw new Error("navigator.gpu is undefined.");
   }
   const adapter = await gpu.requestAdapter();
   if (adapter == null) {
      throw new Error("No WebGPU adapter.");
   }
   const device = await adapter.requestDevice();
   // Track our own dispose() rather than trusting `info.reason`: Chromium
   // reports a GPU process crash as "destroyed" too.
   let disposed = false;
   const lost = device.lost.then((info) =>
      disposed
         ? new Promise<string>(() => {})
         : `WebGPU device lost: ${info.message || info.reason}`,
   );

   const context = canvas.getContext("webgpu");
   if (context == null) {
      device.destroy();
      throw new Error("Canvas has no WebGPU context.");
   }
   const format = gpu.getPreferredCanvasFormat();
   context.configure({ device, format, alphaMode: "opaque" });
   const drawer = createFrameDrawer(device, format);

   return {
      kind: "webgpu",
      lost,
      draw(layers) {
         const target = context.getCurrentTexture().createView();
         layers.forEach((layer, i) =>
            drawer.draw(layer.sample, target, {
               load: i === 0 ? "clear" : "load",
               opacity: layer.opacity,
               tint: layer.tint,
            }),
         );
      },
      dispose() {
         disposed = true;
         drawer.dispose();
         context.unconfigure();
         device.destroy();
      },
   };
}
