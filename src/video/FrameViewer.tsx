import React from "react";
import {
   createRenderer as defaultCreateRenderer,
   type CreateRenderer,
   type FrameRenderer,
} from "../gpu/frame-renderer";
import { clampFrame } from "./frame-index";
import type { FrameSource } from "./frame-source";

export interface FrameViewerProps {
   source: FrameSource;
   /** Picks the drawing backend. Defaults to WebGPU with a canvas 2D fallback. */
   createRenderer?: CreateRenderer;
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
 * Shows one frame of a FrameSource and steps through frames with the keyboard
 * (←/→, Shift for ×10, Home/End).
 *
 * Frames are fetched by integer index only, and each sample is drawn in the
 * same synchronous step that receives it, then dropped (the source owns it).
 */
export function FrameViewer({
   source,
   createRenderer = defaultCreateRenderer,
}: FrameViewerProps) {
   const { frameCount, width, height } = source.metadata;
   const [index, setIndex] = React.useState(0);
   const [error, setError] = React.useState<string | null>(null);
   const [renderer, setRenderer] = React.useState<FrameRenderer | null>(null);
   const canvasRef = React.useRef<HTMLCanvasElement>(null);

   // A canvas gets one context type for life, so the renderer is created once
   // per mount (StrictMode's mount/unmount/mount gets a fresh canvas each time).
   React.useEffect(() => {
      const canvas = canvasRef.current;
      if (canvas == null) {
         return;
      }
      let created: FrameRenderer | null = null;
      let cancelled = false;
      createRenderer(canvas).then(
         (r) => {
            if (cancelled) {
               r.dispose();
               return;
            }
            created = r;
            setRenderer(r);
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
      };
   }, [createRenderer]);

   React.useEffect(() => {
      function onKeyDown(event: KeyboardEvent) {
         const step = stepForKey(event, frameCount);
         if (step == null) {
            return;
         }
         event.preventDefault();
         setIndex((i) => clampFrame(i + step, frameCount));
      }
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
   }, [frameCount]);

   React.useEffect(() => {
      if (renderer == null) {
         return;
      }
      // Stepping quickly fires several fetches; only the latest may draw.
      let stale = false;
      source.getFrame(index).then(
         (sample) => {
            if (stale) {
               return;
            }
            try {
               renderer.draw(sample);
               setError(null);
            } catch (err) {
               setError(err instanceof Error ? err.message : String(err));
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
   }, [source, index, renderer]);

   return (
      <div className="frame-viewer">
         <canvas
            ref={canvasRef}
            className="frame-canvas"
            width={width}
            height={height}
            aria-label="Current frame"
         />
         <p className="frame-counter" aria-live="polite">
            Frame {index + 1} / {frameCount}
         </p>
         {renderer != null && (
            <p className="renderer-kind">
               {renderer.kind === "webgpu" ? "WebGPU" : "Canvas 2D"}
            </p>
         )}
         {error != null && (
            <p className="error" role="alert">
               {error}
            </p>
         )}
      </div>
   );
}
