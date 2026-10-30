import {
   FLAT_NORM,
   scoreMap,
   type LumaImage,
   type ScoreMapFn,
} from "../tracking/match";

/**
 * WebGPU version of `scoreMap` (tracking/match.ts): one invocation per search
 * offset, each computing the NCC of the pattern against the bilinear-sampled
 * candidate patch at that offset. The CPU `scoreMap` is the oracle; the two
 * agree to about 1e-5 (f32 vs f64 accumulation).
 *
 * Only the part of the image the search can touch is uploaded (see
 * `searchCrop`), so a call moves a few thousand floats, not a whole frame.
 */

export const SCORE_MAP_SHADER = /* wgsl */ `
struct Params {
   cx: f32,
   cy: f32,
   imgW: u32,
   imgH: u32,
   cropX: u32,
   cropY: u32,
   cropW: u32,
   radius: u32,
   size: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> pattern: array<f32>;
@group(0) @binding(2) var<storage, read> crop: array<f32>;
@group(0) @binding(3) var<storage, read_write> scores: array<f32>;

fn pixel(x: u32, y: u32) -> f32 {
   return crop[(y - params.cropY) * params.cropW + (x - params.cropX)];
}

// Same as sampleBilinear in match.ts: pixel centres at +0.5, clamped borders.
fn sampleAt(x: f32, y: f32) -> f32 {
   let fx = clamp(x - 0.5, 0.0, f32(params.imgW - 1u));
   let fy = clamp(y - 0.5, 0.0, f32(params.imgH - 1u));
   let x0 = u32(floor(fx));
   let y0 = u32(floor(fy));
   let x1 = min(x0 + 1u, params.imgW - 1u);
   let y1 = min(y0 + 1u, params.imgH - 1u);
   let tx = fx - f32(x0);
   let ty = fy - f32(y0);
   let top = mix(pixel(x0, y0), pixel(x1, y0), tx);
   let bottom = mix(pixel(x0, y1), pixel(x1, y1), tx);
   return mix(top, bottom, ty);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
   let side = 2u * params.radius + 1u;
   if (id.x >= side || id.y >= side) {
      return;
   }
   let x0 = params.cx + f32(id.x) - f32(params.radius) - f32(params.size - 1u) * 0.5;
   let y0 = params.cy + f32(id.y) - f32(params.radius) - f32(params.size - 1u) * 0.5;
   let n = params.size * params.size;

   // Two passes (mean, then centred sums): one-pass variance loses too much
   // precision in f32 on 0..255 luma.
   var sum = 0.0;
   for (var j = 0u; j < params.size; j++) {
      for (var i = 0u; i < params.size; i++) {
         sum += sampleAt(x0 + f32(i), y0 + f32(j));
      }
   }
   let mean = sum / f32(n);
   var dot = 0.0;
   var sq = 0.0;
   for (var j = 0u; j < params.size; j++) {
      for (var i = 0u; i < params.size; i++) {
         let v = sampleAt(x0 + f32(i), y0 + f32(j)) - mean;
         dot += pattern[j * params.size + i] * v;
         sq += v * v;
      }
   }
   let norm = sqrt(sq);
   // Flat candidates score 0, as on the CPU (FLAT_NORM in match.ts).
   scores[id.y * side + id.x] = select(dot / norm, 0.0, norm < ${FLAT_NORM});
}
`;

export interface Crop {
   readonly x: number;
   readonly y: number;
   readonly width: number;
   readonly height: number;
}

/**
 * The pixel rectangle that bilinear sampling can read for a search of
 * `radius` around (cx, cy) with a size×size pattern (clamped to the image).
 */
