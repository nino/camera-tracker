import type { Point } from "./tracks";

/**
 * Pattern matching for automatic tracking (CPU reference implementation).
 *
 * Images are single-channel luma in *display* pixels, row-major. As in
 * tracks.ts, pixel (i, j) covers [i, i+1) × [j, j+1), so its centre is at
 * (i + 0.5, j + 0.5); sampling at a point uses bilinear interpolation between
 * pixel centres, which is what makes sub-pixel positions meaningful.
 *
 * Matching is normalised cross-correlation (NCC) over a square pattern: robust
 * to brightness and contrast changes between frames, 1 for a perfect match,
 * 0 for no correlation. The best integer offset in the search window is then
 * refined to sub-pixel precision (see refineSubpixel).
 */

export interface LumaImage {
   readonly width: number;
   readonly height: number;
   readonly data: Float32Array;
}

export interface MatchOptions {
   /** Pattern side length in display pixels; odd. */
   patternSize: number;
   /** How far (display px, each axis) to search from the starting point. */
   searchRadius: number;
}

export const defaultMatchOptions: MatchOptions = {
   patternSize: 21,
   searchRadius: 24,
};

export interface MatchResult {
   /** Best position in the target image. */
   readonly point: Point;
   /** NCC score at the best integer offset, -1..1. */
   readonly score: number;
   /**
    * True if the best offset is on the edge of the search window, i.e. the
    * feature may have moved further than `searchRadius`.
    */
   readonly atEdge: boolean;
}

/** Bilinear sample at display coordinates (x, y), clamped at the borders. */
export function sampleBilinear(img: LumaImage, x: number, y: number): number {
   const fx = Math.min(Math.max(x - 0.5, 0), img.width - 1);
   const fy = Math.min(Math.max(y - 0.5, 0), img.height - 1);
   const x0 = Math.floor(fx);
   const y0 = Math.floor(fy);
   const x1 = Math.min(x0 + 1, img.width - 1);
   const y1 = Math.min(y0 + 1, img.height - 1);
   const tx = fx - x0;
   const ty = fy - y0;
   const row0 = y0 * img.width;
   const row1 = y1 * img.width;
   const top = img.data[row0 + x0] * (1 - tx) + img.data[row0 + x1] * tx;
   const bottom = img.data[row1 + x0] * (1 - tx) + img.data[row1 + x1] * tx;
   return top * (1 - ty) + bottom * ty;
}

/** A size×size patch centred on (cx, cy), row-major. */
export function extractPatch(
   img: LumaImage,
   cx: number,
   cy: number,
   size: number,
): Float32Array {
   const patch = new Float32Array(size * size);
   const half = (size - 1) / 2;
   for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
         patch[j * size + i] = sampleBilinear(
            img,
            cx + i - half,
            cy + j - half,
         );
      }
   }
   return patch;
}

/** Zero-mean, unit-norm copy of a patch; null if the patch is flat. */
export function normalise(patch: Float32Array): Float32Array | null {
   let mean = 0;
   for (const v of patch) {
      mean += v;
   }
   mean /= patch.length;
   let norm = 0;
   const out = new Float32Array(patch.length);
   for (let k = 0; k < patch.length; k++) {
      out[k] = patch[k] - mean;
      norm += out[k] * out[k];
   }
   norm = Math.sqrt(norm);
   if (norm < 1e-6) {
      return null;
   }
   for (let k = 0; k < out.length; k++) {
      out[k] /= norm;
   }
   return out;
}

/**
 * NCC scores for every integer offset in [-radius, radius]² around (cx, cy):
 * a (2r+1)² grid, row-major by dy then dx. `pattern` must be normalised.
 */
export function scoreMap(
   pattern: Float32Array,
   size: number,
   img: LumaImage,
   cx: number,
   cy: number,
   radius: number,
): Float32Array {
   const side = 2 * radius + 1;
   const scores = new Float32Array(side * side);
   for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
         const candidate = normalise(extractPatch(img, cx + dx, cy + dy, size));
         let score = 0;
         if (candidate != null) {
            for (let k = 0; k < pattern.length; k++) {
               score += pattern[k] * candidate[k];
            }
         }
         scores[(dy + radius) * side + (dx + radius)] = score;
      }
   }
   return scores;
}

/** Best integer offset in a score map, and whether it is on the window edge. */
export function peakOf(
   scores: Float32Array,
   radius: number,
): { dx: number; dy: number; score: number; atEdge: boolean } {
   const side = 2 * radius + 1;
   let best = 0;
   for (let k = 1; k < scores.length; k++) {
      if (scores[k] > scores[best]) {
         best = k;
      }
   }
   const bx = best % side;
   const by = Math.floor(best / side);
   return {
      dx: bx - radius,
      dy: by - radius,
      score: scores[best],
      atEdge: bx === 0 || by === 0 || bx === side - 1 || by === side - 1,
   };
}

/** NCC between a normalised pattern and the target patch centred at (x, y). */
export function nccAt(
   pattern: Float32Array,
   size: number,
   img: LumaImage,
   x: number,
   y: number,
): number {
   const candidate = normalise(extractPatch(img, x, y, size));
   if (candidate == null) {
      return 0;
   }
   let score = 0;
   for (let k = 0; k < pattern.length; k++) {
      score += pattern[k] * candidate[k];
   }
   return score;
}

/**
 * Refines an integer-pixel match to sub-pixel precision by hill-climbing the
 * NCC with bilinear sampling: try the 8 neighbours at the current step, move
 * to the best, halve the step. Parabola fits on the integer score grid are
 * cheaper but biased by up to ~0.3 px on asymmetric features.
 */
export function refineSubpixel(
   pattern: Float32Array,
   size: number,
   img: LumaImage,
   start: Point,
): { point: Point; score: number } {
   let { x, y } = start;
   let score = nccAt(pattern, size, img, x, y);
   for (let step = 0.5; step >= 1 / 64; step /= 2) {
      let improved = true;
      while (improved) {
         improved = false;
         for (const [sx, sy] of NEIGHBOURS) {
            const candidate = nccAt(
               pattern,
               size,
               img,
               x + sx * step,
               y + sy * step,
            );
            if (candidate > score + 1e-9) {
               score = candidate;
               x += sx * step;
               y += sy * step;
               improved = true;
            }
         }
      }
   }
   return { point: { x, y }, score };
}

const NEIGHBOURS = [
   [-1, -1],
   [0, -1],
   [1, -1],
   [-1, 0],
   [1, 0],
   [-1, 1],
   [0, 1],
   [1, 1],
] as const;

/**
 * Finds `pattern` (normalised with `normalise`, size×size) in `target` near
 * `around`.
 */
export function matchPattern(
   pattern: Float32Array,
   target: LumaImage,
   around: Point,
   options: MatchOptions = defaultMatchOptions,
): MatchResult {
   const scores = scoreMap(
      pattern,
      options.patternSize,
      target,
      around.x,
      around.y,
      options.searchRadius,
   );
   const peak = peakOf(scores, options.searchRadius);
   const integer = { x: around.x + peak.dx, y: around.y + peak.dy };
   if (peak.atEdge) {
      return { point: integer, score: peak.score, atEdge: true };
   }
   const refined = refineSubpixel(
      pattern,
      options.patternSize,
      target,
      integer,
   );
   return { ...refined, atEdge: false };
}
