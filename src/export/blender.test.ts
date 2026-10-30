import {
   tracksReducer,
   initialTrackState,
   type TrackState,
} from "../tracking/tracks";
import {
   blenderScript,
   blenderScriptName,
   blenderTracks,
   toBlenderCo,
} from "./blender";

function stateWith(
   ...keys: [frame: number, x: number, y: number][]
): TrackState {
   const [[frame, x, y], ...rest] = keys;
   let state = tracksReducer(initialTrackState, {
      type: "add",
      frame,
      point: { x, y },
   });
   const id = state.tracks[0].id;
   for (const [f, kx, ky] of rest) {
      state = tracksReducer(state, {
         type: "move",
         id,
         frame: f,
         point: { x: kx, y: ky },
      });
   }
   return state;
}

describe("toBlenderCo", () => {
   it("normalises and flips y so the origin is bottom-left", () => {
      expect(toBlenderCo({ x: 0, y: 0 }, 200, 100)).toEqual([0, 1]);
      expect(toBlenderCo({ x: 200, y: 100 }, 200, 100)).toEqual([1, 0]);
      // Centre of the top-left pixel stays a pixel centre.
      expect(toBlenderCo({ x: 0.5, y: 0.5 }, 200, 100)).toEqual([
         0.0025, 0.995,
      ]);
   });
});

describe("blenderTracks", () => {
   it("emits keyed frames only, 1-based and sorted", () => {
      const state = stateWith([4, 50, 25], [0, 100, 50], [9, 150, 75]);
      expect(blenderTracks(state, 200, 100)).toEqual([
         {
            name: "Track 1",
            markers: [
               [1, 0.5, 0.5],
               [5, 0.25, 0.75],
               [10, 0.75, 0.25],
            ],
         },
      ]);
   });
});

describe("blenderScriptName", () => {
   it("replaces the extension", () => {
      expect(blenderScriptName("shot 01.mp4")).toBe("shot 01.tracks.py");
      expect(blenderScriptName("noext")).toBe("noext.tracks.py");
      expect(blenderScriptName(".mp4")).toBe("tracks.tracks.py");
   });
});

describe("blenderScript", () => {
   const info = {
      clipName: 'odd "name".mp4',
      width: 200,
      height: 100,
      frameCount: 12,
      frameRate: 24,
      rotation: 90,
   };

   it("embeds the clip info and tracks as a literal", () => {
      const script = blenderScript(stateWith([0, 100, 50], [3, 50, 25]), info);
      const literal = /^DATA = (.*)$/m.exec(script)![1];
      expect(JSON.parse(literal)).toEqual({
         clip: 'odd "name".mp4',
         size: [200, 100],
         frameCount: 12,
         frameRate: 24,
         rotation: 90,
         tracks: [
            {
               name: "Track 1",
               markers: [
                  [1, 0.5, 0.5],
                  [4, 0.25, 0.75],
               ],
            },
         ],
      });
      expect(script).toMatch(/^import bpy$/m);
      expect(script).toMatch(/^main\(\)$/m);
   });

   it("keeps the comment header on comment lines", () => {
      const script = blenderScript(stateWith([0, 1, 1]), info);
      const header = script.slice(0, script.indexOf("import bpy"));
      for (const line of header.trim().split("\n")) {
         expect(line).toMatch(/^#/);
      }
   });
});
