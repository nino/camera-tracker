import { clipKeyForFile, loadTracks, saveTracks } from "./storage";
import { initialTrackState, tracksReducer } from "./tracks";

const withTrack = tracksReducer(initialTrackState, {
   type: "add",
   frame: 2,
   point: { x: 5, y: 6 },
});

describe("track storage", () => {
   afterEach(() => vi.restoreAllMocks());

   it("saves and loads a clip's tracks", () => {
      saveTracks("clip-a", withTrack);
      const loaded = loadTracks("clip-a", 10);
      expect([...loaded.tracks[0].keys]).toEqual([[2, { x: 5, y: 6 }]]);
      expect(loadTracks("clip-b", 10)).toBe(initialTrackState);
   });

   it("forgets a clip once its last track is removed", () => {
      saveTracks("clip-a", withTrack);
      saveTracks("clip-a", initialTrackState);
      expect(localStorage.length).toBe(0);
   });

   it("survives corrupt data and unavailable storage", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      localStorage.setItem("camera-tracker:tracks:bad", "{not json");
      expect(loadTracks("bad", 10)).toBe(initialTrackState);

      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
         throw new Error("QuotaExceededError");
      });
      expect(() => saveTracks("clip-a", withTrack)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(2);
   });

   it("keys clips by name, size and modification time", () => {
      const file = new File(["abc"], "shot.mp4", { lastModified: 1234 });
      expect(clipKeyForFile(file)).toBe("shot.mp4|3|1234");
   });
});
