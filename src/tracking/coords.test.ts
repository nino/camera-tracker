import { clientToDisplay } from "./coords";

describe("clientToDisplay", () => {
   it("maps an on-screen point into frame display pixels", () => {
      // A 1920×1080 frame shown at half size, offset by (100, 50).
      const rect = { left: 100, top: 50, width: 960, height: 540 };
      expect(clientToDisplay(100, 50, rect, 1920, 1080)).toEqual({
         x: 0,
         y: 0,
      });
      expect(clientToDisplay(580, 320, rect, 1920, 1080)).toEqual({
         x: 960,
         y: 540,
      });
      expect(clientToDisplay(100.25, 50, rect, 1920, 1080).x).toBeCloseTo(0.5);
   });
});
