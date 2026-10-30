import {
   ALL_FORMATS,
   BlobSource,
   EncodedPacketSink,
   Input,
   VideoSampleSink,
} from "mediabunny";
import {
   CachedFrameSource,
   type CachedFrameSourceOptions,
} from "./cached-frame-source";
import type { VideoMetadata } from "./frame-source";

/**
 * A FrameSource backed by mediabunny (demux + frame-accurate decode). Caching
 * and ownership live in CachedFrameSource; this class only opens the file.
 *
 * Construct with the async factory `MediabunnyFrameSource.open(file)` — a
 * constructor can't `await`, and opening involves reading the container.
 */
export class MediabunnyFrameSource extends CachedFrameSource {
   static async open(
      file: Blob,
      options?: CachedFrameSourceOptions,
   ): Promise<MediabunnyFrameSource> {
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
         options,
      );
   }
}
