import { describe, expect, it } from "vitest";

import { Scrollback } from "./scrollback.ts";

describe("Scrollback", () => {
  it("replays everything as written until the cap drops its front", () => {
    const scrollback = new Scrollback(64);
    scrollback.append("\x1b]0;title\x07$ ls\r\nfile\r\n");
    expect(scrollback.cut).toBe(false);
    expect(scrollback.toReplay()).toBe(scrollback.toString());
  });

  it("once cut, replays from a line break and past an unmatched alternate-screen exit", () => {
    const scrollback = new Scrollback(48);
    scrollback.append("\x1b[?1049h" + "~ frame\r\n".repeat(20));
    scrollback.append("\x1b[?1049l$ echo back\r\nback\r\n");
    expect(scrollback.cut).toBe(true);
    expect(scrollback.toString()).toContain("~ frame");
    // The Terminal tab and `read_terminal` are both sent this, so neither draws the dead frames.
    expect(scrollback.toReplay()).toBe("$ echo back\r\nback\r\n");
  });

  it("counts a single chunk larger than the cap as cut", () => {
    const scrollback = new Scrollback(8);
    scrollback.append("0123456789\r\nab");
    expect(scrollback.cut).toBe(true);
    expect(scrollback.toReplay()).toBe("ab");
  });
});
