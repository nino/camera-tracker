import type { SolveCamera, SolveResponse } from "./solve-types";

/** The parts of `Worker` the solver uses, so tests can pass a fake. */
export interface SolverWorker {
   onmessage: ((event: MessageEvent<string>) => void) | null;
   onerror: ((event: ErrorEvent) => void) | null;
   postMessage(message: string): void;
   terminate(): void;
}

function defaultWorker(): SolverWorker {
   return new Worker(new URL("./solve-worker.ts", import.meta.url), {
      type: "module",
   });
}

/**
 * A SolveCamera that runs in a Web Worker. The worker (and the loaded
 * solver) is kept between solves. The solver can't be interrupted, so
 * cancelling terminates the worker and the next solve starts a new one.
 * Starting a solve while one runs cancels the first.
 */
export function createWorkerSolver(
   makeWorker: () => SolverWorker = defaultWorker,
): SolveCamera {
   let worker: SolverWorker | null = null;
   let cancelRunning: (() => void) | null = null;

   return (request, signal) =>
      new Promise<SolveResponse>((resolve, reject) => {
         cancelRunning?.();
         const abortError = () =>
            new DOMException("The solve was cancelled.", "AbortError");
         if (signal?.aborted) {
            reject(abortError());
            return;
         }
         const w = (worker ??= makeWorker());
         const finish = () => {
            signal?.removeEventListener("abort", onAbort);
            w.onmessage = null;
            w.onerror = null;
            cancelRunning = null;
         };
         const cancel = () => {
            finish();
            w.terminate();
            if (worker === w) {
               worker = null;
            }
            reject(abortError());
         };
         const onAbort = () => cancel();
         cancelRunning = cancel;
         signal?.addEventListener("abort", onAbort);
         w.onmessage = (event) => {
            finish();
            try {
               resolve(JSON.parse(event.data) as SolveResponse);
            } catch (err) {
               reject(err instanceof Error ? err : new Error(String(err)));
            }
         };
         w.onerror = (event) => {
            finish();
            w.terminate();
            if (worker === w) {
               worker = null;
            }
            reject(new Error(`The solver couldn’t start: ${event.message}`));
         };
         w.postMessage(JSON.stringify(request));
      });
}
