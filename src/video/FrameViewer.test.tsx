import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FakeFrameSource } from "../test/fake-frame-source";
import { FakeRenderer, fakeCreateRenderer } from "../test/fake-renderer";
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
});
