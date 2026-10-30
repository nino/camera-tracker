import type { Point } from "./tracks";

export interface Rect {
   left: number;
   top: number;
   width: number;
   height: number;
}

/**
 * Maps a pointer position to display-pixel coordinates of the frame, given the
 * on-screen rectangle the frame occupies.
 */
export function clientToDisplay(
   clientX: number,
   clientY: number,
   rect: Rect,
   width: number,
   height: number,
): Point {
   return {
      x: ((clientX - rect.left) / rect.width) * width,
      y: ((clientY - rect.top) / rect.height) * height,
   };
}
