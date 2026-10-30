import { wasmSolve, type SolverExports } from "./wasm-solver";

/**
 * A stand-in for the WebAssembly module with the same ABI: a bump
 * allocator over real WebAssembly memory, and a `solve` that upper-cases
 * the request. It grows memory during `solve`, as the real one can, which
 * detaches any view made before the call.
 */
function fakeSolver() {
   const memory = new WebAssembly.Memory({ initial: 1 });
   let next = 8;
   const live = new Map<number, number>();
   const alloc = (len: number) => {
      const ptr = next;
      next += len + 8;
      live.set(ptr, len);
      return ptr;
   };
   const exports: SolverExports = {
      memory,
      alloc,
      dealloc(ptr, len) {
         expect(live.get(ptr)).toBe(len);
         live.delete(ptr);
      },
      solve(ptr, len) {
         const request = new TextDecoder().decode(
            new Uint8Array(memory.buffer, ptr, len),
         );
         memory.grow(1);
         const out = new TextEncoder().encode(request.toUpperCase());
         const outPtr = alloc(out.length);
         new Uint8Array(memory.buffer, outPtr, out.length).set(out);
         const header = alloc(8);
         const view = new DataView(memory.buffer);
         view.setUint32(header, outPtr, true);
         view.setUint32(header + 4, out.length, true);
         return header;
      },
   };
   return { exports, live };
}

describe("wasmSolve", () => {
   it("passes the request in and the response out as UTF-8", () => {
      const { exports } = fakeSolver();
      expect(wasmSolve(exports, '{"name":"café"}')).toBe('{"NAME":"CAFÉ"}');
   });

   it("frees the request, the response and the header", () => {
      const { exports, live } = fakeSolver();
      wasmSolve(exports, "x".repeat(1000));
      wasmSolve(exports, "");
      expect(live.size).toBe(0);
   });
});
