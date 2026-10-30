import React from "react";
import {
   createCanvas2dRenderer,
   createRenderer as defaultCreateRenderer,
   type CreateRenderer,
   type FrameRenderer,
} from "../gpu/frame-renderer";
import { OnionControls } from "../onion/OnionControls";
import { defaultOnionSettings, onionLayers } from "../onion/onion";
import { TrackList } from "../tracking/TrackList";
import { TrackOverlay } from "../tracking/TrackOverlay";
import { loadTracks, saveTracks } from "../tracking/storage";
import { initialTrackState, tracksReducer } from "../tracking/tracks";
import { clampFrame } from "./frame-index";
import type { FrameSource } from "./frame-source";

export interface FrameViewerProps {
   source: FrameSource;
   /**
    * Identifies the clip for autosaving its tracks (see tracking/storage.ts).
    * Without one, tracks aren't saved.
    */
   clipKey?: string;
   /** Picks the drawing backend. Defaults to WebGPU with a canvas 2D fallback. */
   createRenderer?: CreateRenderer;
}

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
 * Delete removes it, Escape deselects. O toggles onion-skinning.
 *
 * Frames are fetched by integer index only, and each sample is drawn in the
 * same synchronous step that receives it, then dropped (the source owns it).
 */
export function FrameViewer({
   source,
   clipKey,
   createRenderer = defaultCreateRenderer,
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
         return false;
      }
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
   }, [frameCount, selectedId, index]);

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
         {error != null && (
            <p className="error" role="alert">
               {error}
            </p>
         )}
         <OnionControls settings={onion} onChange={setOnion} />
         <TrackList frame={index} state={tracks} dispatch={dispatch} />
      </div>
   );
}
