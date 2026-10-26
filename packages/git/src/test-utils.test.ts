import { afterEach, describe, expect, it, vi } from "vitest";

import { removeDir } from "./test-utils.ts";

const failure = (code: string) => Object.assign(new Error(`${code}: held`), { code });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("removeDir", () => {
  it("retries a busy tree until it goes", () => {
    let calls = 0;
    removeDir("/tmp/gram-held", {
      rm: () => {
        calls++;
        if (calls < 3) throw failure("EBUSY");
      },
    });
    expect(calls).toBe(3);
  });

  it("leaves a tree that stays busy behind at its deadline, without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Date.now();
    removeDir("/tmp/gram-held", {
      deadlineMs: 300,
      rm: () => {
        throw failure("EPERM");
      },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^removeDir: left \/tmp\/gram-held behind after \d+ attempts \(EPERM\)$/,
      ),
    );
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
