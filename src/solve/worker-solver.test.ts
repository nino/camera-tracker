import type { SolveRequest } from "./solve-types";
import { createWorkerSolver, type SolverWorker } from "./worker-solver";

class FakeWorker implements SolverWorker {
   onmessage: ((event: MessageEvent<string>) => void) | null = null;
   onerror: ((event: ErrorEvent) => void) | null = null;
   posted: string[] = [];
   terminated = false;
   postMessage(message: string) {
      this.posted.push(message);
   }
   terminate() {
      this.terminated = true;
   }
   reply(data: unknown) {
      this.onmessage?.(
         new MessageEvent("message", { data: JSON.stringify(data) }),
      );
   }
}

const request: SolveRequest = {
   width: 640,
   height: 360,
   frameCount: 3,
   focal: 600,
   refineFocal: true,
   tracks: [],
};

function setup() {
   const workers: FakeWorker[] = [];
   const solve = createWorkerSolver(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
   });
   return { workers, solve };
}

describe("createWorkerSolver", () => {
   it("sends the request as JSON and resolves with the reply", async () => {
      const { workers, solve } = setup();
      const result = solve(request);
      expect(JSON.parse(workers[0].posted[0])).toEqual(request);
      workers[0].reply({ status: "failed", message: "nope" });
      await expect(result).resolves.toEqual({
         status: "failed",
         message: "nope",
      });
   });

   it("keeps one worker between solves", async () => {
      const { workers, solve } = setup();
      const first = solve(request);
      workers[0].reply({ status: "failed", message: "1" });
      await first;
      const second = solve(request);
      workers[0].reply({ status: "failed", message: "2" });
      await second;
      expect(workers).toHaveLength(1);
      expect(workers[0].posted).toHaveLength(2);
   });

   it("terminates the worker on abort, and starts a new one next time", async () => {
      const { workers, solve } = setup();
      const controller = new AbortController();
      const result = solve(request, controller.signal);
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(workers[0].terminated).toBe(true);
      void solve(request);
      expect(workers).toHaveLength(2);
   });

   it("rejects at once if already aborted", async () => {
      const { workers, solve } = setup();
      const controller = new AbortController();
      controller.abort();
      await expect(solve(request, controller.signal)).rejects.toMatchObject({
         name: "AbortError",
      });
      expect(workers).toHaveLength(0);
   });

   it("cancels a running solve when another starts", async () => {
      const { workers, solve } = setup();
      const first = solve(request);
      const second = solve(request);
      await expect(first).rejects.toMatchObject({ name: "AbortError" });
      workers[1].reply({ status: "failed", message: "second" });
      await expect(second).resolves.toMatchObject({ message: "second" });
   });

   it("rejects if the worker can't start", async () => {
      const { workers, solve } = setup();
      const result = solve(request);
      workers[0].onerror?.(
         new ErrorEvent("error", { message: "script failed" }),
      );
      await expect(result).rejects.toThrow("script failed");
      expect(workers[0].terminated).toBe(true);
   });
});
