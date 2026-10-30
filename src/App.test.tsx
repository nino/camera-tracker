import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { FakeFrameSource } from "./test/fake-frame-source";
import type { FrameSource } from "./video/frame-source";

function videoFile(name = "clip.mp4") {
   return new File(["not really a video"], name, { type: "video/mp4" });
}

describe("App", () => {
   it("asks for a video when nothing is loaded", () => {
      render(<App openSource={vi.fn()} />);
      expect(screen.getByText(/drop a video file here/i)).toBeInTheDocument();
   });

   it("opens a picked file and shows its first frame", async () => {
      const user = userEvent.setup();
      const source = new FakeFrameSource({ frameCount: 12 });
      const openSource = vi.fn(async () => source);
      render(<App openSource={openSource} />);

      const file = videoFile();
      await user.upload(screen.getByLabelText("Open video"), file);

      expect(openSource).toHaveBeenCalledWith(file);
      expect(await screen.findByText("Frame 1 / 12")).toBeInTheDocument();
      expect(screen.getByText("clip.mp4")).toBeInTheDocument();
   });

   it("opens a dropped file", async () => {
      const source = new FakeFrameSource({ frameCount: 7 });
      render(<App openSource={async () => source} />);

      fireEvent.drop(screen.getByTestId("drop-zone"), {
         dataTransfer: { files: [videoFile()] },
      });

      expect(await screen.findByText("Frame 1 / 7")).toBeInTheDocument();
   });

   it("shows an error when the file can't be opened", async () => {
      const user = userEvent.setup();
      const openSource = vi.fn(async (): Promise<FrameSource> => {
         throw new Error("This file has no video track.");
      });
      render(<App openSource={openSource} />);

      await user.upload(screen.getByLabelText("Open video"), videoFile());

      expect(await screen.findByRole("alert")).toHaveTextContent(
         "no video track",
      );
   });

   it("disposes the old source when a new file is opened, and resets to frame 1", async () => {
      const user = userEvent.setup();
      const first = new FakeFrameSource({ frameCount: 10 });
      const second = new FakeFrameSource({ frameCount: 20 });
      const openSource = vi
         .fn<(file: File) => Promise<FrameSource>>()
         .mockResolvedValueOnce(first)
         .mockResolvedValueOnce(second);
      render(<App openSource={openSource} />);

      await user.upload(
         screen.getByLabelText("Open video"),
         videoFile("a.mp4"),
      );
      await screen.findByText("Frame 1 / 10");
      await user.keyboard("{ArrowRight}");
      expect(screen.getByText("Frame 2 / 10")).toBeInTheDocument();

      await user.upload(
         screen.getByLabelText("Open video"),
         videoFile("b.mp4"),
      );
      expect(await screen.findByText("Frame 1 / 20")).toBeInTheDocument();
      expect(first.dispose).toHaveBeenCalledOnce();
      expect(second.dispose).not.toHaveBeenCalled();
   });

   it("disposes the source on unmount", async () => {
      const user = userEvent.setup();
      const source = new FakeFrameSource();
      const { unmount } = render(<App openSource={async () => source} />);
      await user.upload(screen.getByLabelText("Open video"), videoFile());
      await screen.findByText(/^Frame 1 \//);

      unmount();
      await waitFor(() => expect(source.dispose).toHaveBeenCalledOnce());
   });
});
