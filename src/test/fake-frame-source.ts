import type { VideoSample } from "mediabunny";
import type { FrameSource, VideoMetadata } from "../video/frame-source";

/**
 * A FrameSource for tests: no decoding, just fake samples that record draws.
 * jsdom has no WebCodecs, so anything that takes a FrameSource should be tested
 * with this instead of MediabunnyFrameSource.
 */
export class FakeFrameSource implements FrameSource {
   readonly metadata: VideoMetadata;
   readonly getFrame = vi.fn(async (index: number) => this.sample(index));
   readonly getFrames = vi.fn(async (indices: readonly number[]) =>
      indices.map((index) => this.sample(index)),
   );
   readonly dispose = vi.fn();
   /** Every `draw()` call on any sample, as `[frameIndex, ...drawArgs]`. */
   readonly draws: unknown[][] = [];

   constructor(metadata: Partial<VideoMetadata> = {}) {
      this.metadata = {
         frameCount: 100,
         width: 640,
         height: 360,
         frameRate: 24,
         duration: 100 / 24,
         ...metadata,
      };
   }

   private sample(index: number): VideoSample {
      if (index < 0 || index >= this.metadata.frameCount) {
         throw new Error(`Frame ${index} out of range.`);
      }
      return {
         draw: (...args: unknown[]) => this.draws.push([index, ...args]),
         close: () => {
            throw new Error("Callers must not close borrowed samples.");
         },
      } as unknown as VideoSample;
   }
}
