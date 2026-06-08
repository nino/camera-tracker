import {
   ALL_FORMATS,
   BlobSource,
   EncodedPacketSink,
   Input,
   VideoSampleSink,
   type VideoSample,
} from "mediabunny";
import type { FrameSource, VideoMetadata } from "./frame-source";

/**
 * A FrameSource backed by mediabunny (demux + frame-accurate decode).
 *
 * Construct with the async factory `MediabunnyFrameSource.open(file)` — a
 * constructor can't `await`, and opening involves reading the container.
 *
 * The cache here is intentionally the NAIVE version so the pipeline runs
 * end-to-end today. The two seams marked `PAIR:` are where the interesting work
 * lives, and what we'll build together next:
 *   1. Windowed LRU eviction (close evicted samples; keep a contiguous window
 *      around the playhead warm for scrubbing + onion-skinning).
 *   2. Batched decode for getFrames via `sink.samplesAtTimestamps(...)`, which
 *      decodes each packet at most once instead of re-walking the GOP per frame.
 */
export class MediabunnyFrameSource implements FrameSource {
   readonly metadata: VideoMetadata;

   /** index -> presentation timestamp (seconds). Authoritative seek map; VFR-safe. */
   private readonly timestamps: readonly number[];
   private readonly sink: VideoSampleSink;
   private readonly cache = new Map<number, VideoSample>();
   private disposed = false;

   private constructor(
      metadata: VideoMetadata,
      timestamps: readonly number[],
      sink: VideoSampleSink,
   ) {
      this.metadata = metadata;
      this.timestamps = timestamps;
      this.sink = sink;
   }

   static async open(file: Blob): Promise<MediabunnyFrameSource> {
      const input = new Input({
         formats: ALL_FORMATS,
         source: new BlobSource(file),
      });
      const track = await input.getPrimaryVideoTrack();
      if (track == null) {
         throw new Error("This file has no video track.");
      }

      // Build the authoritative per-frame timestamp table. `metadataOnly` reads
      // packet timing without copying any encoded bytes, so this is a cheap scan.
      // packets() yields in decode order; sort to get presentation order.
      const packetSink = new EncodedPacketSink(track);
      const timestamps: number[] = [];
      for await (const packet of packetSink.packets(undefined, undefined, {
         metadataOnly: true,
      })) {
         timestamps.push(packet.timestamp);
      }
      timestamps.sort((a, b) => a - b);

      const stats = await track.computePacketStats();
      const metadata: VideoMetadata = {
         frameCount: timestamps.length,
         width: await track.getDisplayWidth(),
         height: await track.getDisplayHeight(),
         frameRate: stats.averagePacketRate,
         duration: await input.computeDuration(),
      };

      return new MediabunnyFrameSource(
         metadata,
         timestamps,
         new VideoSampleSink(track),
      );
   }

   async getFrame(index: number): Promise<VideoSample> {
      if (this.disposed) {
         throw new Error("FrameSource has been disposed.");
      }
      if (index < 0 || index >= this.metadata.frameCount) {
         throw new Error(
            `Frame ${index} out of range (0..${this.metadata.frameCount - 1}).`,
         );
      }

      const cached = this.cache.get(index);
      if (cached != null) {
         return cached;
      }

      const sample = await this.sink.getSample(this.timestamps[index]);
      if (sample == null) {
         throw new Error(`Decoder returned no frame for index ${index}.`);
      }

      // PAIR: naive cache — grows without bound. Next: windowed LRU eviction that
      // close()s evicted samples, plus pinning the frames of an in-flight
      // getFrames() call so a small window can't evict frame N before N+k decodes.
      this.cache.set(index, sample);
      return sample;
   }

   async getFrames(indices: readonly number[]): Promise<VideoSample[]> {
      // PAIR: baseline fans out to getFrame. Optimization: collect cache-misses,
      // sort their timestamps, and stream them through sink.samplesAtTimestamps()
      // so each packet is decoded at most once.
      return Promise.all(indices.map((index) => this.getFrame(index)));
   }

   dispose(): void {
      if (this.disposed) {
         return;
      }
      this.disposed = true;
      for (const sample of this.cache.values()) {
         sample.close();
      }
      this.cache.clear();
   }
}
