import { act, fireEvent, render, screen } from "@testing-library/react";
import {
   initialTrackState,
   tracksReducer,
   type TrackState,
} from "../tracking/tracks";
import { clickCamera } from "../test/click-camera";
import { SolvePanel } from "./SolvePanel";
import type {
   Solution,
   SolveCamera,
   SolveRequest,
   SolveResponse,
} from "./solve-types";

function someTracks(): TrackState {
   let state = initialTrackState;
   for (let i = 0; i < 3; i++) {
      state = tracksReducer(state, {
         type: "add",
         frame: 0,
         point: { x: 10 * i, y: 5 },
      });
   }
   return state;
}

const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const solved: Solution = {
   status: "solved",
   focal: 640,
   rms: 0.4321,
   keyframes: [0, 2],
   cameras: [0, 1, 2].map((frame) => ({
      frame,
      rotation: identity,
      translation: [-frame, 0, 0],
      centre: [frame, 0, 0],
   })),
   points: [
      { id: 1, position: [0, 0, 5], error: 0.3 },
      { id: 2, position: [1, 0, 5], error: 0.5 },
   ],
   outliers: [[3, 1]],
};

/** A SolveCamera whose solves finish when the test says. */
function controlledSolver() {
   const calls: {
      request: SolveRequest;
      signal?: AbortSignal;
      resolve: (r: SolveResponse) => void;
      reject: (e: unknown) => void;
   }[] = [];
   const solve: SolveCamera = (request, signal) =>
      new Promise((resolve, reject) => {
         calls.push({ request, signal, resolve, reject });
         signal?.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
         );
      });
   return { calls, solve };
}

function renderPanel(
   solve: SolveCamera,
   props: Partial<React.ComponentProps<typeof SolvePanel>> = {},
) {
   const onSeek = vi.fn();
   const tracks = props.tracks ?? someTracks();
   const utils = render(
      <SolvePanel
         tracks={tracks}
         width={640}
         height={360}
         frameCount={4}
         frame={1}
         onSeek={onSeek}
         solveCamera={solve}
         {...props}
      />,
   );
   return { ...utils, onSeek, tracks };
}

