import type { VideoSample } from "mediabunny";
import { FakeFrameSource } from "../test/fake-frame-source";
import { blobScene, renderLuma } from "../test/synthetic-scene";
import { autoTrack, defaultAutoTrackOptions } from "./autotrack";
import type { Point } from "./tracks";

const options = { ...defaultAutoTrackOptions, searchRadius: 6 };
const start = { x: 50.5, y: 42.5 };

/** Feature motion per frame: drifts right and down by sub-pixel amounts. */
const motion = (frame: number) => ({ x: frame * 1.3, y: frame * -0.7 });

function setup(
   scene = (frame: number) => blobScene(motion(frame).x, motion(frame).y),
) {
   const source = new FakeFrameSource({
      frameCount: 10,
      width: 100,
      height: 80,
   });
   // FakeFrameSource samples carry their index as `timestamp`.
   const readLuma = vi.fn((sample: VideoSample) => scene(sample.timestamp));
   const steps: [number, Point, number][] = [];
   const onStep = (frame: number, point: Point, score: number) =>
      steps.push([frame, point, score]);
   return { source, readLuma, steps, onStep };
}

describe("autoTrack", () => {
   it("follows a moving feature to the end of the clip", async () => {
      const { source, readLuma, steps, onStep } = setup();
      const result = await autoTrack({
         source,
         readLuma,
         from: 2,
         point: { x: start.x + motion(2).x, y: start.y + motion(2).y },
         direction: 1,
         onStep,
         options,
      });

      expect(result).toEqual({ stopped: "end", frames: 7 });
      expect(steps.map(([frame]) => frame)).toEqual([3, 4, 5, 6, 7, 8, 9]);
      for (const [frame, point, score] of steps) {
         expect(Math.abs(point.x - (start.x + motion(frame).x))).toBeLessThan(
            0.05,
         );
         expect(Math.abs(point.y - (start.y + motion(frame).y))).toBeLessThan(
            0.05,
         );
         expect(score).toBeGreaterThan(0.99);
      }
   });

   it("tracks backwards", async () => {
      const { source, readLuma, steps, onStep } = setup();
      const result = await autoTrack({
         source,
         readLuma,
         from: 3,
         point: { x: start.x + motion(3).x, y: start.y + motion(3).y },
         direction: -1,
         onStep,
         options,
      });
      expect(result).toEqual({ stopped: "end", frames: 3 });
      expect(steps.map(([frame]) => frame)).toEqual([2, 1, 0]);
   });

   it("stops when the feature disappears", async () => {
      const { source, readLuma, steps, onStep } = setup((frame) =>
         frame < 4
            ? blobScene(0, 0)
            : renderLuma(
                 100,
                 80,
                 (x, y) => Math.sin(x * 1.7) * Math.cos(y * 2.3),
              ),
      );
      const result = await autoTrack({
         source,
         readLuma,
         from: 0,
         point: start,
         direction: 1,
         onStep,
         options,
      });
      expect(result.stopped).toBe("lost");
      expect(result.frames).toBe(3);
      expect(steps.map(([frame]) => frame)).toEqual([1, 2, 3]);
   });

   it("stops when the feature jumps past the search radius", async () => {
      const { source, readLuma, onStep } = setup((frame) =>
         blobScene(frame < 2 ? 0 : 15, 0),
      );
      const result = await autoTrack({
         source,
         readLuma,
         from: 0,
         point: start,
         direction: 1,
         onStep,
         options,
      });
      expect(result).toMatchObject({ stopped: "edge", frames: 1 });
   });

   it("refuses a pattern with no texture", async () => {
      const { source, onStep } = setup();
      const flat = () => renderLuma(100, 80, () => 0.5);
      const result = await autoTrack({
         source,
         readLuma: flat,
         from: 0,
         point: start,
         direction: 1,
         onStep,
         options,
      });
      expect(result).toEqual({ stopped: "flat", frames: 0 });
   });

   it("stops when cancelled", async () => {
      const { source, readLuma, steps } = setup();
      const controller = new AbortController();
      const result = await autoTrack({
         source,
         readLuma,
         from: 0,
         point: start,
         direction: 1,
         onStep: (frame) => {
            steps.push([frame, start, 1]);
            if (frame === 2) {
               controller.abort();
            }
         },
         signal: controller.signal,
         options,
      });
      expect(result).toEqual({ stopped: "cancelled", frames: 2 });
   });
});
