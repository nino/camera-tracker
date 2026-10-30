/**
 * The solver's JSON format (solver/src/api.rs). Positions are in display
 * pixels, as in tracking/tracks.ts. Cameras are world-to-camera
 * (`p = R X + t`) with x right, y down and z forward; the first keyframe's
 * camera sits at the origin. Pixels include lens distortion (see `k1`).
 */

export interface SolveRequest {
   readonly width: number;
   readonly height: number;
   readonly frameCount: number;
   /** Focal length guess, pixels. */
   readonly focal: number;
   readonly refineFocal: boolean;
   /** Radial distortion guess (solver/src/camera.rs); 0 for none. */
   readonly k1: number;
   readonly k2: number;
   readonly refineDistortion: boolean;
   readonly tracks: readonly {
      readonly id: number;
      /** `[frame, x, y]`, one per keyed frame. */
      readonly keys: readonly (readonly [number, number, number])[];
   }[];
}

export type Vec3 = readonly [number, number, number];

export interface SolvedCamera {
   readonly frame: number;
   /** World-to-camera rotation, row-major 3×3. */
   readonly rotation: readonly number[];
   readonly translation: Vec3;
   /** Camera centre in world coordinates. */
   readonly centre: Vec3;
}

export interface SolvedPoint {
   readonly id: number;
   readonly position: Vec3;
   /** RMS reprojection error of this track, pixels. */
   readonly error: number;
}

export interface Solution {
   readonly status: "solved";
   /** Focal length, pixels (refined if asked). */
   readonly focal: number;
   /**
    * Radial distortion, Blender's polynomial model: a normalised point
    * (x, y) = (X/Z, Y/Z) lands at f·d·(x, y) + centre, with
    * d = 1 + k1·r² + k2·r⁴. Negative k1 is barrel distortion.
    */
   readonly k1: number;
   readonly k2: number;
   /** RMS reprojection error over all inlier keys, pixels. */
   readonly rms: number;
   readonly keyframes: readonly [number, number];
   /** Solved frames only, in frame order. */
   readonly cameras: readonly SolvedCamera[];
   /** Triangulated tracks only. */
   readonly points: readonly SolvedPoint[];
   /** Keys rejected as outliers, as `[track id, frame]`. */
   readonly outliers: readonly (readonly [number, number])[];
}

export type SolveResponse =
   Solution | { readonly status: "failed"; readonly message: string };

/** Runs a solve. Rejects with an AbortError if `signal` aborts first. */
export type SolveCamera = (
   request: SolveRequest,
   signal?: AbortSignal,
) => Promise<SolveResponse>;
