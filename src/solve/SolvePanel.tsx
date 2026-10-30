import React from "react";
import type { TrackState } from "../tracking/tracks";
import { CameraPath } from "./CameraPath";
import { focalMillimetres, solveRequest } from "./request";
import type { SolveCamera, SolveResponse } from "./solve-types";

export interface SolvePanelProps {
   tracks: TrackState;
   width: number;
   height: number;
   frameCount: number;
   /** The frame on screen. */
   frame: number;
   onSeek: (frame: number) => void;
   solveCamera: SolveCamera;
}

type Run =
   | { status: "idle" }
   | { status: "running"; controller: AbortController }
   | {
        status: "done";
        response: SolveResponse;
        /** The tracks it solved, to tell when they've changed since. */
        tracks: TrackState["tracks"];
        trackCount: number;
     };

const DEFAULT_FOCAL_MM = 35;

/**
 * Solves the camera from the clip's tracks and shows how it went: the
 * reprojection error, the focal length, how much of the clip and the
 * tracks it used, and the camera path from above (click a camera to go to
 * its frame).
 */
export function SolvePanel({
   tracks,
   width,
   height,
   frameCount,
   frame,
   onSeek,
   solveCamera,
}: SolvePanelProps) {
   const [focalMm, setFocalMm] = React.useState(DEFAULT_FOCAL_MM);
   const [refineFocal, setRefineFocal] = React.useState(true);
   const [run, setRun] = React.useState<Run>({ status: "idle" });
   // The running solve, cancelled if the panel goes away.
   const controllerRef = React.useRef<AbortController | null>(null);
   React.useEffect(() => () => controllerRef.current?.abort(), []);

   const focalValid = Number.isFinite(focalMm) && focalMm > 0;

   function solve() {
      const controller = new AbortController();
      controllerRef.current = controller;
      const request = solveRequest(
         tracks,
         { width, height, frameCount },
         { focalMm, refineFocal },
      );
      const solvedTracks = tracks.tracks;
      setRun({ status: "running", controller });
      solveCamera(request, controller.signal)
         .finally(() => {
            if (controllerRef.current === controller) {
               controllerRef.current = null;
            }
         })
         .then(
            (response) =>
               setRun({
                  status: "done",
                  response,
                  tracks: solvedTracks,
                  trackCount: request.tracks.length,
               }),
            (err: unknown) => {
               if (controller.signal.aborted) {
                  setRun({ status: "idle" });
                  return;
               }
               setRun({
                  status: "done",
                  response: {
                     status: "failed",
                     message: err instanceof Error ? err.message : String(err),
                  },
                  tracks: solvedTracks,
                  trackCount: request.tracks.length,
               });
            },
         );
   }

   const running = run.status === "running";
   return (
      <section className="solve-panel" aria-label="Camera solve">
         <div className="solve-controls">
            <label>
               Focal length{" "}
               <input
                  type="number"
                  min={1}
                  step={0.1}
                  value={Number.isNaN(focalMm) ? "" : focalMm}
                  onChange={(e) => setFocalMm(e.currentTarget.valueAsNumber)}
                  disabled={running}
                  aria-label="Focal length guess (mm, full-frame equivalent)"
               />{" "}
               mm
            </label>
            <label>
               <input
                  type="checkbox"
                  checked={refineFocal}
                  onChange={(e) => setRefineFocal(e.currentTarget.checked)}
                  disabled={running}
               />{" "}
               Refine focal length
            </label>
            {running ? (
               <button type="button" onClick={() => run.controller.abort()}>
                  Cancel solve
               </button>
            ) : (
               <button
                  type="button"
                  onClick={solve}
                  disabled={!focalValid}
                  title={focalValid ? undefined : "Enter a focal length guess."}
               >
                  Solve camera
               </button>
            )}
         </div>
         {running && (
            <p className="solve-status" role="status">
               Solving…
            </p>
         )}
         {run.status === "done" && (
            <SolveResult
               run={run}
               stale={run.tracks !== tracks.tracks}
               width={width}
               height={height}
               frameCount={frameCount}
               frame={frame}
               onSeek={onSeek}
            />
         )}
      </section>
   );
}

function SolveResult({
   run,
   stale,
   width,
   height,
   frameCount,
   frame,
   onSeek,
}: {
   run: Extract<Run, { status: "done" }>;
   stale: boolean;
   width: number;
   height: number;
   frameCount: number;
   frame: number;
   onSeek: (frame: number) => void;
}) {
   const { response } = run;
   if (response.status === "failed") {
      return (
         <p className="error" role="alert">
            Solve failed: {response.message}
         </p>
      );
   }
   const mm = focalMillimetres(response.focal, width, height);
   const outliers = response.outliers.length;
   return (
      <>
         <p className="solve-summary" role="status">
            Solved {response.cameras.length} of {frameCount} frames · error{" "}
            {response.rms.toFixed(2)} px · focal {mm.toFixed(1)} mm (
            {Math.round(response.focal)} px) · {response.points.length} of{" "}
            {run.trackCount} tracks
            {outliers > 0 &&
               ` · ${outliers} outlier ${outliers === 1 ? "key" : "keys"}`}
         </p>
         {stale && (
            <p className="solve-stale">
               The tracks have changed since this solve.
            </p>
         )}
         <CameraPath solution={response} frame={frame} onSeek={onSeek} />
      </>
   );
}
