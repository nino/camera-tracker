import type { VideoSample } from "mediabunny";
import type { FrameSource } from "../video/frame-source";
import {
   defaultMatchOptions,
   extractPatch,
   matchFromScores,
   normalise,
   scoreMap,
   type LumaImage,
   type MatchOptions,
   type ScoreMapFn,
} from "./match";
import type { Point } from "./tracks";

export interface AutoTrackOptions extends MatchOptions {
   /** Stop when the best match scores below this NCC. */
   minScore: number;
}

export const defaultAutoTrackOptions: AutoTrackOptions = {
   ...defaultMatchOptions,
   minScore: 0.8,
};

export type StopReason =
   /** Reached the first or last frame. */
   | "end"
   /** Best match scored below `minScore`. */
   | "lost"
   /** Feature moved further than the search radius. */
   | "edge"
   /** The starting pattern has no texture to match. */
   | "flat"
   | "cancelled";

export interface AutoTrackResult {
   readonly stopped: StopReason;
   /** Frames successfully tracked (and reported through onStep). */
   readonly frames: number;
   /** Score of the match that stopped tracking, for "lost" and "edge". */
   readonly score?: number;
}

export interface AutoTrackParams {
   source: FrameSource;
   /** Reads a sample's luma, synchronously (the sample is borrowed). */
   readLuma: (sample: VideoSample) => LumaImage;
   /** Frame to start from; the pattern is taken here. */
   from: number;
   /** Position on `from`. */
   point: Point;
   direction: 1 | -1;
   onStep: (frame: number, point: Point, score: number) => void;
   signal?: AbortSignal;
   options?: AutoTrackOptions;
   /** Computes the score map; defaults to the CPU reference. */
   scorer?: ScoreMapFn;
}

/**
 * Follows a feature frame by frame from `from` until it is lost, leaves the
 * search window, reaches the end of the clip, or `signal` aborts.
 *
 * The pattern is taken once, on the starting frame (Blender's "keyframe"
 * matching), and searched for around the previous frame's result. That avoids
 * the slow drift you get from re-sampling the pattern every frame; when the
 * feature's appearance changes too much, tracking stops and the user re-keys.
 */
export async function autoTrack({
   source,
   readLuma,
   from,
   point,
   direction,
   onStep,
   signal,
   options = defaultAutoTrackOptions,
   scorer = scoreMap,
}: AutoTrackParams): Promise<AutoTrackResult> {
   const pattern = normalise(
      extractPatch(
         readLuma(await source.getFrame(from)),
         point.x,
         point.y,
         options.patternSize,
      ),
   );
   if (pattern == null) {
      return { stopped: "flat", frames: 0 };
   }

   let frames = 0;
   let previous = point;
   for (
      let frame = from + direction;
      frame >= 0 && frame < source.metadata.frameCount;
      frame += direction
   ) {
      // Let the UI paint the last step (and see a cancel) before the next one.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) {
         return { stopped: "cancelled", frames };
      }
      const image = readLuma(await source.getFrame(frame));
      if (signal?.aborted) {
         return { stopped: "cancelled", frames };
      }
      const scores = await scorer(
         pattern,
         options.patternSize,
         image,
         previous.x,
         previous.y,
         options.searchRadius,
      );
      if (signal?.aborted) {
         return { stopped: "cancelled", frames };
      }
      const match = matchFromScores(pattern, image, previous, options, scores);
      if (match.atEdge) {
         return { stopped: "edge", frames, score: match.score };
      }
      if (match.score < options.minScore) {
         return { stopped: "lost", frames, score: match.score };
      }
      onStep(frame, match.point, match.score);
      frames++;
      previous = match.point;
   }
   return { stopped: "end", frames };
}
