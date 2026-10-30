import { positionAt, type TrackAction, type TrackState } from "./tracks";

export interface TrackListProps {
   frame: number;
   state: TrackState;
   dispatch: (action: TrackAction) => void;
}

/** Lists tracks with their position on the current frame. */
export function TrackList({ frame, state, dispatch }: TrackListProps) {
   if (state.tracks.length === 0) {
      return (
         <p className="track-hint">
            Click the frame to add a tracker. Drag it, or select it and use
            Alt+arrows (Alt+Shift for 0.1 px), to position it on each frame.
         </p>
      );
   }
   return (
      <ul className="track-list" aria-label="Tracks">
         {state.tracks.map((track) => {
            const at = positionAt(track, frame);
            const selected = track.id === state.selectedId;
            return (
               <li key={track.id} className={selected ? "selected" : undefined}>
                  <button
                     type="button"
                     className="track-select"
                     aria-pressed={selected}
                     onClick={() =>
                        dispatch({
                           type: "select",
                           id: selected ? null : track.id,
                        })
                     }
                  >
                     {track.name}
                  </button>
                  <span className="track-position">
                     {at === undefined
                        ? "—"
                        : `${at.point.x.toFixed(2)}, ${at.point.y.toFixed(2)}`}
                     {at?.keyed === false && " (held)"}
                  </span>
                  <span className="track-keys">
                     {track.keys.size} {track.keys.size === 1 ? "key" : "keys"}
                  </span>
                  {at?.keyed === true && track.keys.size > 1 && (
                     <button
                        type="button"
                        onClick={() =>
                           dispatch({ type: "unkey", id: track.id, frame })
                        }
                     >
                        Unkey frame
                     </button>
                  )}
                  <button
                     type="button"
                     aria-label={`Delete ${track.name}`}
                     onClick={() => dispatch({ type: "remove", id: track.id })}
                  >
                     Delete
                  </button>
               </li>
            );
         })}
      </ul>
   );
}
