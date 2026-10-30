import type { VideoSample } from "mediabunny";
import React from "react";
import {
   createCanvas2dRenderer,
   createRenderer as defaultCreateRenderer,
   type CreateRenderer,
   type FrameRenderer,
} from "../gpu/frame-renderer";
import { blenderScript, blenderScriptName } from "../export/blender";
import {
   blenderCameraScript,
   blenderCameraScriptName,
} from "../export/blender-camera";
import { downloadText } from "../export/download";
import { OnionControls } from "../onion/OnionControls";
import { defaultOnionSettings, onionLayers } from "../onion/onion";
import { TrackList } from "../tracking/TrackList";
import { TrackOverlay } from "../tracking/TrackOverlay";
import { autoTrack } from "../tracking/autotrack";
import { createLumaReader as defaultCreateLumaReader } from "../tracking/luma";
import type { LumaImage } from "../tracking/match";
import {
   createScorer as defaultCreateScorer,
   type Scorer,
} from "../gpu/score-map";
import {
   trackingStatusText,
   type TrackingStatus,
} from "../tracking/tracking-status";
import { loadTracks, saveTracks } from "../tracking/storage";
import {
   initialTrackState,
   positionAt,
   tracksReducer,
} from "../tracking/tracks";
import { SolveOverlay } from "../solve/SolveOverlay";
import { SolvePanel } from "../solve/SolvePanel";
import type { Solution, SolveCamera } from "../solve/solve-types";
import { createWorkerSolver } from "../solve/worker-solver";
import { clampFrame } from "./frame-index";
import type { FrameSource } from "./frame-source";

export interface FrameViewerProps {
   source: FrameSource;
   /**
    * Identifies the clip for autosaving its tracks (see tracking/storage.ts).
    * Without one, tracks aren't saved.
    */
   clipKey?: string;
   /** The clip's file name, used for exports. */
   clipName?: string;
   /** Saves an exported file (a Python script). Defaults to a download. */
   saveFile?: (filename: string, text: string) => void;
   /** Picks the drawing backend. Defaults to WebGPU with a canvas 2D fallback. */
   createRenderer?: CreateRenderer;
   /**
    * Makes the pixel reader auto-tracking matches against. Defaults to an
    * OffscreenCanvas reader; tests inject synthetic images.
    */
   createLumaReader?: (
      width: number,
      height: number,
   ) => (sample: VideoSample) => LumaImage;
   /** Picks the score map for auto-tracking. Defaults to WebGPU, else CPU. */
   createScorer?: () => Promise<Scorer>;
   /** Runs a camera solve. Defaults to the WebAssembly solver in a worker. */
   solveCamera?: SolveCamera;
}

// One worker for the app; it starts on the first solve.
let sharedSolver: SolveCamera | null = null;
const defaultSolveCamera: SolveCamera = (request, signal) =>
   (sharedSolver ??= createWorkerSolver())(request, signal);

/** Arrow key -> unit direction, or `null` for other keys. */
function arrowDirection(key: string): [number, number] | null {
   switch (key) {
      case "ArrowLeft":
         return [-1, 0];
      case "ArrowRight":
         return [1, 0];
      case "ArrowUp":
         return [0, -1];
      case "ArrowDown":
         return [0, 1];
      default:
         return null;
   }
}

/** How far a key moves the playhead, or `null` if the key isn't a step key. */
function stepForKey(event: KeyboardEvent, frameCount: number): number | null {
   const big = event.shiftKey ? 10 : 1;
   switch (event.key) {
      case "ArrowLeft":
         return -big;
      case "ArrowRight":
         return big;
      case "Home":
         return -frameCount;
      case "End":
         return frameCount;
      default:
         return null;
   }
}

/**
 * Shows one frame of a FrameSource with its trackers.
 *
 * Keys: ←/→ step frames (Shift ×10), Home/End jump to the ends. With a track
 * selected, Alt+arrows nudge it 1 px on this frame (Alt+Shift: 0.1 px),
 * Delete removes it, Escape deselects, T tracks it forward automatically
 * from this frame (Shift+T: backward; Escape stops). O toggles onion-skinning.
 *
 * Frames are fetched by integer index only, and each sample is drawn in the
 * same synchronous step that receives it, then dropped (the source owns it).
 */
