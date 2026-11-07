// @vitest-environment happy-dom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { lazyPart, lazyParts } from "./lazy-part";

describe("lazyPart", () => {
  it("loads only once wanted, then hands every reader the same module", async () => {
    const module = { name: "body" };
    const load = vi.fn(async () => module);
    const part = lazyPart(load);
    const { result, rerender } = renderHook(({ wanted }) => part.useModule(wanted), {
      initialProps: { wanted: false },
    });
    expect(result.current).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    rerender({ wanted: true });
    await waitFor(() => expect(result.current).toBe(module));
    // Another reader, wanted or not, has it at once.
    expect(renderHook(() => part.useModule(false)).result.current).toBe(module);
    expect(await part.preload()).toBe(module);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("tries a failed load again on the next ask", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("chunk gone"))
      .mockResolvedValueOnce("body");
    const part = lazyPart(load);
    await expect(part.preload()).rejects.toThrow("chunk gone");
    expect(part.current()).toBeUndefined();
    expect(await part.preload()).toBe("body");
    expect(part.current()).toBe("body");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("lists every part for the shell's idle preload", () => {
    const part = lazyPart(async () => 1);
    expect(lazyParts()).toContain(part);
  });
});
