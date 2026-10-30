import { deserializeTracks, serializeTracks } from "./serialize";
import { initialTrackState, tracksReducer, type TrackAction } from "./tracks";

const actions: TrackAction[] = [
   { type: "add", frame: 4, point: { x: 10.25, y: 20.5 } },
   { type: "move", id: 1, frame: 1, point: { x: 9, y: 19 } },
   { type: "add", frame: 7, point: { x: 1, y: 2 } },
   { type: "remove", id: 2 },
   { type: "add", frame: 0, point: { x: 3, y: 4 } },
];
const state = actions.reduce(tracksReducer, initialTrackState);

describe("serializeTracks", () => {
   it("writes keys as sorted [frame, x, y] triples", () => {
      expect(serializeTracks(state)).toEqual({
         version: 1,
         tracks: [
            {
               id: 1,
               name: "Track 1",
               keys: [
                  [1, 9, 19],
                  [4, 10.25, 20.5],
               ],
            },
            { id: 3, name: "Track 3", keys: [[0, 3, 4]] },
         ],
      });
   });
});

describe("deserializeTracks", () => {
   it("round-trips through JSON", () => {
      const json = JSON.parse(JSON.stringify(serializeTracks(state)));
      const loaded = deserializeTracks(json, 100);
      expect(loaded.tracks.map((track) => [...track.keys])).toEqual(
         state.tracks.map((track) => [...track.keys].sort(([a], [b]) => a - b)),
      );
      // New tracks get fresh ids.
      expect(loaded.nextId).toBe(4);
      expect(loaded.selectedId).toBeNull();
   });

   it("drops keys outside the clip, and tracks left with none", () => {
      const loaded = deserializeTracks(serializeTracks(state), 2);
      expect(loaded.tracks.map((track) => track.id)).toEqual([1, 3]);
      expect([...loaded.tracks[0].keys.keys()]).toEqual([1]);
      const shorter = deserializeTracks(serializeTracks(state), 1);
      expect(shorter.tracks.map((track) => track.id)).toEqual([3]);
   });

   it.each([
      ["not an object", 42],
      ["wrong version", { version: 2, tracks: [] }],
      ["bad track", { version: 1, tracks: [{ id: "x", name: "a", keys: [] }] }],
      [
         "bad key",
         { version: 1, tracks: [{ id: 1, name: "a", keys: [[0, 1]] }] },
      ],
      [
         "non-finite coordinate",
         { version: 1, tracks: [{ id: 1, name: "a", keys: [[0, 1, null]] }] },
      ],
   ])("rejects %s", (_, data) => {
      expect(() => deserializeTracks(data, 10)).toThrow();
   });
});
