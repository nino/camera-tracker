import type { AutoTrackResult } from "./autotrack";

export interface TrackingStatus {
   name: string;
   direction: 1 | -1;
   frames: number;
   result?: AutoTrackResult;
}

const STOP_TEXT: Record<AutoTrackResult["stopped"], string> = {
   end: "reached the end of the clip",
   lost: "lost the feature",
   edge: "the feature moved too far in one frame",
   flat: "no texture to track here",
   cancelled: "cancelled",
};

/** Status line for a tracking run, e.g. "Tracked Track 1 forward 12 frames; lost the feature (score 0.62)." */
export function trackingStatusText(status: TrackingStatus): string {
   const way = status.direction === 1 ? "forward" : "backward";
   const frames = `${status.frames} frame${status.frames === 1 ? "" : "s"}`;
   if (status.result == null) {
      return `Tracking ${status.name} ${way}: ${frames} (Escape to stop)`;
   }
   const score =
      status.result.score == null
         ? ""
         : ` (score ${status.result.score.toFixed(2)})`;
   return `Tracked ${status.name} ${way} ${frames}; ${STOP_TEXT[status.result.stopped]}${score}.`;
}
