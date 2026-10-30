import type { VideoSample } from "mediabunny";
import {
   create2dRenderer,
   createRenderer,
   singleLayer,
} from "./frame-renderer";

function canvas(width = 32, height = 16) {
   const el = document.createElement("canvas");
   el.width = width;
   el.height = height;
   return el;
}

describe("create2dRenderer", () => {
   it("draws the sample at the canvas size", () => {
      const ctx = {} as CanvasRenderingContext2D;
      const el = canvas();
      vi.spyOn(el, "getContext").mockReturnValue(ctx as never);
      const draw = vi.fn();
      create2dRenderer(el).draw(
         singleLayer({ draw } as unknown as VideoSample),
      );
      expect(draw).toHaveBeenCalledWith(ctx, 0, 0, 32, 16);
   });

   it("does nothing when there is no 2D context", () => {
      const draw = vi.fn();
      create2dRenderer(canvas()).draw(
         singleLayer({ draw } as unknown as VideoSample),
      );
      expect(draw).not.toHaveBeenCalled();
   });
});

describe("createRenderer", () => {
   afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
   });

   it("uses canvas 2D when the webview has no WebGPU", async () => {
      expect((await createRenderer(canvas())).kind).toBe("2d");
   });

   it("falls back to canvas 2D when WebGPU setup fails", async () => {
      vi.stubGlobal("navigator", {
         ...navigator,
         gpu: { requestAdapter: async () => null },
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect((await createRenderer(canvas())).kind).toBe("2d");
      expect(warn).toHaveBeenCalled();
   });
});
