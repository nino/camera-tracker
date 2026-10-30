import type React from "react";
import type { Solution } from "./solve-types";
import { forward, nearestCamera, planBounds, toPlan } from "./camera-path";

export interface CameraPathProps {
   solution: Solution;
   /** The frame on screen; its camera is highlighted. */
   frame: number;
   onSeek: (frame: number) => void;
}

/** Top view of the solved cameras and points (see camera-path.ts). */
export function CameraPath({ solution, frame, onSeek }: CameraPathProps) {
   const bounds = planBounds(solution);
   // Sizes in view-box units, so marks look the same at any scene scale.
   const unit = bounds.width / 240;
   const path = solution.cameras
      .map((c) => {
         const p = toPlan(c.centre);
         return `${p.x},${p.y}`;
      })
      .join(" ");
   const current = solution.cameras.find((c) => c.frame === frame);
   // Neighbouring cameras overlap, so a click picks the nearest one rather
   // than whichever circle is on top. The view box is square and so is the
   // element, so one scale maps both axes.
   function onClick(event: React.MouseEvent<SVGSVGElement>) {
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width === 0) {
         return;
      }
      const scale = bounds.width / rect.width;
      const hit = nearestCamera(solution, {
         x: bounds.x + (event.clientX - rect.left) * scale,
         y: bounds.y + (event.clientY - rect.top) * scale,
      });
      if (hit != null) {
         onSeek(hit.frame);
      }
   }
   return (
      <svg
         className="camera-path"
         onClick={onClick}
         viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
         role="img"
         aria-label="Camera path, top view"
      >
         {solution.points.map((point) => {
            const p = toPlan(point.position);
            return (
               <circle
                  key={point.id}
                  className="solved-point"
                  cx={p.x}
                  cy={p.y}
                  r={1.2 * unit}
               />
            );
         })}
         <polyline
            className="camera-line"
            points={path}
            strokeWidth={1.5 * unit}
         />
         {solution.cameras.map((camera) => {
            const p = toPlan(camera.centre);
            return (
               <circle
                  key={camera.frame}
                  className="camera-stop"
                  data-frame={camera.frame}
                  cx={p.x}
                  cy={p.y}
                  r={3 * unit}
               >
                  <title>{`Frame ${camera.frame + 1}`}</title>
               </circle>
            );
         })}
         {current != null && (
            <CurrentCamera
               centre={toPlan(current.centre)}
               look={toPlan(forward(current))}
               unit={unit}
            />
         )}
      </svg>
   );
}

function CurrentCamera({
   centre,
   look,
   unit,
}: {
   centre: { x: number; y: number };
   look: { x: number; y: number };
   unit: number;
}) {
   const length = Math.hypot(look.x, look.y);
   const reach = 18 * unit;
   // A camera looking straight up or down has no direction in plan.
   const tip =
      length < 1e-6
         ? centre
         : {
              x: centre.x + (look.x / length) * reach,
              y: centre.y + (look.y / length) * reach,
           };
   return (
      <g className="current-camera" data-testid="current-camera">
         <line
            x1={centre.x}
            y1={centre.y}
            x2={tip.x}
            y2={tip.y}
            strokeWidth={2 * unit}
         />
         <circle cx={centre.x} cy={centre.y} r={4.5 * unit} />
      </g>
   );
}
