import type { VideoSample } from "mediabunny";

/**
 * The spine of the whole app. Every feature downstream — manual tracking,
 * onion-skinning, auto-tracking, the camera solver — talks to a FrameSource and
 * nothing lower. Get this right and each later milestone is "implement against
 * FrameSource", never "rearchitect the video layer".
 *
 * DESIGN NOTES
 *
 * 1. Frames are mediabunny `VideoSample`s, not raw WebCodecs `VideoFrame`s.
 *    A VideoSample is a near-zero-cost wrapper around a VideoFrame that also
 *    carries timestamp/rotation/colorspace/display-size, draws straight to a 2D
 *    canvas (`.draw`), and converts to a VideoFrame for WebGPU (`.toVideoFrame`).
 *    Its `.close()` lines up with our ownership model below.
 *
 * 2. OWNERSHIP — "the source owns, callers borrow":
 *      - DON'T call `.close()` on a sample you got from here. The source's cache
 *        owns each sample's lifetime and closes it on eviction / dispose.
 *      - DON'T retain a sample past your current synchronous use. Upload it to a
 *        GPU texture (or draw it) and forget it; re-fetch next frame. Holding one
 *        across `await`s risks the cache closing it underneath you.
 *      - For the WebGPU path you'll call `sample.toVideoFrame()`; THAT VideoFrame
 *        is yours and you must close it after uploading — the underlying sample
 *        stays in the cache.
 *
 * 3. SEEKING is by integer frame index, mapped through an authoritative per-frame
 *    timestamp table (see MediabunnyFrameSource). We deliberately do NOT seek via
 *    `index / frameRate`, because variable-frame-rate footage would land on the
 *    wrong frame — silent death for a frame-accurate tracking tool.
 */
export interface FrameSource {
   readonly metadata: VideoMetadata;

   /**
    * Frame `index` (0-based), decoded on demand and cached. Throws if `index` is
    * out of range. See ownership rules above: borrow the sample, don't close it.
    */
   getFrame(index: number): Promise<VideoSample>;

   /**
    * Several frames at once — the access pattern onion-skinning needs. Same
    * ownership rules. All returned samples are valid simultaneously.
    */
   getFrames(indices: readonly number[]): Promise<VideoSample[]>;

   /** Close every cached sample and release the decoder. */
   dispose(): void;
}

export interface VideoMetadata {
   /** Total number of frames (= number of video packets). */
   readonly frameCount: number;
   /** Display width in pixels (after pixel-aspect + rotation). */
   readonly width: number;
   /** Display height in pixels (after pixel-aspect + rotation). */
   readonly height: number;
   /**
    * Nominal frames per second. Metadata for the UI timecode and Blender export
    * only — NOT used for seeking (see design note 3).
    */
   readonly frameRate: number;
   /** Total duration in seconds. */
   readonly duration: number;
}
