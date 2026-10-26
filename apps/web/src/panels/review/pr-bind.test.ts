import type { ThreadId } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";

import { bindPrFromInput } from "./pr-bind";

const T = "t-flaky" as ThreadId;

describe("bindPrFromInput", () => {
  it("binds a bare number against the origin, and a URL or owner/repo#N as typed", async () => {
    const prBind = vi.fn(async () => ({}) as never);
    const prBindExtra = vi.fn(async () => [] as never);
    await bindPrFromInput({ prBind, prBindExtra }, T, " #12 ", "example/api");
    expect(prBind).toHaveBeenLastCalledWith(T, "example/api", 12);
    await bindPrFromInput(
      { prBind, prBindExtra },
      T,
      "https://github.com/example/web/pull/7/files",
      undefined,
    );
    expect(prBind).toHaveBeenLastCalledWith(T, "example/web", 7);
    expect(prBindExtra).not.toHaveBeenCalled();
  });

  it("follows the PR beside the thread's own when asked to", async () => {
    const prBind = vi.fn(async () => ({}) as never);
    const prBindExtra = vi.fn(async () => [] as never);
    await bindPrFromInput({ prBind, prBindExtra }, T, "example/web#8", "example/api", true);
    expect(prBindExtra).toHaveBeenCalledWith(T, "example/web", 8);
    expect(prBind).not.toHaveBeenCalled();
  });

  it("explains input it can't bind", async () => {
    const prBind = vi.fn(async () => ({}) as never);
    const prBindExtra = vi.fn(async () => [] as never);
    await expect(
      bindPrFromInput({ prBind, prBindExtra }, T, "main", "example/api"),
    ).rejects.toThrow("Enter a PR number, owner/repo#N or a PR URL");
    await expect(bindPrFromInput({ prBind, prBindExtra }, T, "12", undefined)).rejects.toThrow(
      "Enter the full PR URL",
    );
    expect(prBind).not.toHaveBeenCalled();
  });
});
