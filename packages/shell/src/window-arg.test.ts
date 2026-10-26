import { describe, expect, it } from "vitest";

import { parseWindowArg, windowArg } from "./window-arg.ts";

describe("window argument", () => {
  it("round-trips the window info through argv", () => {
    const info = { id: "w2", name: "Window 2", primary: false, initialThreadId: "t-a" };
    expect(parseWindowArg(["electron", "--flag", windowArg(info)])).toEqual(info);
  });

  it("is absent or ignored when missing or malformed", () => {
    expect(parseWindowArg(["electron"])).toBeUndefined();
    expect(parseWindowArg(["--gram-window=%E0%A4%A"])).toBeUndefined();
    expect(parseWindowArg([`--gram-window=${encodeURIComponent('{"id":1}')}`])).toBeUndefined();
  });
});
