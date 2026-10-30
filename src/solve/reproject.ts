import type { Point } from "../tracking/tracks";
import type { Solution, SolvedCamera, Vec3 } from "./solve-types";

/**
 * Where the solve puts a 3D point in a frame, in display pixels: the
 * solver's pinhole model with the principal point at the frame's centre
 * (solver/src/camera.rs). Null for a point behind the camera.
 */
export function project(
   camera: SolvedCamera,
   focal: number,
   width: number,
   height: number,
   X: Vec3,
): Point | null {
   const r = camera.rotation;
   const t = camera.translation;
   const p = [0, 1, 2].map(
      (i) => r[3 * i] * X[0] + r[3 * i + 1] * X[1] + r[3 * i + 2] * X[2] + t[i],
   );
   if (p[2] <= 1e-9) {
      return null;
   }
   return {
      x: (focal * p[0]) / p[2] + width / 2,
      y: (focal * p[1]) / p[2] + height / 2,
   };
}

export interface Reprojection {
   readonly id: number;
   readonly point: Point;
}

/** Every solved point's position on `frame`, if that frame was solved. */
export function reprojections(
   solution: Solution,
   frame: number,
   width: number,
   height: number,
): Reprojection[] {
   const camera = solution.cameras.find((c) => c.frame === frame);
   if (camera == null) {
      return [];
   }
   const out: Reprojection[] = [];
   for (const p of solution.points) {
      const point = project(camera, solution.focal, width, height, p.position);
      if (point != null) {
         out.push({ id: p.id, point });
      }
   }
   return out;
}

/** Solved tracks by error, worst first. */
export function worstTracks(solution: Solution, count: number) {
   return [...solution.points]
      .sort((a, b) => b.error - a.error)
      .slice(0, count);
}
