import type { Solution, SolvedCamera } from "./solve-types";

/**
 * Top view of a solve: looking down the world's +y axis (y is down in the
 * camera's frame, so this is from above for a level first camera), with x
 * to the right and z, the first camera's forward, up the page.
 */

export interface PlanPoint {
   readonly x: number;
   readonly y: number;
}

/** World position -> plan coordinates (SVG y grows downward). */
export function toPlan([x, , z]: readonly number[]): PlanPoint {
   return { x, y: -z };
}

/** The camera's viewing direction in world space (the third row of R). */
export function forward(camera: SolvedCamera): readonly number[] {
   const r = camera.rotation;
   return [r[6], r[7], r[8]];
}

function quantile(sorted: number[], q: number): number {
   return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export interface PlanBounds {
   readonly x: number;
   readonly y: number;
   readonly width: number;
   readonly height: number;
}

/**
 * A square view box around the cameras and most of the points. Far-off
 * points (a few bad triangulations are normal) would shrink everything else
 * to a dot, so points only count between their 5th and 95th percentiles.
 */
export function planBounds(solution: Solution): PlanBounds {
   const xs: number[] = [];
   const ys: number[] = [];
   for (const c of solution.cameras) {
      const p = toPlan(c.centre);
      xs.push(p.x);
      ys.push(p.y);
   }
   const pxs = solution.points.map((p) => toPlan(p.position).x);
   const pys = solution.points.map((p) => toPlan(p.position).y);
   pxs.sort((a, b) => a - b);
   pys.sort((a, b) => a - b);
   if (pxs.length > 0) {
      xs.push(quantile(pxs, 0.05), quantile(pxs, 0.95));
      ys.push(quantile(pys, 0.05), quantile(pys, 0.95));
   }
   const minX = Math.min(...xs);
   const maxX = Math.max(...xs);
   const minY = Math.min(...ys);
   const maxY = Math.max(...ys);
   const size = Math.max(maxX - minX, maxY - minY, 1e-6) * 1.1;
   const cx = (minX + maxX) / 2;
   const cy = (minY + maxY) / 2;
   return { x: cx - size / 2, y: cy - size / 2, width: size, height: size };
}

/** The camera whose centre is nearest `at` in plan, if any. */
export function nearestCamera(
   solution: Solution,
   at: PlanPoint,
): SolvedCamera | undefined {
   let best: SolvedCamera | undefined;
   let bestDistance = Infinity;
   for (const camera of solution.cameras) {
      const p = toPlan(camera.centre);
      const distance = Math.hypot(p.x - at.x, p.y - at.y);
      if (distance < bestDistance) {
         best = camera;
         bestDistance = distance;
      }
   }
   return best;
}
