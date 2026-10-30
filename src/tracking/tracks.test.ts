import {
   initialTrackState,
   positionAt,
   tracksReducer,
   type TrackAction,
   type TrackState,
} from "./tracks";

function run(...actions: TrackAction[]): TrackState {
   return actions.reduce(tracksReducer, initialTrackState);
}

const add = (frame: number, x: number, y: number): TrackAction => ({
   type: "add",
   frame,
   point: { x, y },
});

describe("tracksReducer", () => {
   it("adds numbered tracks keyed on the current frame and selects the new one", () => {
      const state = run(add(3, 10.5, 20.25), add(4, 1, 2));
      expect(state.tracks.map((track) => track.name)).toEqual([
         "Track 1",
         "Track 2",
      ]);
      expect([...state.tracks[0].keys]).toEqual([[3, { x: 10.5, y: 20.25 }]]);
      expect(state.selectedId).toBe(2);
   });

   it("moves a track on a frame by adding or replacing that frame's key", () => {
      const state = run(
         add(0, 1, 1),
         { type: "move", id: 1, frame: 5, point: { x: 2, y: 3 } },
         { type: "move", id: 1, frame: 5, point: { x: 4, y: 5 } },
      );
      expect([...state.tracks[0].keys]).toEqual([
         [0, { x: 1, y: 1 }],
         [5, { x: 4, y: 5 }],
      ]);
   });

   it("nudges from the held position, creating a key on this frame", () => {
      const state = run(add(0, 10, 10), {
         type: "nudge",
         id: 1,
         frame: 7,
         dx: 0.1,
         dy: -1,
      });
      expect(state.tracks[0].keys.get(0)).toEqual({ x: 10, y: 10 });
      expect(state.tracks[0].keys.get(7)).toEqual({ x: 10.1, y: 9 });
   });

   it("unkeys a frame but never a track's last key", () => {
      let state = run(add(0, 1, 1), {
         type: "move",
         id: 1,
         frame: 2,
         point: { x: 2, y: 2 },
      });
      state = tracksReducer(state, { type: "unkey", id: 1, frame: 2 });
      expect([...state.tracks[0].keys.keys()]).toEqual([0]);
      const same = tracksReducer(state, { type: "unkey", id: 1, frame: 0 });
      expect(same).toBe(state);
   });

   it("removes a track and clears the selection if it was selected", () => {
      const state = run(add(0, 1, 1), add(0, 2, 2), { type: "remove", id: 2 });
      expect(state.tracks.map((track) => track.id)).toEqual([1]);
      expect(state.selectedId).toBeNull();
   });

   it("returns the same state for actions on unknown tracks", () => {
      const state = run(add(0, 1, 1));
      expect(
         tracksReducer(state, {
            type: "move",
            id: 99,
            frame: 0,
            point: { x: 0, y: 0 },
         }),
      ).toBe(state);
   });
});

describe("positionAt", () => {
   const state = run(add(10, 1, 1), {
      type: "move",
      id: 1,
      frame: 20,
      point: { x: 2, y: 2 },
   });
   const track = state.tracks[0];

   it("returns the key on a keyed frame", () => {
      expect(positionAt(track, 20)).toEqual({
         point: { x: 2, y: 2 },
         keyed: true,
      });
   });

   it("holds the previous key between and after keys", () => {
      expect(positionAt(track, 15)).toEqual({
         point: { x: 1, y: 1 },
         keyed: false,
      });
      expect(positionAt(track, 99)?.point).toEqual({ x: 2, y: 2 });
   });

   it("uses the first key before any key", () => {
      expect(positionAt(track, 0)).toEqual({
         point: { x: 1, y: 1 },
         keyed: false,
      });
   });
});
