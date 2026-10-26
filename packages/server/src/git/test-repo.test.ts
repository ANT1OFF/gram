import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeDir } from "./test-repo.ts";

const failure = (code: string) => Object.assign(new Error(`${code}: held`), { code });

beforeEach(() => {
  // Windows' tasklist diagnostics can spend the whole 300 ms budget before the first retry.
  // Advance only for simulated waits so these tests measure backoff, not runner speed.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
    vi.advanceTimersByTime(timeout ?? 0);
    return "timed-out";
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("removeDir", () => {
  it("retries a tree that stays busy, then leaves it behind at its deadline without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    removeDir("/tmp/gram-held", {
      deadlineMs: 300,
      rm: () => {
        calls++;
        throw failure("EBUSY");
      },
    });
    expect(calls).toBe(3);
    expect(vi.mocked(Atomics.wait).mock.calls.map(([, , , delay]) => delay)).toEqual([100, 200]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^removeDir: left \/tmp\/gram-held behind after 3 attempts in 300 ms \(EBUSY\)/,
      ),
    );
  });

  it("does not retry when the first busy diagnostic has spent the deadline", () => {
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {})
      .mockImplementationOnce(() => vi.advanceTimersByTime(300));
    const rm = vi.fn(() => {
      throw failure("EBUSY");
    });
    removeDir("/tmp/gram-held", { deadlineMs: 300, rm });
    expect(rm).toHaveBeenCalledTimes(1);
    expect(Atomics.wait).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^removeDir: left \/tmp\/gram-held behind after 1 attempts in 300 ms \(EBUSY\)/,
      ),
    );
  });

  it("says when a busy tree first refuses and how long it held the hook once it goes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    removeDir("/tmp/gram-held", {
      rm: () => {
        if (++calls < 3) throw failure("EPERM");
      },
    });
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      expect.stringMatching(
        /^removeDir: \/tmp\/gram-held is busy \(EPERM\), retrying for up to 20000 ms/,
      ),
      expect.stringMatching(/^removeDir: removed \/tmp\/gram-held after 3 attempts in 300 ms$/),
    ]);
  });

  it("throws any other error", () => {
    expect(() =>
      removeDir("/tmp/gram-held", {
        rm: () => {
          throw failure("EINVAL");
        },
      }),
    ).toThrow("EINVAL");
  });
});
