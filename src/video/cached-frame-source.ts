import type { VideoSample } from "mediabunny";
import { FrameCache } from "./frame-cache";
import type { FrameSource, VideoMetadata } from "./frame-source";

/**
 * The part of mediabunny's `VideoSampleSink` we use. Kept as an interface so
 * the caching logic can be tested without WebCodecs.
 */
export interface SampleDecoder {
   getSample(timestamp: number): Promise<VideoSample | null>;
   /**
    * One sample per timestamp, in order. Given sorted timestamps, mediabunny
    * decodes each packet at most once, instead of re-walking the GOP from the
    * previous keyframe for every frame as separate `getSample` calls would.
    */
   samplesAtTimestamps(
      timestamps: Iterable<number>,
   ): AsyncIterable<VideoSample | null>;
}

/**
 * Default cache size, in frames. Big enough for scrubbing back and forth plus
 * an onion-skin stack; at 1080p that is roughly 48 × 3 MB ≈ 150 MB of frames.
 */
export const DEFAULT_CACHE_FRAMES = 48;

export interface CachedFrameSourceOptions {
   cacheFrames?: number;
}

/**
 * A FrameSource over any SampleDecoder, with a bounded LRU cache.
 *
 * - Frames are fetched by integer index through `timestamps` (the
 *   authoritative, VFR-safe seek table), never `index / frameRate`.
 * - The cache owns every sample it hands out and closes it on eviction or
 *   dispose (see the ownership notes in frame-source.ts).
 * - Concurrent requests for the same frame share one decode, so a frame is
 *   never decoded twice and the losing copy leaked.
 * - `getFrames` pins its frames while it runs, so a batch larger than the
 *   cache can't evict its own earlier frames before it returns.
 * - `getFrames` decodes all its cache misses in one sorted
 *   `samplesAtTimestamps` pass, so frames that share a GOP share the decode.
 */
export class CachedFrameSource implements FrameSource {
   private readonly cache: FrameCache<VideoSample>;
   private readonly inFlight = new Map<number, Promise<VideoSample>>();
   private disposed = false;

   constructor(
      readonly metadata: VideoMetadata,
      /** index -> presentation timestamp (seconds). */
      private readonly timestamps: readonly number[],
      private readonly decoder: SampleDecoder,
      options: CachedFrameSourceOptions = {},
   ) {
      this.cache = new FrameCache(options.cacheFrames ?? DEFAULT_CACHE_FRAMES);
   }

   async getFrame(index: number): Promise<VideoSample> {
      this.checkIndex(index);

      const cached = this.cache.get(index);
      if (cached !== undefined) {
         return cached;
      }

      let pending = this.inFlight.get(index);
      if (pending === undefined) {
         pending = this.decode(index).finally(() =>
            this.inFlight.delete(index),
         );
         this.inFlight.set(index, pending);
      }
      return pending;
   }

   async getFrames(indices: readonly number[]): Promise<VideoSample[]> {
      indices.forEach((index) => this.checkIndex(index));
      indices.forEach((index) => this.cache.pin(index));
      try {
         const misses = indices.filter(
            (index) => !this.cache.has(index) && !this.inFlight.has(index),
         );
         if (misses.length > 1) {
            this.decodeBatch(misses);
         }
         return await Promise.all(indices.map((index) => this.getFrame(index)));
      } finally {
         // Unpinning doesn't evict; the next insert does. So the returned
         // samples stay valid for the caller's synchronous use.
         indices.forEach((index) => this.cache.unpin(index));
      }
   }

   dispose(): void {
      if (this.disposed) {
         return;
      }
      this.disposed = true;
      this.cache.clear();
   }

   private async decode(index: number): Promise<VideoSample> {
      return this.store(
         index,
         await this.decoder.getSample(this.timestamps[index]),
      );
   }

   /**
    * Starts one sorted decode pass for `indices` and registers a per-frame
    * in-flight promise for each, so `getFrame` picks them up (and so later
    * requests for the same frames join this pass instead of decoding again).
    */
   private decodeBatch(indices: readonly number[]): void {
      // The timestamp table is sorted, so sorting indices sorts timestamps.
      const sorted = [...new Set(indices)].sort((a, b) => a - b);
      const settle = new Map<
         number,
         {
            resolve: (sample: VideoSample) => void;
            reject: (err: unknown) => void;
         }
      >();
      for (const index of sorted) {
         const pending = new Promise<VideoSample>((resolve, reject) =>
            settle.set(index, { resolve, reject }),
         ).finally(() => this.inFlight.delete(index));
         // If the caller's Promise.all already rejected on an earlier frame,
         // nobody awaits the rest; don't report those as unhandled.
         pending.catch(() => {});
         this.inFlight.set(index, pending);
      }

      void (async () => {
         let next = 0;
         try {
            const samples = this.decoder.samplesAtTimestamps(
               sorted.map((index) => this.timestamps[index]),
            );
            for await (const sample of samples) {
               const index = sorted[next++];
               try {
                  settle.get(index)!.resolve(this.store(index, sample));
               } catch (err) {
                  settle.get(index)!.reject(err);
               }
               if (next === sorted.length) {
                  break;
               }
            }
            if (next < sorted.length) {
               throw new Error("Decoder returned fewer frames than requested.");
            }
         } catch (err) {
            for (; next < sorted.length; next++) {
               settle.get(sorted[next])!.reject(err);
            }
         }
      })();
   }

   /** Validates a freshly decoded sample and hands ownership to the cache. */
   private store(index: number, sample: VideoSample | null): VideoSample {
      if (sample == null) {
         throw new Error(`Decoder returned no frame for index ${index}.`);
      }
      if (this.disposed) {
         sample.close();
         throw new Error("FrameSource has been disposed.");
      }
      this.cache.set(index, sample);
      return sample;
   }

   private checkIndex(index: number): void {
      if (this.disposed) {
         throw new Error("FrameSource has been disposed.");
      }
      if (
         !Number.isInteger(index) ||
         index < 0 ||
         index >= this.metadata.frameCount
      ) {
         throw new Error(
            `Frame ${index} out of range (0..${this.metadata.frameCount - 1}).`,
         );
      }
   }
}
