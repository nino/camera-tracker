import {
   AFTER_TINT,
   BEFORE_TINT,
   defaultOnionSettings,
   MAX_ONION_FRAMES,
   NO_TINT,
   onionLayers,
   type OnionSettings,
} from "./onion";

const on: OnionSettings = { ...defaultOnionSettings, enabled: true };

describe("onionLayers", () => {
   it("is just the current frame when disabled", () => {
      expect(onionLayers(5, 10, defaultOnionSettings)).toEqual([
         { index: 5, opacity: 1, tint: NO_TINT },
      ]);
   });

   it("draws the current frame first, then neighbours furthest to nearest", () => {
      const layers = onionLayers(5, 10, {
         ...on,
         before: 2,
         after: 1,
         opacity: 0.5,
         falloff: 0.5,
      });
      expect(layers).toEqual([
         { index: 5, opacity: 1, tint: NO_TINT },
         { index: 3, opacity: 0.25, tint: BEFORE_TINT },
         { index: 4, opacity: 0.5, tint: BEFORE_TINT },
         { index: 6, opacity: 0.5, tint: AFTER_TINT },
      ]);
   });

   it("skips frames outside the clip", () => {
      const indices = (current: number) =>
         onionLayers(current, 3, { ...on, before: 2, after: 2 }).map(
            (layer) => layer.index,
         );
      expect(indices(0)).toEqual([0, 2, 1]);
      expect(indices(2)).toEqual([2, 0, 1]);
   });

   it("can turn tinting off", () => {
      const layers = onionLayers(5, 10, { ...on, tint: false });
      expect(layers.every((layer) => layer.tint === NO_TINT)).toBe(true);
   });

   it("clamps counts and opacities to sane ranges", () => {
      const layers = onionLayers(50, 100, {
         ...on,
         before: 99,
         after: -3,
         opacity: 4,
         falloff: 1,
      });
      expect(layers).toHaveLength(1 + MAX_ONION_FRAMES);
      expect(layers.every((layer) => layer.opacity === 1)).toBe(true);
   });
});
