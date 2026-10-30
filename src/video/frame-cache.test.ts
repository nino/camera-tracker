import { FrameCache } from "./frame-cache";

class Value {
   closed = false;
   constructor(readonly name: string) {}
   close() {
      if (this.closed) {
         throw new Error(`${this.name} closed twice`);
      }
      this.closed = true;
   }
}

function keys(cache: FrameCache<Value>, candidates: number[]) {
   return candidates.filter((key) => cache.has(key));
}

describe("FrameCache", () => {
   it("rejects a non-positive capacity", () => {
      expect(() => new FrameCache(0)).toThrow();
      expect(() => new FrameCache(1.5)).toThrow();
   });

   it("evicts and closes the least recently used value", () => {
      const cache = new FrameCache<Value>(2);
      const a = new Value("a");
      const b = new Value("b");
      const c = new Value("c");
      cache.set(0, a);
      cache.set(1, b);
      cache.get(0); // 0 is now more recent than 1
      cache.set(2, c);

      expect(keys(cache, [0, 1, 2])).toEqual([0, 2]);
      expect(b.closed).toBe(true);
      expect(a.closed).toBe(false);
      expect(c.closed).toBe(false);
   });

   it("closes a value that is replaced under the same key", () => {
      const cache = new FrameCache<Value>(2);
      const old = new Value("old");
      cache.set(0, old);
      cache.set(0, new Value("new"));
      expect(old.closed).toBe(true);
      expect(cache.size).toBe(1);
   });

   it("does not close a value re-set under its own key", () => {
      const cache = new FrameCache<Value>(2);
      const a = new Value("a");
      cache.set(0, a);
      cache.set(0, a);
      expect(a.closed).toBe(false);
   });

   it("never evicts pinned entries, even past capacity", () => {
      const cache = new FrameCache<Value>(2);
      const values = [0, 1, 2].map((i) => new Value(String(i)));
      values.forEach((_, i) => cache.pin(i));
      values.forEach((value, i) => cache.set(i, value));

      expect(cache.size).toBe(3);
      expect(values.some((value) => value.closed)).toBe(false);

      // Once unpinned, the next insert shrinks the cache back to capacity.
      values.forEach((_, i) => cache.unpin(i));
      cache.set(3, new Value("3"));
      expect(keys(cache, [0, 1, 2, 3])).toEqual([2, 3]);
      expect(values[0].closed && values[1].closed).toBe(true);
   });

   it("counts pins, so a key stays pinned until every pin is released", () => {
      const cache = new FrameCache<Value>(1);
      const a = new Value("a");
      cache.pin(0);
      cache.pin(0);
      cache.set(0, a);
      cache.unpin(0);
      cache.set(1, new Value("b"));
      expect(cache.has(0)).toBe(true);

      cache.unpin(0);
      cache.set(2, new Value("c"));
      expect(cache.has(0)).toBe(false);
      expect(a.closed).toBe(true);
   });

   it("clear() closes everything", () => {
      const cache = new FrameCache<Value>(4);
      const values = [new Value("a"), new Value("b")];
      values.forEach((value, i) => cache.set(i, value));
      cache.clear();
      expect(cache.size).toBe(0);
      expect(values.every((value) => value.closed)).toBe(true);
   });
});
