/**
 * Manual tracking data model.
 *
 * COORDINATES: a Point is in *display* pixels of the frame (after rotation and
 * pixel aspect), as floats for sub-pixel precision. The origin is the top-left
 * corner of the frame, so the centre of the top-left pixel is (0.5, 0.5). This
 * is the space FrameSource.metadata width/height describe, what the viewer
 * draws, and what Blender's movie clip editor expects (it normalises by the
 * displayed size). See PLAN.md, "Key design decisions".
 *
 * A Track holds positions only on frames where the user placed it ("keys").
 * Between keys there is no interpolation yet: `positionAt` holds the previous
 * key (or the first key, before it), so the marker stays where you left it
 * when you step to a new frame and you nudge it from there.
 */

export interface Point {
   readonly x: number;
   readonly y: number;
}

export interface Track {
   readonly id: number;
   readonly name: string;
   /** frame index -> position, only on keyed frames. */
   readonly keys: ReadonlyMap<number, Point>;
}

export interface TrackState {
   readonly tracks: readonly Track[];
   readonly selectedId: number | null;
   readonly nextId: number;
}

export const initialTrackState: TrackState = {
   tracks: [],
   selectedId: null,
   nextId: 1,
};

export type TrackAction =
   | { type: "add"; frame: number; point: Point }
   | { type: "select"; id: number | null }
   | { type: "move"; id: number; frame: number; point: Point }
   | { type: "nudge"; id: number; frame: number; dx: number; dy: number }
   | { type: "unkey"; id: number; frame: number }
   | { type: "remove"; id: number };

export interface Placement {
   readonly point: Point;
   /** True if `frame` itself is keyed; false if the position is held from another key. */
   readonly keyed: boolean;
}

/** Where `track` sits on `frame`, or undefined if it has no keys at all. */
export function positionAt(track: Track, frame: number): Placement | undefined {
   const exact = track.keys.get(frame);
   if (exact !== undefined) {
      return { point: exact, keyed: true };
   }
   let before: number | undefined;
   let after: number | undefined;
   for (const key of track.keys.keys()) {
      if (key < frame && (before === undefined || key > before)) {
         before = key;
      }
      if (key > frame && (after === undefined || key < after)) {
         after = key;
      }
   }
   const from = before ?? after;
   return from === undefined
      ? undefined
      : { point: track.keys.get(from)!, keyed: false };
}

export function tracksReducer(
   state: TrackState,
   action: TrackAction,
): TrackState {
   switch (action.type) {
      case "add": {
         const track: Track = {
            id: state.nextId,
            name: `Track ${state.nextId}`,
            keys: new Map([[action.frame, action.point]]),
         };
         return {
            tracks: [...state.tracks, track],
            selectedId: track.id,
            nextId: state.nextId + 1,
         };
      }
      case "select":
         return { ...state, selectedId: action.id };
      case "move":
         return updateTrack(state, action.id, (track) =>
            withKey(track, action.frame, action.point),
         );
      case "nudge":
         return updateTrack(state, action.id, (track) => {
            const at = positionAt(track, action.frame);
            if (at === undefined) {
               return track;
            }
            return withKey(track, action.frame, {
               x: at.point.x + action.dx,
               y: at.point.y + action.dy,
            });
         });
      case "unkey":
         return updateTrack(state, action.id, (track) => {
            // A track always keeps at least one key; remove the track instead.
            if (!track.keys.has(action.frame) || track.keys.size === 1) {
               return track;
            }
            const keys = new Map(track.keys);
            keys.delete(action.frame);
            return { ...track, keys };
         });
      case "remove":
         return {
            ...state,
            tracks: state.tracks.filter((track) => track.id !== action.id),
            selectedId:
               state.selectedId === action.id ? null : state.selectedId,
         };
   }
}

function withKey(track: Track, frame: number, point: Point): Track {
   const keys = new Map(track.keys);
   keys.set(frame, point);
   return { ...track, keys };
}

function updateTrack(
   state: TrackState,
   id: number,
   update: (track: Track) => Track,
): TrackState {
   let changed = false;
   const tracks = state.tracks.map((track) => {
      if (track.id !== id) {
         return track;
      }
      const next = update(track);
      changed ||= next !== track;
      return next;
   });
   return changed ? { ...state, tracks } : state;
}