export function FrameViewer({
   source,
   clipKey,
   clipName = "clip",
   saveFile = (name, text) => downloadText(name, text, "text/x-python"),
   createRenderer = defaultCreateRenderer,
   createLumaReader = defaultCreateLumaReader,
   createScorer = defaultCreateScorer,
   solveCamera = defaultSolveCamera,
}: FrameViewerProps) {
   const { frameCount, width, height } = source.metadata;
   const [index, setIndex] = React.useState(0);
   const [error, setError] = React.useState<string | null>(null);
   const [renderer, setRenderer] = React.useState<FrameRenderer | null>(null);
   // Set when WebGPU fails at runtime; we then switch to canvas 2D for good.
   const [gpuFailure, setGpuFailure] = React.useState<string | null>(null);
   const [tracks, dispatch] = React.useReducer(tracksReducer, clipKey, (key) =>
      key == null ? initialTrackState : loadTracks(key, frameCount),
   );
   // Autosave on change. (Selection changes rewrite the same data; cheap.)
   React.useEffect(() => {
      if (clipKey != null) {
         saveTracks(clipKey, tracks);
      }
   }, [clipKey, tracks]);
   const selectedId = tracks.selectedId;
   const [onion, setOnion] = React.useState(defaultOnionSettings);
   const canvasRef = React.useRef<HTMLCanvasElement>(null);
   const [trackingStatus, setTrackingStatus] =
      React.useState<TrackingStatus | null>(null);
   // The running auto-track, if any. Other keys are ignored while it runs.
   const trackingRef = React.useRef<AbortController | null>(null);
   const readLumaRef = React.useRef<((s: VideoSample) => LumaImage) | null>(
      null,
   );
   // Created on first use (it holds its own GPU device), disposed on unmount.
   const scorerRef = React.useRef<Promise<Scorer> | null>(null);
   React.useEffect(
      () => () => {
         trackingRef.current?.abort();
         void scorerRef.current?.then((scorer) => scorer.dispose());
         scorerRef.current = null;
      },
      [],
   );

   const startTracking = React.useCallback(
      (id: number, from: number, direction: 1 | -1) => {
         const track = tracks.tracks.find((t) => t.id === id);
         const placement = track && positionAt(track, from);
         if (track == null || placement == null) {
            return;
         }
         let readLuma;
         try {
            readLuma = readLumaRef.current ??= createLumaReader(width, height);
         } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            return;
         }
         const controller = new AbortController();
         trackingRef.current = controller;
         const status: TrackingStatus = {
            name: track.name,
            direction,
            frames: 0,
         };
         setTrackingStatus(status);
         const scorer = (scorerRef.current ??= createScorer());
         scorer
            .then((s) =>
               autoTrack({
                  source,
                  readLuma,
                  from,
                  point: placement.point,
                  direction,
                  signal: controller.signal,
                  scorer: s.scoreMap,
                  onStep: (frame, point) => {
                     dispatch({ type: "move", id, frame, point });
                     setIndex(frame);
                     status.frames++;
                     status.engine = s.kind;
                     setTrackingStatus({ ...status });
                  },
               }).then((result) => ({ result, engine: s.kind })),
            )
            .then(
               ({ result, engine }) =>
                  setTrackingStatus({ ...status, engine, result }),
               (err: unknown) => {
                  setTrackingStatus(null);
                  setError(err instanceof Error ? err.message : String(err));
               },
            )
            .finally(() => {
               if (trackingRef.current === controller) {
                  trackingRef.current = null;
               }
            });
      },
      [source, width, height, createLumaReader, createScorer, tracks],
   );
   async function exportForBlender() {
      try {
         // The rotation lets the script handle a Blender that ignores it.
         const rotation = (await source.getFrame(0)).rotation;
         saveFile(
            blenderScriptName(clipName),
            blenderScript(tracks, {
               clipName,
               width,
               height,
               frameCount,
               frameRate: source.metadata.frameRate,
               rotation,
            }),
         );
      } catch (err) {
         setError(err instanceof Error ? err.message : String(err));
      }
   }
   function exportCamera(solution: Solution) {
      saveFile(
         blenderCameraScriptName(clipName),
         blenderCameraScript(
            solution,
            {
               clipName,
               width,
               height,
               frameCount,
               frameRate: source.metadata.frameRate,
            },
            new Map(tracks.tracks.map((t) => [t.id, t.name])),
         ),
      );
   }
   const [solution, setSolution] = React.useState<Solution | null>(null);
   const create = gpuFailure == null ? createRenderer : createCanvas2dRenderer;

   // A canvas gets one context type for life, so the renderer is created once
   // per mount (StrictMode's mount/unmount/mount gets a fresh canvas each time).
   React.useEffect(() => {
      const canvas = canvasRef.current;
      if (canvas == null) {
         return;
      }
      let created: FrameRenderer | null = null;
      let cancelled = false;
      create(canvas).then(
         (r) => {
            if (cancelled) {
               r.dispose();
               return;
            }
            created = r;
            setRenderer(r);
            void r.lost?.then((reason) => {
               if (!cancelled) {
                  setGpuFailure(reason);
               }
            });
         },
         (err: unknown) => {
            if (!cancelled) {
               setError(err instanceof Error ? err.message : String(err));
            }
         },
      );
      return () => {
         cancelled = true;
         created?.dispose();
         setRenderer(null);
      };
   }, [create]);

   React.useEffect(() => {
      function onKeyDown(event: KeyboardEvent) {
         // Let form controls (onion settings) keep their own keys.
         if (
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement ||
            event.target instanceof HTMLSelectElement
         ) {
            return;
         }
         if (trackingRef.current != null) {
            if (event.key === "Escape") {
               event.preventDefault();
               trackingRef.current.abort();
            }
            return;
         }
         if (
            (event.key === "o" || event.key === "O") &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
         ) {
            event.preventDefault();
            setOnion((settings) => ({
               ...settings,
               enabled: !settings.enabled,
            }));
            return;
         }
         if (selectedId != null && handleTrackKey(event, selectedId)) {
            event.preventDefault();
            return;
         }
         const step = stepForKey(event, frameCount);
         if (step == null) {
            return;
         }
         event.preventDefault();
         setIndex((i) => clampFrame(i + step, frameCount));
      }
      function handleTrackKey(event: KeyboardEvent, id: number): boolean {
         const direction = arrowDirection(event.key);
         if (event.altKey && direction != null) {
            const amount = event.shiftKey ? 0.1 : 1;
            dispatch({
               type: "nudge",
               id,
               frame: index,
               dx: direction[0] * amount,
               dy: direction[1] * amount,
            });
            return true;
         }
         if (event.key === "Delete" || event.key === "Backspace") {
            dispatch({ type: "remove", id });
            return true;
         }
         if (event.key === "Escape") {
            dispatch({ type: "select", id: null });
            return true;
         }
         if (
            (event.key === "t" || event.key === "T") &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
         ) {
            startTracking(id, index, event.shiftKey ? -1 : 1);
            return true;
         }
         return false;
      }
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
   }, [frameCount, selectedId, index, startTracking]);

   React.useEffect(() => {
      if (renderer == null) {
         return;
      }
      // Stepping quickly fires several fetches; only the latest may draw.
      let stale = false;
      const layers = onionLayers(index, frameCount, onion);
      const fetched =
         layers.length === 1
            ? source.getFrame(index).then((sample) => [sample])
            : source.getFrames(layers.map((layer) => layer.index));
      fetched.then(
         (samples) => {
            if (stale) {
               return;
            }
            try {
               renderer.draw(
                  layers.map((layer, i) => ({
                     sample: samples[i],
                     opacity: layer.opacity,
                     tint: layer.tint,
                  })),
               );
               setError(null);
            } catch (err) {
               const message = err instanceof Error ? err.message : String(err);
               if (renderer.kind === "webgpu") {
                  setGpuFailure(message);
               } else {
                  setError(message);
               }
            }
         },
         (err: unknown) => {
            if (!stale) {
               setError(err instanceof Error ? err.message : String(err));
            }
         },
      );
      return () => {
         stale = true;
      };
   }, [source, index, renderer, frameCount, onion]);

   return (
      <div className="frame-viewer">
         <div className="frame-stage">
            {/* A canvas can't change context type, so the 2D fallback gets a new one. */}
            <canvas
               key={gpuFailure == null ? "auto" : "2d"}
               ref={canvasRef}
               className="frame-canvas"
               width={width}
               height={height}
               aria-label="Current frame"
            />
            {solution != null && (
               <SolveOverlay
                  solution={solution}
                  tracks={tracks}
                  width={width}
                  height={height}
                  frame={index}
               />
            )}
            <TrackOverlay
               width={width}
               height={height}
               frame={index}
               state={tracks}
               dispatch={dispatch}
            />
         </div>
         <p className="frame-counter" aria-live="polite">
            Frame {index + 1} / {frameCount}
         </p>
         {renderer != null && (
            <p className="renderer-kind" title={gpuFailure ?? undefined}>
               {renderer.kind === "webgpu" ? "WebGPU" : "Canvas 2D"}
               {gpuFailure != null && " (WebGPU failed, see tooltip)"}
            </p>
         )}
         {trackingStatus != null && (
            <p
               className="tracking-status"
               role="status"
               title={
                  trackingStatus.engine == null
                     ? undefined
                     : `Matching on ${trackingStatus.engine === "webgpu" ? "WebGPU" : "the CPU"}`
               }
            >
               {trackingStatusText(trackingStatus)}
            </p>
         )}
         {error != null && (
            <p className="error" role="alert">
               {error}
            </p>
         )}
         <OnionControls settings={onion} onChange={setOnion} />
         <TrackList frame={index} state={tracks} dispatch={dispatch} />
         {tracks.tracks.length > 0 && (
            <button
               type="button"
               className="export-button"
               onClick={() => void exportForBlender()}
            >
               Export for Blender
            </button>
         )}
         {tracks.tracks.length > 0 && (
            <SolvePanel
               tracks={tracks}
               width={width}
               height={height}
               frameCount={frameCount}
               frame={index}
               onSeek={setIndex}
               solveCamera={solveCamera}
               onExport={exportCamera}
               onSolution={setSolution}
               onSelectTrack={(id) => dispatch({ type: "select", id })}
            />
         )}
      </div>
   );
}
