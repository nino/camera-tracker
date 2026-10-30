/**
 * Onion-skinning: show neighbouring frames over the current one, so you can
 * see how a feature moves and nudge a tracker until it lines up.
 *
 * The current frame is drawn opaque, then neighbours are overlaid from the
 * furthest to the nearest, so the nearest are the most visible. Each step
 * further away multiplies the opacity by `falloff`. Frames before the current
 * one are tinted red and frames after it cyan, so direction is readable at a
 * glance.
 */

export type Rgb = readonly [number, number, number];

export interface OnionSettings {
   readonly enabled: boolean;
   /** How many frames before the current one to show. */
   readonly before: number;
   /** How many frames after the current one to show. */
   readonly after: number;
   /** Opacity of the nearest neighbour, 0..1. */
   readonly opacity: number;
   /** Opacity multiplier per extra frame of distance, 0..1. */
   readonly falloff: number;
   /** Tint past frames red and future frames cyan. */
   readonly tint: boolean;
}

export const defaultOnionSettings: OnionSettings = {
   enabled: false,
   before: 1,
   after: 1,
   opacity: 0.5,
   falloff: 0.6,
   tint: true,
};

/** Upper bound on before/after, to keep the frame cache from thrashing. */
export const MAX_ONION_FRAMES = 8;

export const NO_TINT: Rgb = [1, 1, 1];
export const BEFORE_TINT: Rgb = [1, 0.35, 0.35];
export const AFTER_TINT: Rgb = [0.35, 0.85, 1];

export interface OnionLayer {
   readonly index: number;
   readonly opacity: number;
   readonly tint: Rgb;
}

/**
 * The layers to draw for frame `current`, in draw order: the current frame
 * first (opaque, untinted), then neighbours from furthest to nearest. Frames
 * outside `0..frameCount-1` are skipped.
 */
export function onionLayers(
   current: number,
   frameCount: number,
   settings: OnionSettings,
): OnionLayer[] {
   const layers: OnionLayer[] = [{ index: current, opacity: 1, tint: NO_TINT }];
   if (!settings.enabled) {
      return layers;
   }
   const before = clampCount(settings.before);
   const after = clampCount(settings.after);
   const furthest = Math.max(before, after);
   for (let distance = furthest; distance >= 1; distance--) {
      const opacity =
         clamp01(settings.opacity) *
         clamp01(settings.falloff) ** (distance - 1);
      if (distance <= before && current - distance >= 0) {
         layers.push({
            index: current - distance,
            opacity,
            tint: settings.tint ? BEFORE_TINT : NO_TINT,
         });
      }
      if (distance <= after && current + distance < frameCount) {
         layers.push({
            index: current + distance,
            opacity,
            tint: settings.tint ? AFTER_TINT : NO_TINT,
         });
      }
   }
   return layers;
}

function clampCount(n: number): number {
   return Math.min(Math.max(Math.round(n), 0), MAX_ONION_FRAMES);
}

function clamp01(n: number): number {
   return Math.min(Math.max(n, 0), 1);
}
