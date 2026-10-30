import React from "react";
import { clientToDisplay } from "./coords";
import {
   positionAt,
   type Point,
   type TrackAction,
   type TrackState,
} from "./tracks";

export interface TrackOverlayProps {
   /** Frame display size; the overlay's coordinate space. */
   width: number;
   height: number;
   frame: number;
   state: TrackState;
   dispatch: (action: TrackAction) => void;
}

/** Marker crosshair radius in screen pixels. */
const MARKER_RADIUS_PX = 10;

/** The element's rendered width, kept current with a ResizeObserver. */
function useElementWidth(ref: React.RefObject<Element | null>): number {
   const [width, setWidth] = React.useState(0);
   React.useEffect(() => {
      const element = ref.current;
      // jsdom has no ResizeObserver.
      if (element == null || typeof ResizeObserver === "undefined") {
         return;
      }
      const observer = new ResizeObserver(() =>
         setWidth(element.getBoundingClientRect().width),
      );
      observer.observe(element);
      return () => observer.disconnect();
   }, [ref]);
   return width;
}

/**
 * An SVG layer over the frame for placing and dragging trackers. Its viewBox is
 * the frame's display size, so track coordinates are used as-is and the browser
 * scales them with the canvas.
 *
 * Click empty space to add a track on the current frame; drag a marker to key
 * its position on the current frame. Dragging keeps the grab offset, so
 * grabbing a marker off-centre doesn't make it jump.
 */
export function TrackOverlay({
   width,
   height,
   frame,
   state,
   dispatch,
}: TrackOverlayProps) {
   const svgRef = React.useRef<SVGSVGElement>(null);
   const drag = React.useRef<{ id: number; offset: Point } | null>(null);
   // Markers are a fixed size on screen (MARKER_RADIUS_PX), whatever the zoom,
   // so convert that to display pixels with the current on-screen scale.
   const screenWidth = useElementWidth(svgRef);
   const scale = screenWidth > 0 ? screenWidth / width : 1;
   const r = MARKER_RADIUS_PX / scale;

   function toDisplay(event: React.PointerEvent): Point {
      const rect = svgRef.current!.getBoundingClientRect();
      return clientToDisplay(event.clientX, event.clientY, rect, width, height);
   }

   function onBackgroundDown(event: React.PointerEvent) {
      if (event.button !== 0) {
         return;
      }
      dispatch({ type: "add", frame, point: toDisplay(event) });
   }

   function onMarkerDown(event: React.PointerEvent, id: number, at: Point) {
      if (event.button !== 0) {
         return;
      }
      event.stopPropagation();
      dispatch({ type: "select", id });
      const pointer = toDisplay(event);
      drag.current = {
         id,
         offset: { x: at.x - pointer.x, y: at.y - pointer.y },
      };
      // Not implemented in jsdom.
      svgRef.current?.setPointerCapture?.(event.pointerId);
   }

   function onPointerMove(event: React.PointerEvent) {
      const current = drag.current;
      if (current == null) {
         return;
      }
      const pointer = toDisplay(event);
      dispatch({
         type: "move",
         id: current.id,
         frame,
         point: {
            x: pointer.x + current.offset.x,
            y: pointer.y + current.offset.y,
         },
      });
   }

   function endDrag() {
      drag.current = null;
   }

   return (
      <svg
         ref={svgRef}
         className="track-overlay"
         viewBox={`0 0 ${width} ${height}`}
         preserveAspectRatio="none"
         data-testid="track-overlay"
         onPointerMove={onPointerMove}
         onPointerUp={endDrag}
         onPointerCancel={endDrag}
      >
         <rect
            width={width}
            height={height}
            fill="transparent"
            onPointerDown={onBackgroundDown}
         />
         {state.tracks.map((track) => {
            const at = positionAt(track, frame);
            if (at === undefined) {
               return null;
            }
            const { x, y } = at.point;
            const selected = track.id === state.selectedId;
            const classes = [
               "track-marker",
               at.keyed ? "keyed" : "held",
               selected ? "selected" : "",
            ].join(" ");
            return (
               <g
                  key={track.id}
                  className={classes}
                  role="button"
                  aria-label={`${track.name}${at.keyed ? "" : " (held)"}`}
                  aria-pressed={selected}
                  onPointerDown={(event) =>
                     onMarkerDown(event, track.id, at.point)
                  }
               >
                  <circle cx={x} cy={y} r={r} fill="transparent" />
                  {/* Crosshair with an open centre, so the feature stays visible. */}
                  <path
                     d={[
                        `M ${x - r} ${y} H ${x - r * 0.3}`,
                        `M ${x + r * 0.3} ${y} H ${x + r}`,
                        `M ${x} ${y - r} V ${y - r * 0.3}`,
                        `M ${x} ${y + r * 0.3} V ${y + r}`,
                     ].join(" ")}
                     vectorEffect="non-scaling-stroke"
                  />
                  <text x={x + r * 1.2} y={y - r * 0.6} fontSize={r * 1.2}>
                     {track.name}
                  </text>
               </g>
            );
         })}
      </svg>
   );
}
