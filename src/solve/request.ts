import { serializeTracks } from "../tracking/serialize";
import type { TrackState } from "../tracking/tracks";
import type { SolveRequest } from "./solve-types";

/**
 * Focal lengths in the UI are full-frame equivalent millimetres: the longer
 * side of the frame counts as 36 mm. That's the number people know from
 * lenses (and Blender's default sensor width), and it doesn't depend on the
 * clip's resolution. Rotated (portrait) clips use their longer side too, so
 * a phone's lens reads the same either way up.
 */
export const FILM_MM = 36;

export function focalPixels(mm: number, width: number, height: number) {
   return (mm / FILM_MM) * Math.max(width, height);
}

export function focalMillimetres(px: number, width: number, height: number) {
   return (px / Math.max(width, height)) * FILM_MM;
}

export interface SolveSettings {
   /** Full-frame equivalent focal length guess, mm. */
   readonly focalMm: number;
   readonly refineFocal: boolean;
   readonly refineDistortion: boolean;
}

export function solveRequest(
   state: TrackState,
   clip: { width: number; height: number; frameCount: number },
   settings: SolveSettings,
): SolveRequest {
   return {
      width: clip.width,
      height: clip.height,
      frameCount: clip.frameCount,
      focal: focalPixels(settings.focalMm, clip.width, clip.height),
      refineFocal: settings.refineFocal,
      k1: 0,
      k2: 0,
      refineDistortion: settings.refineDistortion,
      tracks: serializeTracks(state).tracks.map(({ id, keys }) => ({
         id,
         keys,
      })),
   };
}
