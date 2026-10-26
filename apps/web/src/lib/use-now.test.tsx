// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNow } from "./use-now";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T10:00:00Z"));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useNow", () => {
  it("ticks while active", () => {
    const { result } = renderHook(() => useNow(true));
    const start = result.current;
    act(() => void vi.advanceTimersByTime(3000));
    expect(result.current - start).toBe(3000);
  });

  it("holds still while its anchor is out of sight, then catches up", () => {
    const anchor = { current: document.createElement("div") };
    let visible = false;
    anchor.current.checkVisibility = () => visible;
    const { result } = renderHook(() => useNow(true, anchor));
    const start = result.current;
    act(() => void vi.advanceTimersByTime(3000));
    expect(result.current).toBe(start);

    visible = true;
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current - start).toBe(4000);
  });

  it("stays still while inactive", () => {
    const { result } = renderHook(() => useNow(false));
    const start = result.current;
    act(() => void vi.advanceTimersByTime(3000));
    expect(result.current).toBe(start);
  });

  it("shares one timer per interval, which stops while the window is hidden", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const a = renderHook(() => useNow(true, undefined, 30_000));
    const b = renderHook(() => useNow(true, undefined, 30_000));
    expect(vi.getTimerCount()).toBe(1);
    const start = a.result.current;

    hidden.mockReturnValue(true);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(0);
    act(() => void vi.advanceTimersByTime(90_000));
    expect(a.result.current).toBe(start);

    // Shown again, both catch up at once rather than on the next tick.
    hidden.mockReturnValue(false);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(1);
    expect(a.result.current - start).toBe(90_000);
    expect(b.result.current).toBe(a.result.current);

    a.unmount();
    b.unmount();
    expect(vi.getTimerCount()).toBe(0);
    hidden.mockRestore();
  });
});
