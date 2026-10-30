export interface Closeable {
   close(): void;
}

/**
 * A least-recently-used cache of closeable values (decoded frames) keyed by
 * frame index. The cache owns its values: it closes them when they are evicted
 * or when the cache is cleared.
 *
 * Keys can be pinned. A pinned entry is never evicted, so a batch of frames
 * that must all be valid at once (onion-skinning) can't evict itself. While
 * pinned entries hold it full, the cache may grow past its capacity; it shrinks
 * back on the next insert after they are unpinned.
 */
export class FrameCache<T extends Closeable> {
   /** Map iteration order is insertion order; we re-insert on access, so the first entry is the least recently used. */
   private readonly entries = new Map<number, T>();
   private readonly pins = new Map<number, number>();

   constructor(readonly capacity: number) {
      if (!Number.isInteger(capacity) || capacity < 1) {
         throw new Error(
            `Cache capacity must be a positive integer, got ${capacity}.`,
         );
      }
   }

   get size(): number {
      return this.entries.size;
   }

   has(key: number): boolean {
      return this.entries.has(key);
   }

   /** Returns the value and marks it most recently used. */
   get(key: number): T | undefined {
      const value = this.entries.get(key);
      if (value !== undefined) {
         this.entries.delete(key);
         this.entries.set(key, value);
      }
      return value;
   }

   /** Inserts a value (closing any value it replaces), then evicts down to capacity. */
   set(key: number, value: T): void {
      const previous = this.entries.get(key);
      if (previous !== undefined && previous !== value) {
         previous.close();
      }
      this.entries.delete(key);
      this.entries.set(key, value);
      this.evict();
   }

   /** Pins a key, present or not yet inserted. Pins are counted; each needs an unpin. */
   pin(key: number): void {
      this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
   }

   unpin(key: number): void {
      const count = this.pins.get(key) ?? 0;
      if (count <= 1) {
         this.pins.delete(key);
      } else {
         this.pins.set(key, count - 1);
      }
   }

   /** Closes and removes every value. Pins are kept. */
   clear(): void {
      for (const value of this.entries.values()) {
         value.close();
      }
      this.entries.clear();
   }

   private evict(): void {
      if (this.entries.size <= this.capacity) {
         return;
      }
      for (const [key, value] of this.entries) {
         if (this.entries.size <= this.capacity) {
            return;
         }
         if (this.pins.has(key)) {
            continue;
         }
         this.entries.delete(key);
         value.close();
      }
   }
}
