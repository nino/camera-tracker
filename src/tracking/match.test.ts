import {
   extractPatch,
   matchPattern,
   normalise,
   peakOf,
   sampleBilinear,
} from "./match";
import { blobScene, renderLuma } from "../test/synthetic-scene";

const render = renderLuma;
const scene = blobScene;

describe("sampleBilinear", () => {
   const img = render(2, 2, (x, y) => (x < 1 ? 0 : 10) + (y < 1 ? 0 : 100));

   it("returns pixel values at pixel centres", () => {
      expect(sampleBilinear(img, 0.5, 0.5)).toBe(0);
      expect(sampleBilinear(img, 1.5, 1.5)).toBe(110);
   });

   it("interpolates between centres and clamps outside", () => {
      expect(sampleBilinear(img, 1, 0.5)).toBe(5);
      expect(sampleBilinear(img, 1, 1)).toBe(55);
      expect(sampleBilinear(img, -5, -5)).toBe(0);
   });
});

describe("normalise", () => {
   it("returns null for a flat patch", () => {
      expect(normalise(new Float32Array([3, 3, 3, 3]))).toBeNull();
   });
});

describe("peakOf", () => {
   it("refines a symmetric peak to its centre and flags window edges", () => {
      // radius 1: 3×3 grid, peak in the middle.
      const flat = new Float32Array([0, 0, 0, 0.5, 1, 0.5, 0, 0, 0]);
      expect(peakOf(flat, 1)).toEqual({
         dx: 0,
         dy: 0,
         score: 1,
         atEdge: false,
      });
      const edge = new Float32Array([0, 0, 0, 0, 0.5, 1, 0, 0, 0]);
      expect(peakOf(edge, 1).atEdge).toBe(true);
   });
});

describe("matchPattern", () => {
   const options = { patternSize: 21, searchRadius: 8 };
   const start = { x: 50.5, y: 42.5 };
   const pattern = normalise(
      extractPatch(scene(0, 0), start.x, start.y, options.patternSize),
   )!;

   it("finds an unmoved feature exactly", () => {
      const result = matchPattern(pattern, scene(0, 0), start, options);
      expect(result.point.x).toBeCloseTo(start.x, 5);
      expect(result.point.y).toBeCloseTo(start.y, 5);
      expect(result.score).toBeCloseTo(1, 5);
   });

   it.each([
      [3, -2],
      [2.3, 1.7],
      [-4.6, 0.25],
   ])("follows a shift of (%f, %f) to within 0.05 px", (ox, oy) => {
      const result = matchPattern(pattern, scene(ox, oy), start, options);
      expect(Math.abs(result.point.x - (start.x + ox))).toBeLessThan(0.05);
      expect(Math.abs(result.point.y - (start.y + oy))).toBeLessThan(0.05);
      expect(result.score).toBeGreaterThan(0.95);
      expect(result.atEdge).toBe(false);
   });

   it("is unaffected by brightness and contrast changes", () => {
      const moved = scene(1, 1);
      const brighter = { ...moved, data: moved.data.map((v) => v * 2.5 + 40) };
      const result = matchPattern(pattern, brighter, start, options);
      expect(result.point.x).toBeCloseTo(start.x + 1, 1);
      expect(result.score).toBeGreaterThan(0.99);
   });

   it("reports a feature that moved past the search radius as at the edge", () => {
      const result = matchPattern(pattern, scene(14, 0), start, options);
      expect(result.atEdge).toBe(true);
   });
});
