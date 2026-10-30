import type { VideoSample } from "mediabunny";
import type { CreateRenderer, FrameRenderer } from "../gpu/frame-renderer";

/**
 * A renderer for tests. FakeFrameSource samples carry their frame index as
 * `timestamp`, so `drawn` lists the frame indices drawn, in order.
 */
export class FakeRenderer implements FrameRenderer {
   /** Resolve to simulate a lost GPU device. */
   loseDevice!: (reason: string) => void;
   readonly lost = new Promise<string>((resolve) => {
      this.loseDevice = resolve;
   });
   constructor(readonly kind: FrameRenderer["kind"] = "webgpu") {}
   readonly drawn: number[] = [];
   readonly draw = vi.fn((sample: VideoSample) => {
      this.drawn.push(sample.timestamp);
   });
   readonly dispose = vi.fn();
}

/** A CreateRenderer that hands out `renderer` and remembers the canvas. */
export function fakeCreateRenderer(renderer = new FakeRenderer()) {
   const create = vi.fn<CreateRenderer>(async () => renderer);
   return { renderer, create };
}
