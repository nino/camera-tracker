import type { VideoSample } from "mediabunny";
import type { LumaImage } from "./match";

/**
 * Returns a function that converts samples to luma images at display size,
 * reusing one scratch canvas. Browser-only (needs OffscreenCanvas); tests
 * inject their own reader instead.
 *
 * Uses Rec. 709 weights on the sRGB values the canvas gives us. That isn't
 * true linear luminance, but matching only needs a consistent single channel.
 */
export function createLumaReader(
   width: number,
   height: number,
): (sample: VideoSample) => LumaImage {
   const ctx = new OffscreenCanvas(width, height).getContext("2d", {
      willReadFrequently: true,
   });
   if (ctx == null) {
      throw new Error("No 2D context for reading frame pixels.");
   }
   return (sample) => {
      sample.draw(ctx, 0, 0, width, height);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const data = new Float32Array(width * height);
      for (let i = 0, p = 0; i < data.length; i++, p += 4) {
         data[i] =
            0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2];
      }
      return { width, height, data };
   };
}
