import { downloadText } from "./download";

describe("downloadText", () => {
   afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
   });

   it("clicks a temporary download link and then revokes its URL", () => {
      vi.useFakeTimers();
      const create = vi.fn((blob: Blob) => {
         expect(blob.type).toBe("text/x-python");
         return "blob:test";
      });
      const revoke = vi.fn();
      Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
      const click = vi
         .spyOn(HTMLAnchorElement.prototype, "click")
         .mockImplementation(function (this: HTMLAnchorElement) {
            expect(this.download).toBe("a.py");
            expect(this.href).toBe("blob:test");
            expect(this.isConnected).toBe(true);
         });

      downloadText("a.py", "print(1)", "text/x-python");
      expect(click).toHaveBeenCalledTimes(1);
      expect(document.querySelector("a")).toBeNull();
      expect(revoke).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledWith("blob:test");
   });
});
