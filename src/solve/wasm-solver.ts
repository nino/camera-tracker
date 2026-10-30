/**
 * Calls the WebAssembly build of the solver (solver/src/wasm.rs). The module
 * exports a plain C ABI rather than wasm-bindgen glue, so this file is the
 * whole binding:
 *
 * 1. `alloc(len)` a buffer and write the UTF-8 request JSON into it;
 * 2. `solve(ptr, len)` returns a pointer to an 8-byte header: the response's
 *    pointer and length, u32 little-endian;
 * 3. read the response, then `dealloc` the request, response and header.
 *
 * `memory.buffer` is replaced whenever the module grows its memory, so views
 * are made fresh after each call, never kept.
 */

export interface SolverExports {
   readonly memory: WebAssembly.Memory;
   alloc(len: number): number;
   dealloc(ptr: number, len: number): void;
   solve(ptr: number, len: number): number;
}

export function wasmSolve(solver: SolverExports, request: string): string {
   const input = new TextEncoder().encode(request);
   const inPtr = solver.alloc(input.length);
   new Uint8Array(solver.memory.buffer, inPtr, input.length).set(input);
   const header = solver.solve(inPtr, input.length);
   const view = new DataView(solver.memory.buffer);
   const outPtr = view.getUint32(header, true);
   const outLen = view.getUint32(header + 4, true);
   const output = new TextDecoder().decode(
      new Uint8Array(solver.memory.buffer, outPtr, outLen),
   );
   solver.dealloc(inPtr, input.length);
   solver.dealloc(outPtr, outLen);
   solver.dealloc(header, 8);
   return output;
}

export async function instantiateSolver(
   bytes: BufferSource,
): Promise<SolverExports> {
   const { instance } = await WebAssembly.instantiate(bytes, {});
   return instance.exports as unknown as SolverExports;
}
