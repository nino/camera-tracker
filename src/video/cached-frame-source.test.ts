import type { VideoSample } from "mediabunny";
import { CachedFrameSource, type SampleDecoder } from "./cached-frame-source";
import type { VideoMetadata } from "./frame-source";

interface FakeSample {
   timestamp: number;
   closed: boolean;
   close(): void;
}

/** A fake decoder. With `auto = false`, decodes wait for `flush()`. */
class ManualDecoder implements SampleDecoder {
   readonly decoded: FakeSample[] = [];
   /** Timestamps passed to each samplesAtTimestamps call. */
   readonly batches: number[][] = [];
   /** Timestamps for which the decoder yields null. */
   readonly missing = new Set<number>();
   private readonly waiting: Array<() => void> = [];
   auto = true;

   getSample = vi.fn((timestamp: number) => this.decode(timestamp));

   async *samplesAtTimestamps(timestamps: Iterable<number>) {
      const list = [...timestamps];
      this.batches.push(list);
      for (const timestamp of list) {
         yield await this.decode(timestamp);
      }
   }

   /** Resolve every pending decode. */
   async flush() {
      this.waiting.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
   }

   private decode(timestamp: number): Promise<VideoSample | null> {
      if (this.missing.has(timestamp)) {
         return Promise.resolve(null);
      }
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
      return new Promise((resolve) => this.waiting.push(() => resolve(result)));
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
      decoder.missing.add(0);
      await expect(source.getFrame(0)).rejects.toThrow(/no frame/);
   });

   describe("getFrames batching", () => {
      it("decodes all misses in one sorted pass and returns frames in request order", async () => {
         const { decoder, source } = setup(10);
         await source.getFrame(4); // already cached; must not be decoded again
         decoder.getSample.mockClear();

         const frames = await source.getFrames([6, 2, 4, 2, 0]);

         expect(frames.map((frame) => frame.timestamp)).toEqual([
            0.62, 0.25, 0.45, 0.25, 0,
         ]);
         expect(decoder.batches).toEqual([[0, 0.25, 0.62]]);
         expect(decoder.getSample).not.toHaveBeenCalled();
      });

      it("lets a concurrent getFrame join the batch instead of decoding again", async () => {
         const { decoder, source } = setup(10);
         decoder.auto = false;
         const batch = source.getFrames([1, 3]);
         const single = source.getFrame(3);
         // Let the batch's generator start its first decode.
         await Promise.resolve();
         for (let i = 0; i < 4; i++) {
            await decoder.flush();
         }
         const [, three] = await batch;
         expect(await single).toBe(three);
         expect(decoder.getSample).not.toHaveBeenCalled();
         expect(decoder.decoded).toHaveLength(2);
      });

      it("fails only the frames the decoder couldn't produce", async () => {
         const { decoder, source } = setup(10);
         decoder.missing.add(0.25);
         await expect(source.getFrames([1, 2, 3])).rejects.toThrow(
            /no frame for index 2/,
         );
         // The other frames still made it into the cache.
         const frames = await source.getFrames([1, 3]);
         expect(frames.map((frame) => frame.timestamp)).toEqual([0.1, 0.3]);
         expect(decoder.batches).toHaveLength(1);
      });

      it("fails the rest of the batch if the decoder stops early", async () => {
         const { decoder, source } = setup(10);
         decoder.samplesAtTimestamps = async function* () {
            yield null;
         } as typeof decoder.samplesAtTimestamps;
         await expect(source.getFrames([5, 6])).rejects.toThrow(
            /no frame for index 5/,
         );
         await expect(source.getFrame(6)).resolves.toBeDefined();
      });

      it("closes frames that arrive after dispose", async () => {
         const { decoder, source } = setup(10);
         decoder.auto = false;
         const batch = source.getFrames([0, 1]);
         source.dispose();
         for (let i = 0; i < 4; i++) {
            await decoder.flush();
         }
         await expect(batch).rejects.toThrow(/disposed/);
         expect(decoder.decoded.every((sample) => sample.closed)).toBe(true);
      });
   });
});
