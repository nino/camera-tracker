import { forward, nearestCamera, planBounds, toPlan } from "./camera-path";
import type { Solution, SolvedCamera } from "./solve-types";

const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function camera(frame: number, x: number, z: number): SolvedCamera {
   return {
      frame,
      rotation: identity,
      translation: [-x, 0, -z],
      centre: [x, 0, z],
   };
}

function solution(
   cameras: SolvedCamera[],
   points: [number, number, number][],
): Solution {
   return {
      status: "solved",
      focal: 500,
      k1: 0,
      k2: 0,
      rms: 0.1,
      keyframes: [0, 1],
      cameras,
      points: points.map((position, id) => ({ id, position, error: 0 })),
      outliers: [],
   };
}

describe("camera path plan", () => {
   it("puts x to the right and forward (z) up the page", () => {
      expect(toPlan([2, 7, 3])).toEqual({ x: 2, y: -3 });
   });

   it("takes the viewing direction from the rotation's third row", () => {
      // Turned 90° to the right about y: looks along world +x.
      const turned = {
         ...camera(0, 0, 0),
         rotation: [0, 0, -1, 0, 1, 0, 1, 0, 0],
      };
      expect(forward(turned)).toEqual([1, 0, 0]);
   });

   it("frames the cameras and points in a square", () => {
      const points: [number, number, number][] = [];
      for (let i = 0; i <= 20; i++) {
         points.push([i - 10, 0, 10]);
      }
      const b = planBounds(
         solution([camera(0, 0, 0), camera(1, 1, 0)], points),
      );
      expect(b.width).toBe(b.height);
      expect(b.x).toBeLessThan(-8);
      expect(b.x + b.width).toBeGreaterThan(8);
      expect(b.y).toBeLessThan(-10);
      expect(b.y + b.height).toBeGreaterThan(0);
   });

   it("ignores a few far-off points", () => {
      const points: [number, number, number][] = [];
      for (let i = 0; i < 40; i++) {
         points.push([0, 0, 5 + (i % 3)]);
      }
      points.push([0, 0, 1e6]);
      const b = planBounds(solution([camera(0, 0, 0)], points));
      expect(b.width).toBeLessThan(20);
   });

   it("finds the camera nearest a point in plan", () => {
      const s = solution(
         [camera(0, 0, 0), camera(1, 1, 0), camera(2, 2, 0)],
         [],
      );
      expect(nearestCamera(s, { x: 1.4, y: 0.2 })?.frame).toBe(1);
      expect(nearestCamera(solution([], []), { x: 0, y: 0 })).toBeUndefined();
   });
});
