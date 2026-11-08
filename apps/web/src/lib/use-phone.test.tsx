// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PHONE_MAX_WIDTH, usePhone } from "./use-phone";

function fakeMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    get matches() {
      return matches;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => {
      expect(query).toBe(`(max-width: ${PHONE_MAX_WIDTH}px)`);
      return list;
    }),
  );
  return {
    set(next: boolean) {
      matches = next;
      for (const fn of listeners) fn();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("usePhone", () => {
  it("follows the phone-width media query", () => {
    const media = fakeMedia(false);
    const { result } = renderHook(() => usePhone());
    expect(result.current).toBe(false);
    act(() => media.set(true));
    expect(result.current).toBe(true);
  });
});
