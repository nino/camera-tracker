import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { TrackOverlay } from "./TrackOverlay";
import {
   initialTrackState,
   tracksReducer,
   type TrackAction,
   type TrackState,
} from "./tracks";

/** Renders the overlay with live reducer state, shown at half size at (10, 20). */
function setup(frame = 0, initial: TrackState = initialTrackState) {
   const actions: TrackAction[] = [];
   function Harness() {
      const [state, dispatch] = React.useReducer(tracksReducer, initial);
      return (
         <TrackOverlay
            width={200}
            height={100}
            frame={frame}
            state={state}
            dispatch={(action) => {
               actions.push(action);
               dispatch(action);
            }}
         />
      );
   }
   render(<Harness />);
   const svg = screen.getByTestId("track-overlay");
   vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 10,
      top: 20,
      width: 100,
      height: 50,
   } as DOMRect);
   const background = svg.querySelector("rect")!;
   return { actions, svg, background };
}

describe("TrackOverlay", () => {
   it("adds a track where you click, in display pixels", () => {
      const { actions, background } = setup(4);
      fireEvent.pointerDown(background, {
         button: 0,
         clientX: 60,
         clientY: 45,
      });
      expect(actions).toEqual([
         { type: "add", frame: 4, point: { x: 100, y: 50 } },
      ]);
      expect(
         screen.getByRole("button", { name: "Track 1", pressed: true }),
      ).toBeInTheDocument();
   });

   it("ignores non-primary buttons", () => {
      const { actions, background } = setup();
      fireEvent.pointerDown(background, {
         button: 2,
         clientX: 60,
         clientY: 45,
      });
      expect(actions).toEqual([]);
   });

   it("drags a marker, keeping the grab offset, and keys the current frame", () => {
      const initial = tracksReducer(initialTrackState, {
         type: "add",
         frame: 0,
         point: { x: 100, y: 50 },
      });
      const { actions, svg } = setup(3, initial);
      const marker = screen.getByRole("button", { name: "Track 1 (held)" });

      // Grab 1 display px right of centre (0.5 screen px at half size).
      fireEvent.pointerDown(marker, { button: 0, clientX: 60.5, clientY: 45 });
      fireEvent.pointerMove(svg, { clientX: 70.5, clientY: 50 });
      fireEvent.pointerUp(svg);
      fireEvent.pointerMove(svg, { clientX: 99, clientY: 99 }); // after release: ignored

      expect(actions).toEqual([
         { type: "select", id: 1 },
         { type: "move", id: 1, frame: 3, point: { x: 120, y: 60 } },
      ]);
      expect(
         screen.getByRole("button", { name: "Track 1", pressed: true }),
      ).toBeInTheDocument();
   });

   it("draws held positions differently from keyed ones", () => {
      const initial = tracksReducer(initialTrackState, {
         type: "add",
         frame: 5,
         point: { x: 1, y: 1 },
      });
      setup(6, initial);
      expect(
         screen.getByRole("button", { name: "Track 1 (held)" }),
      ).toHaveClass("held");
   });
});