describe("SolvePanel", () => {
   it("sends the tracks with the focal guess in pixels", () => {
      const { calls, solve } = controlledSolver();
      renderPanel(solve);
      fireEvent.change(screen.getByLabelText(/Focal length guess/), {
         target: { value: "18" },
      });
      fireEvent.click(screen.getByLabelText("Refine focal length"));
      fireEvent.click(screen.getByRole("button", { name: "Solve camera" }));
      expect(calls).toHaveLength(1);
      expect(calls[0].request).toMatchObject({
         width: 640,
         frameCount: 4,
         focal: 320,
         refineFocal: false,
      });
      expect(calls[0].request.tracks).toHaveLength(3);
      expect(screen.getByRole("status")).toHaveTextContent("Solving…");
   });

   it("shows the error, focal, coverage and outliers of a solve", async () => {
      const { calls, solve } = controlledSolver();
      renderPanel(solve);
      fireEvent.click(screen.getByRole("button", { name: "Solve camera" }));
      await act(async () => calls[0].resolve(solved));
      expect(screen.getByRole("status")).toHaveTextContent(
         "Solved 3 of 4 frames · error 0.43 px · focal 36.0 mm (640 px) · 2 of 3 tracks · 1 outlier key",
      );
      expect(
         screen.getByRole("img", { name: "Camera path, top view" }),
      ).toBeInTheDocument();
   });

   it("seeks to a camera's frame when it's clicked in the path", async () => {
      const { calls, solve } = controlledSolver();
      const { onSeek } = renderPanel(solve);
      fireEvent.click(screen.getByRole("button", { name: "Solve camera" }));
      await act(async () => calls[0].resolve(solved));
      clickCamera(solved, 2);
      expect(onSeek).toHaveBeenCalledWith(2);
      expect(screen.getByTestId("current-camera")).toBeInTheDocument();
   });

   it("shows why a solve failed", async () => {
      const { calls, solve } = controlledSolver();
      renderPanel(solve);
      fireEvent.click(screen.getByRole("button", { name: "Solve camera" }));
      await act(async () =>
         calls[0].resolve({ status: "failed", message: "Too few tracks." }),
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
         "Solve failed: Too few tracks.",
      );
   });

   it("reports a solver that throws", async () => {
      const { calls, solve } = controlledSolver();
      renderPanel(solve);
      fireEvent.click(screen.getByRole("button", { name: "Solve camera" }));
      await act(async () => calls[0].reject(new Error("worker died")));
      expect(screen.getByRole("alert")).toHaveTextContent("worker died");
   });

   it("cancels a running solve", async () => {
      const { calls, solve } = controlledSolver();
      renderPanel(solve);
      fireEvent.click(screen.getByRole("button", { name: "Solve camera" }));
      await act(async () =>
         fireEvent.click(screen.getByRole("button", { name: "Cancel solve" })),
      );
      expect(calls[0].signal?.aborted).toBe(true);
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
         screen.getByRole("button", { name: "Solve camera" }),
      ).toBeInTheDocument();
   });

   it("cancels the solve when it unmounts", () => {
      const { calls, solve } = controlledSolver();
      const { unmount } = renderPanel(solve);
      fireEvent.click(screen.getByRole("button", { name: "Solve camera" }));
      unmount();
      expect(calls[0].signal?.aborted).toBe(true);
   });

   it("says when the tracks have changed since the solve", async () => {
      const { calls, solve } = controlledSolver();
      const { rerender, tracks } = renderPanel(solve);
      fireEvent.click(screen.getByRole("button", { name: "Solve camera" }));
      await act(async () => calls[0].resolve(solved));
      expect(screen.queryByText(/changed since/)).toBeNull();
      const moved = tracksReducer(tracks, {
         type: "nudge",
         id: tracks.tracks[0].id,
         frame: 0,
         dx: 1,
         dy: 0,
      });
      rerender(
         <SolvePanel
            tracks={moved}
            width={640}
            height={360}
            frameCount={4}
            frame={1}
            onSeek={() => {}}
            solveCamera={solve}
         />,
      );
      expect(screen.getByText(/changed since this solve/)).toBeInTheDocument();
   });

   it("needs a focal length guess", () => {
      const { solve } = controlledSolver();
      renderPanel(solve);
      fireEvent.change(screen.getByLabelText(/Focal length guess/), {
         target: { value: "" },
      });
      expect(
         screen.getByRole("button", { name: "Solve camera" }),
      ).toBeDisabled();
   });

   it("exports a solve", async () => {
      const { calls, solve } = controlledSolver();
      const onExport = vi.fn();
      renderPanel(solve, { onExport });
      fireEvent.click(screen.getByRole("button", { name: "Solve camera" }));
      await act(async () => calls[0].resolve(solved));
      fireEvent.click(
         screen.getByRole("button", { name: "Export camera for Blender" }),
      );
      expect(onExport).toHaveBeenCalledWith(solved);
   });

   it("lists the worst tracks and selects one", async () => {
      const { calls, solve } = controlledSolver();
      const onSelectTrack = vi.fn();
      const onSolution = vi.fn();
      const { tracks } = renderPanel(solve, { onSelectTrack, onSolution });
      fireEvent.click(screen.getByRole("button", { name: "Solve camera" }));
      await act(async () => calls[0].resolve(solved));
      expect(onSolution).toHaveBeenCalledWith(solved);
      const list = screen.getByRole("list", { name: "Worst tracks" });
      const name = tracks.tracks.find((t) => t.id === 2)!.name;
      expect(list.firstElementChild).toHaveTextContent(`${name} (0.50 px)`);
      fireEvent.click(
         screen.getByRole("button", { name: `${name} (0.50 px)` }),
      );
      expect(onSelectTrack).toHaveBeenCalledWith(2);
   });

   it("clears the solution when a solve fails", async () => {
      const { calls, solve } = controlledSolver();
      const onSolution = vi.fn();
      renderPanel(solve, { onSolution });
      fireEvent.click(screen.getByRole("button", { name: "Solve camera" }));
      await act(async () =>
         calls[0].resolve({ status: "failed", message: "no" }),
      );
      expect(onSolution).toHaveBeenCalledWith(null);
   });
});
