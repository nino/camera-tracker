import React from "react";
import { clampFrame } from "./frame-index";
import type { FrameSource } from "./frame-source";

export interface FrameViewerProps {
   source: FrameSource;
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
 * Shows one frame of a FrameSource on a 2D canvas and steps through frames with
 * the keyboard (←/→, Shift for ×10, Home/End).
 *
 * Frames are fetched by integer index only, and each sample is drawn in the
 * same synchronous step that receives it, then dropped (the source owns it).
 */
export function FrameViewer({ source }: FrameViewerProps) {
   const { frameCount, width, height } = source.metadata;
   const [index, setIndex] = React.useState(0);
   const [error, setError] = React.useState<string | null>(null);
   const canvasRef = React.useRef<HTMLCanvasElement>(null);

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
      // Stepping quickly fires several fetches; only the latest may draw.
      let stale = false;
      source.getFrame(index).then(
         (sample) => {
            if (stale) {
               return;
            }
            setError(null);
            const ctx = canvasRef.current?.getContext("2d");
            // jsdom (tests) has no 2D context; nothing to draw into.
            if (ctx != null) {
               sample.draw(ctx, 0, 0, width, height);
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
   }, [source, index, width, height]);

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
         {error != null && (
            <p className="error" role="alert">
               {error}
            </p>
         )}
      </div>
   );
}
