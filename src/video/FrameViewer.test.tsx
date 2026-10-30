import {
   act,
   fireEvent,
   render,
   screen,
   waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FakeFrameSource } from "../test/fake-frame-source";
import { blobScene, renderLuma } from "../test/synthetic-scene";
import { FakeRenderer, fakeCreateRenderer } from "../test/fake-renderer";
import type { Scorer } from "../gpu/score-map";
import type { Solution, SolveCamera } from "../solve/solve-types";
import { clickCamera } from "../test/click-camera";
import { scoreMap } from "../tracking/match";
import { FrameViewer } from "./FrameViewer";

describe("FrameViewer", () => {
   it("shows and fetches the first frame", async () => {
      const source = new FakeFrameSource({ frameCount: 5 });
      render(
         <FrameViewer
            source={source}
            createRenderer={fakeCreateRenderer().create}
         />,
      );
      expect(screen.getByText("Frame 1 / 5")).toBeInTheDocument();
      await waitFor(() => expect(source.getFrame).toHaveBeenCalledWith(0));
   });

   it("steps with the arrow keys and clamps at both ends", async () => {
      const user = userEvent.setup();
      const source = new FakeFrameSource({ frameCount: 3 });
      render(<FrameViewer source={source} />);

      await user.keyboard("{ArrowLeft}");
      expect(screen.getByText("Frame 1 / 3")).toBeInTheDocument();
      await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
      expect(screen.getByText("Frame 3 / 3")).toBeInTheDocument();
      await user.keyboard("{ArrowLeft}");
      expect(screen.getByText("Frame 2 / 3")).toBeInTheDocument();
      await waitFor(() => expect(source.getFrame).toHaveBeenLastCalledWith(1));
   });

   it("jumps by 10 with Shift and to the ends with Home/End", async () => {
      const user = userEvent.setup();
      const source = new FakeFrameSource({ frameCount: 50 });
      render(<FrameViewer source={source} />);

      await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
      expect(screen.getByText("Frame 11 / 50")).toBeInTheDocument();
      await user.keyboard("{End}");
      expect(screen.getByText("Frame 50 / 50")).toBeInTheDocument();
      await user.keyboard("{Home}");
      expect(screen.getByText("Frame 1 / 50")).toBeInTheDocument();
   });

   it("draws each fetched frame with the renderer", async () => {
      const user = userEvent.setup();
      const { renderer, create } = fakeCreateRenderer();
      const source = new FakeFrameSource({ width: 320, height: 180 });
      render(<FrameViewer source={source} createRenderer={create} />);

      await waitFor(() => expect(renderer.drawn).toEqual([0]));
      await user.keyboard("{ArrowRight}");
      await waitFor(() => expect(renderer.drawn).toEqual([0, 1]));
      expect(screen.getByText("WebGPU")).toBeInTheDocument();

      const canvas = screen.getByLabelText("Current frame");
      expect(create).toHaveBeenCalledWith(canvas);
      expect(canvas).toHaveAttribute("width", "320");
      expect(canvas).toHaveAttribute("height", "180");
   });

   it("only draws the latest frame when fetches resolve out of order", async () => {
      const { renderer, create } = fakeCreateRenderer();
      const source = new FakeFrameSource();
      const pending = new Map<number, () => void>();
      const realGetFrame = source.getFrame.getMockImplementation()!;
      source.getFrame.mockImplementation(
         (index) =>
            new Promise((resolve) =>
               pending.set(index, () => resolve(realGetFrame(index))),
            ),
      );
      const user = userEvent.setup();
      render(<FrameViewer source={source} createRenderer={create} />);
      await waitFor(() => expect(pending.size).toBe(1));
      await user.keyboard("{ArrowRight}");
      await waitFor(() => expect(pending.size).toBe(2));

      // The newer frame lands first, then the stale one.
      await act(async () => pending.get(1)!());
      await act(async () => pending.get(0)!());
      expect(renderer.drawn).toEqual([1]);
   });

   it("disposes the renderer on unmount", async () => {
      const { renderer, create } = fakeCreateRenderer();
      const { unmount } = render(
         <FrameViewer source={new FakeFrameSource()} createRenderer={create} />,
      );
      await waitFor(() => expect(renderer.drawn).toEqual([0]));
      unmount();
      expect(renderer.dispose).toHaveBeenCalledOnce();
   });

   it("disposes a renderer that finishes creating after unmount", async () => {
      const renderer = new FakeRenderer();
      let finish!: () => void;
      const create = vi.fn(
         () =>
            new Promise<FakeRenderer>((resolve) => {
               finish = () => resolve(renderer);
            }),
      );
      const { unmount } = render(
         <FrameViewer source={new FakeFrameSource()} createRenderer={create} />,
      );
      unmount();
      await act(async () => finish());
      expect(renderer.dispose).toHaveBeenCalledOnce();
      expect(renderer.draw).not.toHaveBeenCalled();
   });

   it("shows draw errors from the canvas 2D renderer", async () => {
      const { renderer, create } = fakeCreateRenderer(new FakeRenderer("2d"));
      renderer.draw.mockImplementation(() => {
         throw new Error("canvas on fire");
      });
      render(
         <FrameViewer source={new FakeFrameSource()} createRenderer={create} />,
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
         "canvas on fire",
      );
   });

   it("switches to canvas 2D on a fresh canvas when a WebGPU draw fails", async () => {
      const { renderer, create } = fakeCreateRenderer();
      renderer.draw.mockImplementation(() => {
         throw new Error("GPU on fire");
      });
      render(
         <FrameViewer source={new FakeFrameSource()} createRenderer={create} />,
      );
      const firstCanvas = screen.getByLabelText("Current frame");
      expect(await screen.findByText(/Canvas 2D/)).toHaveAttribute(
         "title",
         "GPU on fire",
      );
      expect(renderer.dispose).toHaveBeenCalledOnce();
      expect(screen.getByLabelText("Current frame")).not.toBe(firstCanvas);
      expect(screen.queryByRole("alert")).toBeNull();
   });

   it("switches to canvas 2D when the WebGPU device is lost", async () => {
      const { renderer, create } = fakeCreateRenderer();
      render(
         <FrameViewer source={new FakeFrameSource()} createRenderer={create} />,
      );
      await waitFor(() => expect(renderer.drawn).toEqual([0]));
      await act(async () => renderer.loseDevice("device lost: crashed"));
      expect(await screen.findByText(/Canvas 2D/)).toHaveAttribute(
         "title",
         "device lost: crashed",
      );
      expect(renderer.dispose).toHaveBeenCalledOnce();
   });

   it("shows decode errors", async () => {
      const source = new FakeFrameSource();
      source.getFrame.mockRejectedValueOnce(new Error("decoder exploded"));
      render(
         <FrameViewer
            source={source}
            createRenderer={fakeCreateRenderer().create}
         />,
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(
         "decoder exploded",
      );
   });

   describe("trackers", () => {
      function setup() {
         const user = userEvent.setup();
         render(
            <FrameViewer
               source={new FakeFrameSource({ width: 200, height: 100 })}
               createRenderer={fakeCreateRenderer().create}
            />,
         );
         const svg = screen.getByTestId("track-overlay");
         vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
            left: 0,
            top: 0,
            width: 200,
            height: 100,
         } as DOMRect);
         fireEvent.pointerDown(svg.querySelector("rect")!, {
            button: 0,
            clientX: 50,
            clientY: 40,
         });
         const tracks = () => screen.getByRole("list", { name: "Tracks" });
         return { user, tracks };
      }

      it("adds a track on click and lists its position", () => {
         const { tracks } = setup();
         expect(tracks()).toHaveTextContent("Track 1");
         expect(tracks()).toHaveTextContent("50.00, 40.00");
      });

      it("nudges the selected track with Alt+arrows on the current frame", async () => {
         const { user, tracks } = setup();
         await user.keyboard("{ArrowRight}"); // frame 2: position is held
         expect(screen.getByText("Frame 2 / 100")).toBeInTheDocument();
         expect(tracks()).toHaveTextContent("50.00, 40.00 (held)");

         await user.keyboard("{Alt>}{ArrowRight}{ArrowDown}{/Alt}");
         expect(tracks()).toHaveTextContent("51.00, 41.00");
         expect(tracks()).toHaveTextContent("2 keys");
         await user.keyboard("{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}");
         expect(tracks()).toHaveTextContent("50.90, 41.00");
         // Nudging didn't move the playhead.
         expect(screen.getByText("Frame 2 / 100")).toBeInTheDocument();

         // Frame 1 keeps its own key.
         await user.keyboard("{ArrowLeft}");
         expect(tracks()).toHaveTextContent("50.00, 40.00");
      });

      it("deselects with Escape, after which Alt+arrows step frames again", async () => {
         const { user } = setup();
         await user.keyboard("{Escape}");
         expect(screen.queryByRole("button", { pressed: true })).toBeNull();
         await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
         expect(screen.getByText("Frame 2 / 100")).toBeInTheDocument();
      });

      it("deletes the selected track with Delete", async () => {
         const { user } = setup();
         await user.keyboard("{Delete}");
         expect(screen.queryByRole("list", { name: "Tracks" })).toBeNull();
         expect(
            screen.getByText(/click the frame to add a tracker/i),
         ).toBeInTheDocument();
      });

      it("restores a clip's tracks when it is opened again", () => {
         const source = new FakeFrameSource({ width: 200, height: 100 });
         const view = () => (
            <FrameViewer
               source={source}
               clipKey="clip-1"
               createRenderer={fakeCreateRenderer().create}
            />
         );
         const { unmount } = render(view());
         const svg = screen.getByTestId("track-overlay");
         vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
            left: 0,
            top: 0,
            width: 200,
            height: 100,
         } as DOMRect);
         fireEvent.pointerDown(svg.querySelector("rect")!, {
            button: 0,
            clientX: 12,
            clientY: 34,
         });
         unmount();

         render(view());
         expect(screen.getByRole("list", { name: "Tracks" })).toHaveTextContent(
            "12.00, 34.00",
         );
      });

      it("exports the tracks as a Blender script", async () => {
         const saveFile = vi.fn();
         const user = userEvent.setup();
         render(
            <FrameViewer
               source={
                  new FakeFrameSource({
                     width: 200,
                     height: 100,
                     frameRate: 25,
                  })
               }
               createRenderer={fakeCreateRenderer().create}
               clipName="shot.mov"
               saveFile={saveFile}
            />,
         );
         expect(
            screen.queryByRole("button", { name: "Export for Blender" }),
         ).toBeNull();
         const svg = screen.getByTestId("track-overlay");
         vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
            left: 0,
            top: 0,
            width: 200,
            height: 100,
         } as DOMRect);
         fireEvent.pointerDown(svg.querySelector("rect")!, {
            button: 0,
            clientX: 50,
            clientY: 25,
         });

         await user.click(
            screen.getByRole("button", { name: "Export for Blender" }),
         );
         await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
         const [name, script] = saveFile.mock.calls[0] as [string, string];
         expect(name).toBe("shot.tracks.py");
         const data = JSON.parse(/^DATA = (.*)$/m.exec(script)![1]) as {
            frameRate: number;
            tracks: unknown;
         };
         expect(data.frameRate).toBe(25);
         expect(data.tracks).toEqual([
            { name: "Track 1", markers: [[1, 0.25, 0.75]] },
         ]);
      });

      it("solves the camera, seeks from the path and exports it", async () => {
         const solution: Solution = {
            status: "solved",
            focal: 200,
            k1: 0,
            k2: 0,
            rms: 0.25,
            keyframes: [0, 4],
            cameras: [0, 4].map((frame) => ({
               frame,
               rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
               translation: [-frame, 0, 0],
               centre: [frame, 0, 0],
            })),
            points: [],
            outliers: [],
         };
         const solveCamera = vi.fn<SolveCamera>().mockResolvedValue(solution);
         const saveFile = vi.fn();
         render(
            <FrameViewer
               source={new FakeFrameSource({ width: 200, height: 100 })}
               createRenderer={fakeCreateRenderer().create}
               solveCamera={solveCamera}
               clipName="shot.mov"
               saveFile={saveFile}
            />,
         );
         expect(
            screen.queryByRole("button", { name: "Solve camera" }),
         ).toBeNull();
         const svg = screen.getByTestId("track-overlay");
         vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
            left: 0,
            top: 0,
            width: 200,
            height: 100,
         } as DOMRect);
         fireEvent.pointerDown(svg.querySelector("rect")!, {
            button: 0,
            clientX: 50,
            clientY: 25,
         });
         fireEvent.click(screen.getByRole("button", { name: "Solve camera" }));
         expect(solveCamera.mock.calls[0][0]).toMatchObject({
            width: 200,
            height: 100,
            tracks: [{ keys: [[0, 50, 25]] }],
         });
         expect(
            await screen.findByText(/Solved 2 of \d+ frames/),
         ).toBeInTheDocument();
         expect(screen.getByTestId("solve-overlay")).toBeInTheDocument();
         clickCamera(solution, 4);
         expect(screen.getByText(/^Frame 5 \//)).toBeInTheDocument();
         fireEvent.click(
            screen.getByRole("button", { name: "Export camera for Blender" }),
         );
         expect(saveFile).toHaveBeenCalledWith(
            "shot.camera.py",
            expect.stringContaining('"points":[]'),
         );
      });

      it("unkeys a frame from the track list", async () => {
         const { user, tracks } = setup();
         await user.keyboard("{ArrowRight}{Alt>}{ArrowRight}{/Alt}");
         expect(tracks()).toHaveTextContent("2 keys");
         await user.click(screen.getByRole("button", { name: "Unkey frame" }));
         expect(tracks()).toHaveTextContent("1 key");
         expect(tracks()).toHaveTextContent("50.00, 40.00 (held)");
      });
   });

   describe("auto-tracking", () => {
      /** Feature moves 1 px right per frame and vanishes from frame 6. */
      const scene = (frame: number) =>
         frame < 6
            ? blobScene(frame, 0)
            : renderLuma(
                 100,
                 80,
                 (x, y) => Math.sin(x * 1.7) * Math.cos(y * 2.3),
              );

      function setup(
         source = new FakeFrameSource({
            frameCount: 10,
            width: 100,
            height: 80,
         }),
         createScorer?: () => Promise<Scorer>,
      ) {
         const user = userEvent.setup();
         const view = render(
            <FrameViewer
               source={source}
               createRenderer={fakeCreateRenderer().create}
               // FakeFrameSource samples carry their index as `timestamp`.
               createLumaReader={() => (sample) => scene(sample.timestamp)}
               createScorer={createScorer}
            />,
         );
         const svg = screen.getByTestId("track-overlay");
         vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
            left: 0,
            top: 0,
            width: 100,
            height: 80,
         } as DOMRect);
         fireEvent.pointerDown(svg.querySelector("rect")!, {
            button: 0,
            clientX: 50.5,
            clientY: 42.5,
         });
         const tracks = () => screen.getByRole("list", { name: "Tracks" });
         return { user, tracks, source, view };
      }

      it("tracks the selected track forward with T until the feature is lost", async () => {
         const { user, tracks } = setup();
         await user.keyboard("t");
         await waitFor(() =>
            expect(screen.getByRole("status")).toHaveTextContent(
               /^Tracked Track 1 forward 5 frames; lost the feature \(score 0\.\d\d\)\.$/,
            ),
         );
         // The playhead follows the track, so it ends on the last tracked frame.
         expect(screen.getByText("Frame 6 / 10")).toBeInTheDocument();
         expect(tracks()).toHaveTextContent("55.50, 42.50");
         expect(tracks()).toHaveTextContent("6 keys");
      });

      it("tracks backward with Shift+T", async () => {
         const { user, tracks } = setup();
         // Re-key on frame 6, where the feature has moved 5 px.
         for (let i = 0; i < 5; i++) {
            await user.keyboard("{ArrowRight}");
         }
         await user.keyboard(
            "{Alt>}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{/Alt}",
         );
         expect(tracks()).toHaveTextContent("55.50, 42.50");
         await user.keyboard("{Shift>}T{/Shift}");
         await waitFor(() =>
            expect(screen.getByRole("status")).toHaveTextContent(
               "Tracked Track 1 backward 5 frames; reached the end of the clip.",
            ),
         );
         expect(screen.getByText("Frame 1 / 10")).toBeInTheDocument();
         expect(tracks()).toHaveTextContent("50.50, 42.50");
      });

      it("matches with the injected scorer, created once and disposed on unmount", async () => {
         const scorer: Scorer = {
            kind: "webgpu",
            scoreMap: vi.fn(scoreMap),
            dispose: vi.fn(),
         };
         const createScorer = vi.fn(async () => scorer);
         const { user, view } = setup(undefined, createScorer);

         await user.keyboard("t");
         await waitFor(() =>
            expect(screen.getByRole("status")).toHaveTextContent(/^Tracked/),
         );
         expect(screen.getByRole("status")).toHaveAttribute(
            "title",
            "Matching on WebGPU",
         );
         expect(scorer.scoreMap).toHaveBeenCalledTimes(6); // 5 tracked + the lost frame
         await user.keyboard("{Shift>}T{/Shift}");
         await waitFor(() =>
            expect(screen.getByRole("status")).toHaveTextContent(/backward/),
         );
         expect(createScorer).toHaveBeenCalledTimes(1);

         view.unmount();
         await waitFor(() => expect(scorer.dispose).toHaveBeenCalled());
      });

      it("stops with Escape and ignores other keys while tracking", async () => {
         const source = new FakeFrameSource({
            frameCount: 10,
            width: 100,
            height: 80,
         });
         const getFrame = source.getFrame.getMockImplementation()!;
         let release = () => {};
         const gate = new Promise<void>((resolve) => (release = resolve));
         source.getFrame.mockImplementation(async (index: number) => {
            if (index === 3) {
               await gate;
            }
            return getFrame(index);
         });
         const { user, tracks } = setup(source);

         await user.keyboard("t");
         await waitFor(() =>
            expect(screen.getByRole("status")).toHaveTextContent(
               "Tracking Track 1 forward: 2 frames (Escape to stop)",
            ),
         );
         await user.keyboard("{ArrowRight}{Delete}");
         expect(screen.getByText("Frame 3 / 10")).toBeInTheDocument();
         await user.keyboard("{Escape}");
         act(() => release());
         await waitFor(() =>
            expect(screen.getByRole("status")).toHaveTextContent(
               "Tracked Track 1 forward 2 frames; cancelled.",
            ),
         );
         expect(tracks()).toHaveTextContent("3 keys");
         // The track stays selected, so Escape now deselects as usual.
         await user.keyboard("{Escape}");
         expect(screen.queryByRole("button", { pressed: true })).toBeNull();
      });
   });

   describe("onion-skinning", () => {
      function setup() {
         const user = userEvent.setup();
         const { renderer, create } = fakeCreateRenderer();
         const source = new FakeFrameSource({ frameCount: 10 });
         render(<FrameViewer source={source} createRenderer={create} />);
         return { user, renderer, source };
      }

      it("is off by default and toggles with O", async () => {
         const { user, renderer, source } = setup();
         await waitFor(() => expect(renderer.layers).toHaveLength(1));
         await user.keyboard("{ArrowRight}{o}");

         await waitFor(() =>
            expect(renderer.layers.map((layer) => layer.index)).toEqual([
               1, 0, 2,
            ]),
         );
         expect(source.getFrames).toHaveBeenLastCalledWith([1, 0, 2]);
         expect(renderer.layers[0]).toMatchObject({ opacity: 1 });
         expect(renderer.layers[1]).toMatchObject({ opacity: 0.5 });
         expect(screen.getByLabelText("Onion skin (O)")).toBeChecked();

         await user.keyboard("{o}");
         await waitFor(() => expect(renderer.layers).toHaveLength(1));
      });

      it("follows the before/after settings", async () => {
         const { user, renderer } = setup();
         await user.click(screen.getByLabelText("Onion skin (O)"));
         const before = screen.getByLabelText("Before");
         await user.clear(before);
         await user.type(before, "3");
         await user.keyboard("{Escape}");
         await waitFor(() =>
            // Frame 0 has nothing before it, so only the one "after" frame.
            expect(renderer.layers.map((layer) => layer.index)).toEqual([0, 1]),
         );
      });

      it("doesn't step frames while a settings field has focus", async () => {
         const { user } = setup();
         await user.click(screen.getByLabelText("Onion skin (O)"));
         await user.click(screen.getByLabelText("After"));
         await user.keyboard("{ArrowRight}");
         expect(screen.getByText("Frame 1 / 10")).toBeInTheDocument();
      });
   });
});
