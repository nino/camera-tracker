import { initialTrackState, tracksReducer } from "../tracking/tracks";
import { focalMillimetres, focalPixels, solveRequest } from "./request";

describe("focal length conversion", () => {
   it("counts the longer side as 36 mm", () => {
      expect(focalPixels(36, 1920, 1080)).toBe(1920);
      expect(focalPixels(18, 1080, 1920)).toBe(960);
      expect(focalMillimetres(960, 1920, 1080)).toBe(18);
   });

   it("round-trips", () => {
      expect(focalMillimetres(focalPixels(28, 640, 360), 640, 360)).toBeCloseTo(
         28,
      );
   });
});

describe("solveRequest", () => {
   it("sends each track's keys in frame order, in display pixels", () => {
      let state = tracksReducer(initialTrackState, {
         type: "add",
         frame: 4,
         point: { x: 10, y: 20 },
      });
      const id = state.tracks[0].id;
      state = tracksReducer(state, {
         type: "move",
         id,
         frame: 1,
         point: { x: 11.5, y: 19.25 },
      });
      const request = solveRequest(
         state,
         { width: 640, height: 360, frameCount: 10 },
         { focalMm: 36, refineFocal: false },
      );
      expect(request).toEqual({
         width: 640,
         height: 360,
         frameCount: 10,
         focal: 640,
         refineFocal: false,
         tracks: [
            {
               id,
               keys: [
                  [1, 11.5, 19.25],
                  [4, 10, 20],
               ],
            },
         ],
      });
   });
});
