import type { LumaImage } from "../tracking/match";

/** A luma image rendered from a function of display coordinates (pixel centres). */
export function renderLuma(
   width: number,
   height: number,
   f: (x: number, y: number) => number,
): LumaImage {
   const data = new Float32Array(width * height);
   for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
         data[j * width + i] = f(i + 0.5, j + 0.5);
      }
   }
   return { width, height, data };
}

const BLOBS = [
   [50, 40, 4, 1],
   [58, 45, 3, -0.6],
   [44, 50, 5, 0.8],
   [55, 34, 2.5, 0.5],
] as const;

/**
 * A smooth, textured 100×80 test scene (a few Gaussian blobs) shifted by
 * (ox, oy). Its main feature sits around (50.5, 42.5).
 */
export function blobScene(ox: number, oy: number): LumaImage {
   return renderLuma(100, 80, (x, y) =>
      BLOBS.reduce(
         (sum, [bx, by, r, a]) =>
            sum +
            a *
               Math.exp(
                  -((x - bx - ox) ** 2 + (y - by - oy) ** 2) / (2 * r * r),
               ),
         0,
      ),
   );
}
