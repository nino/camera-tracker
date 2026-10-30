import type { Point } from "../tracking/tracks";
import type { Solution, SolvedCamera, Vec3 } from "./solve-types";

export interface Lens {
   readonly focal: number;
   readonly k1: number;
   readonly k2: number;
}

/**
 * Where the solve puts a 3D point in a frame, in display pixels: the
 * solver's camera model (solver/src/camera.rs), a pinhole with radial
 * distortion and the principal point at the frame's centre. Null for a
 * point behind the camera.
 */
export function project(
   camera: SolvedCamera,
   lens: Lens,
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
   const x = p[0] / p[2];
   const y = p[1] / p[2];
   const r2 = x * x + y * y;
   const scale = lens.focal * (1 + r2 * (lens.k1 + lens.k2 * r2));
   return { x: scale * x + width / 2, y: scale * y + height / 2 };
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
      const point = project(camera, solution, width, height, p.position);
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
