import type { Solution, SolvedCamera } from "../solve/solve-types";
import {
   blenderCameraMatrix,
   blenderCameraScript,
   blenderCameraScriptName,
   toBlenderWorld,
} from "./blender-camera";

/** Applies a row-major 4×4 matrix to a point. */
function apply(m: number[], p: number[]): number[] {
   return [0, 1, 2].map(
      (r) =>
         m[4 * r] * p[0] +
         m[4 * r + 1] * p[1] +
         m[4 * r + 2] * p[2] +
         m[4 * r + 3],
   );
}

/** A camera at `centre` turned `yaw` radians to the right about solver-world y. */
function camera(
   frame: number,
   centre: [number, number, number],
   yaw = 0,
): SolvedCamera {
   const c = Math.cos(yaw);
   const s = Math.sin(yaw);
   // World-to-camera rotation: the inverse of turning right by yaw.
   const rotation = [c, 0, -s, 0, 1, 0, s, 0, c];
   const translation = [0, 1, 2].map(
      (i) =>
         -(
            rotation[3 * i] * centre[0] +
            rotation[3 * i + 1] * centre[1] +
            rotation[3 * i + 2] * centre[2]
         ),
   ) as [number, number, number];
   return { frame, rotation, translation, centre };
}

function closeTo(actual: readonly number[], expected: readonly number[]) {
   expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 9));
}

describe("Blender camera export", () => {
   it("maps the solver's y-down, z-forward world to Blender's z-up", () => {
      expect(toBlenderWorld([1, 2, 3])).toEqual([1, 3, -2]);
   });

   it("points a Blender camera (looking down local −z) the solved way", () => {
      const turned = camera(0, [1, -2, 3], Math.PI / 2);
      const m = blenderCameraMatrix(turned);
      // Location.
      closeTo([m[3], m[7], m[11]], toBlenderWorld([1, -2, 3]));
      // Looking down local −z: turned right from +y (forward) is +x in Blender.
      const ahead = apply(m, [0, 0, -1]);
      closeTo(ahead, [2, 3, 2]);
      // Local +y is up (Blender +z).
      closeTo(apply(m, [0, 1, 0]), [1, 3, 3]);
   });

   it("matches the solver's projection", () => {
      // A point projects through the solver camera and the Blender camera
      // to the same direction (Blender camera space: x right, y up, −z ahead).
      const cam = camera(0, [0.3, -0.1, 0.2], 0.4);
      const X: [number, number, number] = [1, 0.5, 6];
      const r = cam.rotation;
      const p = [0, 1, 2].map(
         (i) =>
            r[3 * i] * X[0] +
            r[3 * i + 1] * X[1] +
            r[3 * i + 2] * X[2] +
            cam.translation[i],
      );
      const m = blenderCameraMatrix(cam);
      // Invert the rigid matrix: q = Mᵣᵀ (Xb − t).
      const Xb = toBlenderWorld(X);
      const d = [0, 1, 2].map((i) => Xb[i] - m[4 * i + 3]);
      const q = [0, 1, 2].map(
         (j) => m[j] * d[0] + m[4 + j] * d[1] + m[8 + j] * d[2],
      );
      closeTo([q[0], -q[1], -q[2]], p);
   });

   it("writes a script with frames from 1, lens in mm and unit keyframe spacing", () => {
      const solution: Solution = {
         status: "solved",
         focal: 960,
         rms: 0.5,
         keyframes: [0, 2],
         cameras: [camera(0, [0, 0, 0]), camera(2, [4, 0, 0])],
         points: [{ id: 7, position: [0, 0, 8], error: 0.2 }],
         outliers: [],
      };
      const script = blenderCameraScript(
         solution,
         {
            clipName: "shot.mov",
            width: 1920,
            height: 1080,
            frameCount: 3,
            frameRate: 24,
         },
         new Map([[7, "Corner"]]),
      );
      const data = JSON.parse(/^DATA = (.*)$/m.exec(script)![1]) as {
         lens: number;
         cameras: [number, number[]][];
         points: [string, number[]][];
      };
      expect(data.lens).toBe(18);
      expect(data.cameras.map(([frame]) => frame)).toEqual([1, 3]);
      expect(data.cameras[1][1][3]).toBe(1);
      expect(data.points).toEqual([["Corner", [0, 2, 0]]]);
      expect(blenderCameraScriptName("shot.mov")).toBe("shot.camera.py");
   });
});
