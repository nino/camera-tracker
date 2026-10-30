import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FakeFrameSource } from "../test/fake-frame-source";
import { FrameViewer } from "./FrameViewer";

describe("FrameViewer", () => {
   it("shows and fetches the first frame", async () => {
      const source = new FakeFrameSource({ frameCount: 5 });
      render(<FrameViewer source={source} />);
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

   it("draws the fetched frame at the video's display size", async () => {
      const ctx = {} as CanvasRenderingContext2D;
      const getContext = vi
         .spyOn(HTMLCanvasElement.prototype, "getContext")
         .mockReturnValue(ctx as never); // getContext is overloaded per context type
      try {
         const source = new FakeFrameSource({ width: 320, height: 180 });
         render(<FrameViewer source={source} />);
         await waitFor(() =>
            expect(source.draws).toEqual([[0, ctx, 0, 0, 320, 180]]),
         );
         const canvas = screen.getByLabelText("Current frame");
         expect(canvas).toHaveAttribute("width", "320");
         expect(canvas).toHaveAttribute("height", "180");
      } finally {
         getContext.mockRestore();
      }
   });

   it("only draws the latest frame when fetches resolve out of order", async () => {
      const ctx = {} as CanvasRenderingContext2D;
      const getContext = vi
         .spyOn(HTMLCanvasElement.prototype, "getContext")
         .mockReturnValue(ctx as never); // getContext is overloaded per context type
      try {
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
         render(<FrameViewer source={source} />);
         await user.keyboard("{ArrowRight}");
         await waitFor(() => expect(pending.size).toBe(2));

         // The newer frame lands first, then the stale one.
         await act(async () => pending.get(1)!());
         await act(async () => pending.get(0)!());
         expect(source.draws.map(([index]) => index)).toEqual([1]);
      } finally {
         getContext.mockRestore();
      }
   });

   it("shows decode errors", async () => {
      const source = new FakeFrameSource();
      source.getFrame.mockRejectedValueOnce(new Error("decoder exploded"));
      render(<FrameViewer source={source} />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
         "decoder exploded",
      );
   });
});
