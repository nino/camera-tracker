import type {
   CreateRenderer,
   FrameLayer,
   FrameRenderer,
} from "../gpu/frame-renderer";

/**
 * A renderer for tests. FakeFrameSource samples carry their frame index as
 * `timestamp`, so `drawn` lists the main (first-layer) frame index of each
 * draw, and `layers` the full layer list of the latest draw.
 */
export class FakeRenderer implements FrameRenderer {
   /** Resolve to simulate a lost GPU device. */
   loseDevice!: (reason: string) => void;
   readonly lost = new Promise<string>((resolve) => {
      this.loseDevice = resolve;
   });
   constructor(readonly kind: FrameRenderer["kind"] = "webgpu") {}
   readonly drawn: number[] = [];
   layers: { index: number; opacity: number; tint: FrameLayer["tint"] }[] = [];
   readonly draw = vi.fn((layers: readonly FrameLayer[]) => {
      this.drawn.push(layers[0].sample.timestamp);
      this.layers = layers.map(({ sample, opacity, tint }) => ({
         index: sample.timestamp,
         opacity,
         tint,
      }));
   });
   readonly dispose = vi.fn();
}

/** A CreateRenderer that hands out `renderer` and remembers the canvas. */
export function fakeCreateRenderer(renderer = new FakeRenderer()) {
   const create = vi.fn<CreateRenderer>(async () => renderer);
   return { renderer, create };
}
