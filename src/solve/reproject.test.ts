import { project, reprojections, worstTracks } from "./reproject";
import type { Solution, SolvedCamera } from "./solve-types";

const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const atOrigin: SolvedCamera = {
   frame: 3,
   rotation: identity,
   translation: [0, 0, 0],
   centre: [0, 0, 0],
};

const solution: Solution = {
   status: "solved",
   focal: 100,
   rms: 0,
   keyframes: [3, 4],
   cameras: [atOrigin],
   points: [
      { id: 1, position: [1, -2, 10], error: 0.5 },
      { id: 2, position: [0, 0, -5], error: 3 },
      { id: 3, position: [0, 0, 5], error: 1 },
   ],
   outliers: [],
};

describe("reprojection", () => {
   it("projects through a pinhole centred on the frame", () => {
      expect(project(atOrigin, 100, 640, 360, [1, -2, 10])).toEqual({
         x: 330,
         y: 160,
      });
   });

   it("uses the camera's pose", () => {
      // Moved 1 unit right: the point appears 1 unit further left.
      const moved = { ...atOrigin, translation: [-1, 0, 0] as const };
      expect(project(moved, 100, 640, 360, [1, 0, 10])).toEqual({
         x: 320,
         y: 180,
      });
   });

   it("skips points behind the camera and unsolved frames", () => {
      expect(reprojections(solution, 3, 640, 360).map((r) => r.id)).toEqual([
         1, 3,
      ]);
      expect(reprojections(solution, 0, 640, 360)).toEqual([]);
   });

   it("ranks tracks by error", () => {
      expect(worstTracks(solution, 2).map((p) => p.id)).toEqual([2, 3]);
   });
});
