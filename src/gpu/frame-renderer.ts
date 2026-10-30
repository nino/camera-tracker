import type { VideoSample } from "mediabunny";
import { createWebGpuRenderer } from "./webgpu-frame-renderer";

/** One frame to draw, with how strongly to blend it in. */
export interface FrameLayer {
   readonly sample: VideoSample;
   /** 0..1. The first layer is always drawn opaque. */
   readonly opacity: number;
   /** Per-channel multiplier, 0..1 each. [1, 1, 1] leaves colours alone. */
   readonly tint: readonly [number, number, number];
}

/**
 * Draws video frames onto a canvas. The viewer talks to this, not to WebGPU
 * or the 2D context directly, so it can be tested with a fake.
 *
 * `draw` clears the canvas, draws the first layer opaque, then alpha-blends
 * each following layer on top (onion-skinning). It must finish with the
 * samples synchronously: they are borrowed from the FrameSource (see
 * frame-source.ts).
 */
export interface FrameRenderer {
   /** Which backend is drawing. Shown in the UI and useful in bug reports. */
   readonly kind: "webgpu" | "2d";
   /**
    * Resolves with a reason if the renderer stops working on its own (WebGPU
    * device lost, e.g. a GPU process crash). Never resolves after dispose().
    */
   readonly lost?: Promise<string>;
   draw(layers: readonly FrameLayer[]): void;
   dispose(): void;
}

/** A single opaque, untinted frame. */
export function singleLayer(sample: VideoSample): FrameLayer[] {
   return [{ sample, opacity: 1, tint: [1, 1, 1] }];
}

function isTinted(tint: FrameLayer["tint"]): boolean {
   return tint.some((channel) => channel !== 1);
}

export type CreateRenderer = (
   canvas: HTMLCanvasElement,
) => Promise<FrameRenderer>;

/** Canvas 2D fallback, for webviews without WebGPU. */
export function create2dRenderer(canvas: HTMLCanvasElement): FrameRenderer {
   const ctx = canvas.getContext("2d");
   // Tinted layers are drawn here first, multiplied by the tint, then blended.
   let scratch: OffscreenCanvasRenderingContext2D | null = null;

   return {
      kind: "2d",
      draw(layers) {
         // jsdom has no 2D context; nothing to draw into.
         if (ctx == null) {
            return;
         }
         const { width, height } = canvas;
         layers.forEach((layer, i) => {
            const opacity = i === 0 ? 1 : layer.opacity;
            if (!isTinted(layer.tint)) {
               ctx.globalAlpha = opacity;
               layer.sample.draw(ctx, 0, 0, width, height);
               return;
            }
            if (
               scratch == null ||
               scratch.canvas.width !== width ||
               scratch.canvas.height !== height
            ) {
               scratch = new OffscreenCanvas(width, height).getContext("2d");
            }
            if (scratch == null) {
               return;
            }
            scratch.globalCompositeOperation = "source-over";
            layer.sample.draw(scratch, 0, 0, width, height);
            scratch.globalCompositeOperation = "multiply";
            const [r, g, b] = layer.tint.map((c) => Math.round(c * 255));
            scratch.fillStyle = `rgb(${r} ${g} ${b})`;
            scratch.fillRect(0, 0, width, height);
            ctx.globalAlpha = opacity;
            ctx.drawImage(scratch.canvas, 0, 0);
         });
         ctx.globalAlpha = 1;
      },
      dispose() {},
   };
}

/** create2dRenderer as a CreateRenderer. */
export const createCanvas2dRenderer: CreateRenderer = async (canvas) =>
   create2dRenderer(canvas);

/** WebGPU when the webview has it, otherwise canvas 2D. */
export const createRenderer: CreateRenderer = async (canvas) => {
   if (navigator.gpu != null) {
      try {
         return await createWebGpuRenderer(canvas);
      } catch (err) {
         console.warn("WebGPU renderer unavailable, using canvas 2D:", err);
      }
   }
   return create2dRenderer(canvas);
};