export function searchCrop(
   img: Pick<LumaImage, "width" | "height">,
   cx: number,
   cy: number,
   radius: number,
   size: number,
): Crop {
   const reach = radius + (size - 1) / 2 + 0.5;
   const clampX = (v: number) => Math.min(Math.max(v, 0), img.width - 1);
   const clampY = (v: number) => Math.min(Math.max(v, 0), img.height - 1);
   const x0 = clampX(Math.floor(cx - reach));
   const y0 = clampY(Math.floor(cy - reach));
   const x1 = clampX(Math.floor(cx + reach) + 1);
   const y1 = clampY(Math.floor(cy + reach) + 1);
   return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Copies a crop of the image, row-major. */
export function cropPixels(img: LumaImage, crop: Crop): Float32Array {
   const out = new Float32Array(crop.width * crop.height);
   for (let j = 0; j < crop.height; j++) {
      const start = (crop.y + j) * img.width + crop.x;
      out.set(img.data.subarray(start, start + crop.width), j * crop.width);
   }
   return out;
}

export interface GpuScoreMap {
   readonly scoreMap: ScoreMapFn;
   dispose(): void;
}

/**
 * A score map on `device`. Calls must not overlap (autoTrack awaits each
 * one), because they share buffers.
 */
export function createGpuScoreMap(device: GPUDevice): GpuScoreMap {
   const module = device.createShaderModule({ code: SCORE_MAP_SHADER });
   const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module, entryPoint: "main" },
   });
   const params = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
   });
   const buffers = new Map<string, GPUBuffer>();
   // Buffers grow to the largest size seen and are then reused.
   function buffer(name: string, bytes: number, usage: number): GPUBuffer {
      const existing = buffers.get(name);
      if (existing != null && existing.size >= bytes) {
         return existing;
      }
      existing?.destroy();
      const created = device.createBuffer({ size: bytes, usage });
      buffers.set(name, created);
      return created;
   }

   async function gpuScoreMap(
      pattern: Float32Array,
      size: number,
      img: LumaImage,
      cx: number,
      cy: number,
      radius: number,
   ): Promise<Float32Array> {
      const side = 2 * radius + 1;
      const crop = searchCrop(img, cx, cy, radius, size);
      const pixels = cropPixels(img, crop);
      const outBytes = side * side * 4;

      const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      const patternBuf = buffer("pattern", pattern.byteLength, storage);
      const cropBuf = buffer("crop", pixels.byteLength, storage);
      const scoresBuf = buffer(
         "scores",
         outBytes,
         GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      );
      const readBuf = buffer(
         "read",
         outBytes,
         GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      );

      const p = new DataView(new ArrayBuffer(48));
      p.setFloat32(0, cx, true);
      p.setFloat32(4, cy, true);
      [img.width, img.height, crop.x, crop.y, crop.width, radius, size].forEach(
         (v, i) => p.setUint32(8 + i * 4, v, true),
      );
      device.queue.writeBuffer(params, 0, p.buffer);
      device.queue.writeBuffer(patternBuf, 0, pattern);
      device.queue.writeBuffer(cropBuf, 0, pixels);

      const bindGroup = device.createBindGroup({
         layout: pipeline.getBindGroupLayout(0),
         entries: [
            { binding: 0, resource: { buffer: params } },
            {
               binding: 1,
               resource: { buffer: patternBuf, size: pattern.byteLength },
            },
            {
               binding: 2,
               resource: { buffer: cropBuf, size: pixels.byteLength },
            },
            { binding: 3, resource: { buffer: scoresBuf, size: outBytes } },
         ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(side / 8), Math.ceil(side / 8));
      pass.end();
      encoder.copyBufferToBuffer(scoresBuf, 0, readBuf, 0, outBytes);
      device.queue.submit([encoder.finish()]);

      await readBuf.mapAsync(GPUMapMode.READ, 0, outBytes);
      const scores = new Float32Array(
         readBuf.getMappedRange(0, outBytes).slice(0),
      );
      readBuf.unmap();
      return scores;
   }

   return {
      scoreMap: gpuScoreMap,
      dispose() {
         params.destroy();
         buffers.forEach((b) => b.destroy());
         buffers.clear();
      },
   };
}

export interface Scorer {
   readonly kind: "webgpu" | "cpu";
   readonly scoreMap: ScoreMapFn;
   dispose(): void;
}

const cpuScorer: Scorer = { kind: "cpu", scoreMap, dispose() {} };

/**
 * Picks the score map for auto-tracking: WebGPU when available, else the CPU
 * reference. If the GPU fails mid-run (e.g. device lost), it switches to the
 * CPU for good and retries that call, so a tracking run doesn't stop for it.
 *
 * The device is separate from the renderer's, so a matcher failure can't
 * take the frame display down with it (and vice versa).
 */
export async function createScorer(): Promise<Scorer> {
   let device: GPUDevice;
   try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (adapter == null) {
         return cpuScorer;
      }
      device = await adapter.requestDevice();
   } catch (err) {
      console.warn("WebGPU unavailable for tracking; using the CPU.", err);
      return cpuScorer;
   }
   let gpu: GpuScoreMap | null = createGpuScoreMap(device);
   const scorer = {
      kind: "webgpu" as Scorer["kind"],
      async scoreMap(...args: Parameters<ScoreMapFn>) {
         if (gpu != null) {
            try {
               return await gpu.scoreMap(...args);
            } catch (err) {
               console.warn("GPU score map failed; using the CPU.", err);
               gpu.dispose();
               gpu = null;
               scorer.kind = "cpu";
            }
         }
         return scoreMap(...args);
      },
      dispose() {
         gpu?.dispose();
         gpu = null;
         device.destroy();
      },
   };
   return scorer;
}
