import { blobScene } from "../test/synthetic-scene";
import {
   extractPatch,
   normalise,
   scoreMap,
   type LumaImage,
} from "../tracking/match";
import { createScorer, cropPixels, searchCrop } from "./score-map";

describe("searchCrop", () => {
   it("covers every pixel the search can sample", () => {
      const img = blobScene(0, 0);
      const pattern = normalise(extractPatch(img, 50.5, 42.5, 21))!;
      const cases: [number, number, number, number][] = [
         [50.5, 42.5, 6, 21],
         [51.25, 41.75, 10, 15],
         [3.2, 77.9, 8, 21], // clamped at the bottom-left
         [97.6, 1.1, 8, 9], // clamped at the top-right
      ];
      for (const [cx, cy, radius, size] of cases) {
         const crop = searchCrop(img, cx, cy, radius, size);
         // Poison everything outside the crop: a read there would give NaN.
         const poisoned = new Float32Array(img.data.length).fill(NaN);
         const pixels = cropPixels(img, crop);
         for (let j = 0; j < crop.height; j++) {
            poisoned.set(
               pixels.subarray(j * crop.width, (j + 1) * crop.width),
               (crop.y + j) * img.width + crop.x,
            );
         }
         const masked: LumaImage = { ...img, data: poisoned };
         const p =
            size === 21
               ? pattern
               : normalise(extractPatch(img, 50.5, 42.5, size))!;
         expect(scoreMap(p, size, masked, cx, cy, radius)).toEqual(
            scoreMap(p, size, img, cx, cy, radius),
         );
      }
   });

   it("stays inside the image", () => {
      const crop = searchCrop({ width: 100, height: 80 }, 2, 79, 24, 21);
      expect(crop.x).toBe(0);
      expect(crop.y + crop.height).toBe(80);
      expect(crop.x + crop.width).toBeLessThanOrEqual(100);
   });
});

describe("cropPixels", () => {
   it("copies the rectangle row by row", () => {
      const img: LumaImage = {
         width: 4,
         height: 3,
         data: Float32Array.from({ length: 12 }, (_, i) => i),
      };
      expect([...cropPixels(img, { x: 1, y: 1, width: 2, height: 2 })]).toEqual(
         [5, 6, 9, 10],
      );
   });
});

describe("createScorer", () => {
   const img = blobScene(1.5, -0.5);
   const pattern = normalise(extractPatch(blobScene(0, 0), 50.5, 42.5, 21))!;
   const args = [pattern, 21, img, 50.5, 42.5, 4] as const;

   afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
   });

   it("uses the CPU without WebGPU", async () => {
      const scorer = await createScorer();
      expect(scorer.kind).toBe("cpu");
      expect(await scorer.scoreMap(...args)).toEqual(scoreMap(...args));
   });

   it("uses the CPU when there is no adapter or no device", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal("navigator", { gpu: { requestAdapter: async () => null } });
      expect((await createScorer()).kind).toBe("cpu");
      vi.stubGlobal("navigator", {
         gpu: {
            requestAdapter: async () => ({
               requestDevice: () => Promise.reject(new Error("no device")),
            }),
         },
      });
      expect((await createScorer()).kind).toBe("cpu");
   });

   it("switches to the CPU for good when the GPU fails mid-run", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubGlobal("GPUBufferUsage", {
         STORAGE: 1,
         COPY_DST: 2,
         COPY_SRC: 4,
         MAP_READ: 8,
         UNIFORM: 16,
      });
      vi.stubGlobal("GPUMapMode", { READ: 1 });
      const destroy = vi.fn();
      const device = {
         createShaderModule: () => ({}),
         createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
         createBuffer: ({ size }: { size: number }) => ({
            size,
            destroy,
            mapAsync: () => Promise.reject(new Error("device lost")),
         }),
         createBindGroup: () => ({}),
         createCommandEncoder: () => ({
            beginComputePass: () => ({
               setPipeline() {},
               setBindGroup() {},
               dispatchWorkgroups() {},
               end() {},
            }),
            copyBufferToBuffer() {},
            finish: () => ({}),
         }),
         queue: { writeBuffer() {}, submit() {} },
         destroy: vi.fn(),
      };
      vi.stubGlobal("navigator", {
         gpu: {
            requestAdapter: async () => ({ requestDevice: async () => device }),
         },
      });

      const scorer = await createScorer();
      expect(scorer.kind).toBe("webgpu");
      expect(await scorer.scoreMap(...args)).toEqual(scoreMap(...args));
      expect(scorer.kind).toBe("cpu");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalled(); // GPU buffers released
      await scorer.scoreMap(...args);
      expect(warn).toHaveBeenCalledTimes(1); // didn't try the GPU again
      scorer.dispose();
      expect(device.destroy).toHaveBeenCalled();
   });
});
