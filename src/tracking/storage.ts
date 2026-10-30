import { initialTrackState, type TrackState } from "./tracks";
import { deserializeTracks, serializeTracks } from "./serialize";

/**
 * Autosaves each clip's tracks in localStorage, so reopening the same file
 * brings them back. A clip is identified by the caller's `clipKey` (name, size
 * and modification time of the file).
 *
 * Storage can be unavailable or full; we log and carry on rather than break
 * tracking.
 */
const PREFIX = "camera-tracker:tracks:";

export function loadTracks(clipKey: string, frameCount: number): TrackState {
   try {
      const raw = localStorage.getItem(PREFIX + clipKey);
      if (raw == null) {
         return initialTrackState;
      }
      return deserializeTracks(JSON.parse(raw), frameCount);
   } catch (err) {
      console.warn("Couldn't load saved tracks:", err);
      return initialTrackState;
   }
}

export function saveTracks(clipKey: string, state: TrackState): void {
   try {
      if (state.tracks.length === 0) {
         localStorage.removeItem(PREFIX + clipKey);
      } else {
         localStorage.setItem(
            PREFIX + clipKey,
            JSON.stringify(serializeTracks(state)),
         );
      }
   } catch (err) {
      console.warn("Couldn't save tracks:", err);
   }
}

/** A stable identity for a file, for keying its saved tracks. */
export function clipKeyForFile(file: File): string {
   return `${file.name}|${file.size}|${file.lastModified}`;
}
