import type { VideoSample } from "mediabunny";
import { CachedFrameSource, type SampleDecoder } from "./cached-frame-source";
import type { VideoMetadata } from "./frame-source";

interface FakeSample {
   timestamp: number;
   closed: boolean;
   close(): void;
}

/** A decoder whose decodes resolve only when the test says so. */
class ManualDecoder implements SampleDecoder {
   readonly decoded: FakeSample[] = [];
   private readonly waiting: Array<() => void> = [];
   auto = true;

   getSample = vi.fn((timestamp: number) => {
      const sample: FakeSample = {
         timestamp,
         closed: false,
         close() {
            if (this.closed) {
               throw new Error(`sample ${timestamp} closed twice`);
            }
            this.closed = true;
         },
      };
      this.decoded.push(sample);
      const result = sample as unknown as VideoSample;
      if (this.auto) {
         return Promise.resolve(result);
      }
      return new Promise<VideoSample>((resolve) =>
         this.waiting.push(() => resolve(result)),
      );
   });

   /** Resolve every pending decode. */
   async flush() {
      this.waiting.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
   }
}

// Deliberately not index / 10: timestamps come from the table, never frameRate.
const TIMESTAMPS = [0, 0.1, 0.25, 0.3, 0.45, 0.5, 0.62, 0.7, 0.8, 0.9];
const METADATA: VideoMetadata = {
   frameCount: TIMESTAMPS.length,
   width: 4,
   height: 4,
   frameRate: 10,
   duration: 1,
};

function setup(cacheFrames = 3) {
   const decoder = new ManualDecoder();
   const source = new CachedFrameSource(METADATA, TIMESTAMPS, decoder, {
      cacheFrames,
   });
   return { decoder, source };
}

describe("CachedFrameSource", () => {
   it("decodes through the timestamp table", async () => {
      const { decoder, source } = setup();
      const sample = await source.getFrame(2);
      expect(decoder.getSample).toHaveBeenCalledWith(0.25);
      expect(sample.timestamp).toBe(0.25);
   });

   it("rejects out-of-range and non-integer indices", async () => {
      const { source } = setup();
      await expect(source.getFrame(-1)).rejects.toThrow(/out of range/);
      await expect(source.getFrame(10)).rejects.toThrow(/out of range/);
      await expect(source.getFrame(1.5)).rejects.toThrow(/out of range/);
      await expect(source.getFrames([0, 99])).rejects.toThrow(/out of range/);
   });

   it("serves repeat requests from the cache", async () => {
      const { decoder, source } = setup();
      const first = await source.getFrame(1);
      const second = await source.getFrame(1);
      expect(second).toBe(first);
      expect(decoder.getSample).toHaveBeenCalledTimes(1);
   });

   it("evicts the least recently used frame and closes it", async () => {
      const { decoder, source } = setup(2);
      await source.getFrame(0);
      await source.getFrame(1);
      await source.getFrame(0); // touch 0
      await source.getFrame(2); // evicts 1

      const [s0, s1, s2] = decoder.decoded;
      expect(s1.closed).toBe(true);
      expect(s0.closed || s2.closed).toBe(false);
      await source.getFrame(1);
      expect(decoder.getSample).toHaveBeenCalledTimes(4);
   });

   it("shares one decode between concurrent requests for the same frame", async () => {
      const { decoder, source } = setup();
      decoder.auto = false;
      const a = source.getFrame(3);
      const b = source.getFrame(3);
      await decoder.flush();
      expect(await a).toBe(await b);
      expect(decoder.getSample).toHaveBeenCalledTimes(1);
   });

   it("keeps every frame of a batch valid even when the batch exceeds the cache", async () => {
      const { decoder, source } = setup(2);
      const frames = await source.getFrames([0, 1, 2, 3, 4]);
      expect(frames.map((frame) => frame.timestamp)).toEqual(
         TIMESTAMPS.slice(0, 5),
      );
      expect(decoder.decoded.some((sample) => sample.closed)).toBe(false);

      // The next decode trims back to capacity.
      await source.getFrame(9);
      expect(decoder.decoded.filter((sample) => !sample.closed)).toHaveLength(
         2,
      );
   });

   it("closes everything on dispose and refuses further requests", async () => {
      const { decoder, source } = setup();
      await source.getFrames([0, 1]);
      source.dispose();
      source.dispose(); // idempotent
      expect(decoder.decoded.every((sample) => sample.closed)).toBe(true);
      await expect(source.getFrame(0)).rejects.toThrow(/disposed/);
   });

   it("closes a frame that finishes decoding after dispose", async () => {
      const { decoder, source } = setup();
      decoder.auto = false;
      const pending = source.getFrame(0);
      source.dispose();
      await decoder.flush();
      await expect(pending).rejects.toThrow(/disposed/);
      expect(decoder.decoded[0].closed).toBe(true);
   });

   it("reports a decoder that returns no frame", async () => {
      const { decoder, source } = setup();
      decoder.getSample.mockResolvedValueOnce(null as unknown as VideoSample);
      await expect(source.getFrame(0)).rejects.toThrow(/no frame/);
   });
});
