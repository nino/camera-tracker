import type { Point, Track, TrackState } from "./tracks";

/**
 * On-disk / in-storage form of a clip's tracks. Versioned so the format can
 * change later without silently misreading old saves.
 *
 * Keys are `[frame, x, y]` triples in display pixels (see tracks.ts).
 */
export interface TracksFileV1 {
   version: 1;
   tracks: { id: number; name: string; keys: [number, number, number][] }[];
}

export function serializeTracks(state: TrackState): TracksFileV1 {
   return {
      version: 1,
      tracks: state.tracks.map((track) => ({
         id: track.id,
         name: track.name,
         keys: [...track.keys]
            .sort(([a], [b]) => a - b)
            .map(([frame, { x, y }]) => [frame, x, y]),
      })),
   };
}

/**
 * Parses saved tracks. Throws on anything malformed rather than guessing, and
 * drops keys outside `0..frameCount-1` (e.g. a save from a longer clip with
 * the same name).
 */
export function deserializeTracks(
   data: unknown,
   frameCount: number,
): TrackState {
   if (!isObject(data) || data.version !== 1 || !Array.isArray(data.tracks)) {
      throw new Error("Not a version 1 tracks file.");
   }
   const tracks: Track[] = [];
   for (const raw of data.tracks) {
      if (
         !isObject(raw) ||
         !Number.isInteger(raw.id) ||
         typeof raw.name !== "string" ||
         !Array.isArray(raw.keys)
      ) {
         throw new Error("Malformed track.");
      }
      const keys = new Map<number, Point>();
      for (const key of raw.keys) {
         if (
            !Array.isArray(key) ||
            key.length !== 3 ||
            !Number.isInteger(key[0]) ||
            !key.every((n) => typeof n === "number" && Number.isFinite(n))
         ) {
            throw new Error(`Malformed key in ${raw.name}.`);
         }
         const [frame, x, y] = key as [number, number, number];
         if (frame >= 0 && frame < frameCount) {
            keys.set(frame, { x, y });
         }
      }
      if (keys.size > 0) {
         tracks.push({ id: raw.id as number, name: raw.name, keys });
      }
   }
   const nextId = tracks.reduce((max, track) => Math.max(max, track.id), 0) + 1;
   return { tracks, selectedId: null, nextId };
}

function isObject(value: unknown): value is Record<string, unknown> {
   return typeof value === "object" && value !== null;
}
