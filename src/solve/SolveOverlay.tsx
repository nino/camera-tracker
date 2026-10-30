import type { TrackState } from "../tracking/tracks";
import { reprojections } from "./reproject";
import type { Solution } from "./solve-types";

export interface SolveOverlayProps {
   solution: Solution;
   tracks: TrackState;
   width: number;
   height: number;
   frame: number;
}

/** Residuals above this (display px) are drawn as errors. */
export const BAD_RESIDUAL_PX = 2;

/**
 * Draws where the solve puts each track's 3D point on this frame (a small
 * circle) and, where the track is keyed on this frame, a line from the key
 * to it: the reprojection error you'd fix by fixing the track. It sits under
 * the track markers and ignores the pointer.
 */
export function SolveOverlay({
   solution,
   tracks,
   width,
   height,
   frame,
}: SolveOverlayProps) {
   const keys = new Map(
      tracks.tracks.flatMap((t) => {
         const key = t.keys.get(frame);
         return key == null ? [] : [[t.id, key] as const];
      }),
   );
   const r = Math.max(width, height) * 0.004;
   return (
      <svg
         className="solve-overlay"
         viewBox={`0 0 ${width} ${height}`}
         data-testid="solve-overlay"
         aria-hidden="true"
      >
         {reprojections(solution, frame, width, height).map(({ id, point }) => {
            const key = keys.get(id);
            const residual =
               key == null ? 0 : Math.hypot(key.x - point.x, key.y - point.y);
            const bad = residual > BAD_RESIDUAL_PX;
            return (
               <g
                  key={id}
                  className={bad ? "solved-mark bad" : "solved-mark"}
                  data-track={id}
               >
                  {key != null && (
                     <line
                        x1={key.x}
                        y1={key.y}
                        x2={point.x}
                        y2={point.y}
                        vectorEffect="non-scaling-stroke"
                     />
                  )}
                  <circle
                     cx={point.x}
                     cy={point.y}
                     r={r}
                     vectorEffect="non-scaling-stroke"
                  />
               </g>
            );
         })}
      </svg>
   );
}
