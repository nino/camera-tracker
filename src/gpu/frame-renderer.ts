import type { VideoSample } from "mediabunny";
import { createWebGpuRenderer } from "./webgpu-frame-renderer";

/**
 * Draws one video frame onto a canvas. The viewer talks to this, not to WebGPU
 * or the 2D context directly, so it can be tested with a fake.
 *
 * `draw` must finish with the sample synchronously: samples are borrowed from
 * the FrameSource (see frame-source.ts).
 */
export interface FrameRenderer {
   /** Which backend is drawing. Shown in the UI and useful in bug reports. */
   readonly kind: "webgpu" | "2d";
   draw(sample: VideoSample): void;
   dispose(): void;
}

export type CreateRenderer = (
   canvas: HTMLCanvasElement,
) => Promise<FrameRenderer>;

/** Canvas 2D fallback, for webviews without WebGPU. */
export function create2dRenderer(canvas: HTMLCanvasElement): FrameRenderer {
   const ctx = canvas.getContext("2d");
   return {
      kind: "2d",
      draw(sample) {
         // jsdom has no 2D context; nothing to draw into.
         if (ctx != null) {
            sample.draw(ctx, 0, 0, canvas.width, canvas.height);
         }
      },
      dispose() {},
   };
}

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
