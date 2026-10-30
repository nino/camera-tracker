/** Clamp a frame index into `0..frameCount - 1`. */
export function clampFrame(index: number, frameCount: number): number {
   return Math.min(Math.max(index, 0), frameCount - 1);
}
