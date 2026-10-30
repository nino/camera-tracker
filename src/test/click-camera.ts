import { fireEvent } from "@testing-library/react";
import { planBounds, toPlan } from "../solve/camera-path";
import type { Solution } from "../solve/solve-types";

/**
 * Clicks a camera in a rendered CameraPath. jsdom has no layout, so this
 * gives the SVG a 240 px box and clicks where that camera would be drawn.
 */
export function clickCamera(solution: Solution, frame: number): void {
   const svg = document.querySelector<SVGSVGElement>("svg.camera-path")!;
   svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 240, height: 240 }) as DOMRect;
   const bounds = planBounds(solution);
   const camera = solution.cameras.find((c) => c.frame === frame)!;
   const p = toPlan(camera.centre);
   const scale = 240 / bounds.width;
   fireEvent.click(svg, {
      clientX: (p.x - bounds.x) * scale,
      clientY: (p.y - bounds.y) * scale,
   });
}
