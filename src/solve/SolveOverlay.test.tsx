import { render, screen } from "@testing-library/react";
import { initialTrackState, tracksReducer } from "../tracking/tracks";
import { SolveOverlay } from "./SolveOverlay";
import type { Solution } from "./solve-types";

const solution: Solution = {
   status: "solved",
   focal: 100,
   k1: 0,
   k2: 0,
   rms: 0,
   keyframes: [0, 1],
   cameras: [
      {
         frame: 0,
         rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
         translation: [0, 0, 0],
         centre: [0, 0, 0],
      },
   ],
   points: [
      { id: 1, position: [0, 0, 10], error: 0.1 },
      { id: 2, position: [1, 0, 10], error: 4 },
   ],
   outliers: [],
};

function tracks() {
   // Track 1 keyed at its reprojection (320, 180); track 2 keyed 5 px off.
   let state = tracksReducer(initialTrackState, {
      type: "add",
      frame: 0,
      point: { x: 320, y: 180 },
   });
   state = tracksReducer(state, {
      type: "add",
      frame: 0,
      point: { x: 325, y: 180 },
   });
   return state;
}

describe("SolveOverlay", () => {
   it("marks each solved point and flags large residuals", () => {
      render(
         <SolveOverlay
            solution={solution}
            tracks={tracks()}
            width={640}
            height={360}
            frame={0}
         />,
      );
      const overlay = screen.getByTestId("solve-overlay");
      const good = overlay.querySelector('[data-track="1"]')!;
      const bad = overlay.querySelector('[data-track="2"]')!;
      expect(good).not.toHaveClass("bad");
      expect(good.querySelector("circle")).toHaveAttribute("cx", "320");
      expect(bad).toHaveClass("bad");
      // Residual line from the key to the reprojection.
      expect(bad.querySelector("line")).toHaveAttribute("x1", "325");
      expect(bad.querySelector("line")).toHaveAttribute("x2", "330");
   });

   it("draws no residual where the track isn't keyed", () => {
      render(
         <SolveOverlay
            solution={{
               ...solution,
               cameras: [{ ...solution.cameras[0], frame: 1 }],
            }}
            tracks={tracks()}
            width={640}
            height={360}
            frame={1}
         />,
      );
      const overlay = screen.getByTestId("solve-overlay");
      expect(overlay.querySelectorAll("circle")).toHaveLength(2);
      expect(overlay.querySelectorAll("line")).toHaveLength(0);
   });
});
