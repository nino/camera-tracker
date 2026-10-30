import type { VideoSample } from "mediabunny";
import { FrameCache } from "./frame-cache";
import type { FrameSource, VideoMetadata } from "./frame-source";

/**
 * The part of mediabunny's `VideoSampleSink` we use. Kept as an interface so
 * the caching logic can be tested without WebCodecs.
 */
export interface SampleDecoder {
   getSample(timestamp: number): Promise<VideoSample | null>;
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
      const sample = await this.decoder.getSample(this.timestamps[index]);
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
