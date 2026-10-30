/**
 * Runs solves off the main thread: a solve takes seconds, and the UI should
 * stay responsive (and cancellable) meanwhile. Each message is a request JSON
 * string; each reply is a response JSON string.
 *
 * The .wasm is built by `bun run build:solver` (run by `dev` and `build`).
 */
import wasmUrl from "../../solver/target/wasm32-unknown-unknown/release/solver.wasm?url";
import {
   instantiateSolver,
   wasmSolve,
   type SolverExports,
} from "./wasm-solver";

let solver: Promise<SolverExports> | null = null;

async function load(): Promise<SolverExports> {
   const response = await fetch(wasmUrl);
   if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
   }
   return instantiateSolver(await response.arrayBuffer());
}

self.onmessage = async (event: MessageEvent<string>) => {
   let reply: string;
   try {
      solver ??= load();
      reply = wasmSolve(await solver, event.data);
   } catch (err) {
      solver = null;
      const message = err instanceof Error ? err.message : String(err);
      reply = JSON.stringify({
         status: "failed",
         message: `The solver failed: ${message}`,
      });
   }
   self.postMessage(reply);
};
