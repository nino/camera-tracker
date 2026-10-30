import { clampFrame } from "./frame-index";

describe("clampFrame", () => {
   it("keeps indices inside 0..frameCount-1", () => {
      expect(clampFrame(-5, 10)).toBe(0);
      expect(clampFrame(4, 10)).toBe(4);
      expect(clampFrame(10, 10)).toBe(9);
   });
});
