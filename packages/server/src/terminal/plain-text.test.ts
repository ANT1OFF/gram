import { describe, expect, it } from "vitest";

import { plainTail } from "./plain-text.ts";
import { replayable } from "./scrollback.ts";

describe("plainTail", () => {
  it("drops colour and title sequences and normalises line ends", async () => {
    const raw = "\x1b[32m✓\x1b[0m built in 1.2s\r\n\x1b[2K$ \x1b]0;title\x07";
    expect(await plainTail(raw, 10)).toEqual({ text: "✓ built in 1.2s\n$", truncated: false });
  });

  it("shows a redrawn line as the screen ended up, not every frame of it", async () => {
    expect((await plainTail("10%\r50%\r100%\r\ndone", 10)).text).toBe("100%\ndone");
    expect((await plainTail("downloading\rok", 10)).text).toBe("okwnloading");
    // Backspace only moves the cursor; it is the erase after it that removes what was typed.
    expect((await plainTail("abc\b\bX", 10)).text).toBe("aXc");
    expect((await plainTail("abc\b\b\x1b[KX", 10)).text).toBe("aX");
    // A spinner that moves the cursor up and rewrites two lines.
    const redraw = "fetching a\r\nfetching b\r\n\x1b[2A\x1b[2Kdone a\r\n\x1b[2Kdone b\r\n";
    expect((await plainTail(redraw, 10)).text).toBe("done a\ndone b");
  });

  it("does not return what the screen no longer holds", async () => {
    // `clear` as the shell sends it: erase the display and the scrollback, cursor home.
    const cleared = "export TOKEN=hunter2\r\n\x1b[H\x1b[2J\x1b[3Jclean\r\n";
    expect((await plainTail(cleared, 50)).text).toBe("clean");
    // A full-screen program owns the alternate screen; the shell's text is not on it.
    const inVim = "$ vim notes\r\n\x1b[?1049h\x1b[Hnotes.md\r\n~\r\n";
    expect((await plainTail(inVim, 50)).text).toBe("notes.md\n~");
    // And is back once the program leaves.
    expect((await plainTail(`${inVim}\x1b[?1049l$ `, 50)).text).toBe("$ vim notes\n$");
  });

  it("rejoins a soft-wrapped line and keeps only the last lines, saying when it dropped some", async () => {
    expect((await plainTail("abcdefghij", 5, { cols: 4, rows: 5 })).text).toBe("abcdefghij");
    expect(await plainTail("a\r\nb\r\nc\r\n\r\n\r\n", 2)).toEqual({
      text: "b\nc",
      truncated: true,
    });
    expect(await plainTail("a\r\nb", 2)).toEqual({ text: "a\nb", truncated: false });
    expect(await plainTail("", 5)).toEqual({ text: "", truncated: false });
  });

  it("replays a tail that lost its front at the cap without inventing output", async () => {
    // The cap fell inside a title sequence: its payload must not show up as text.
    const midSequence = "secret-window-title\x07rest of the line\r\n$ ls\r\nfile\r\n";
    expect((await plainTail(replayable(midSequence), 50, undefined, true)).text).toBe("$ ls\nfile");
    // A full-screen program wrote more than the cap and quit: only its exit survived, and its
    // frames were never on the normal screen.
    const afterTui = "~ frame 9812\r\n~ frame 9813\r\n\x1b[?1049l$ echo back\r\nback\r\n";
    expect(await plainTail(replayable(afterTui), 50, undefined, true)).toEqual({
      text: "$ echo back\nback",
      truncated: true,
    });
    // Entered again after that exit: the later, matched pair is left to the emulator.
    expect(replayable("x\n\x1b[?1049la\x1b[?1049hb")).toBe("a\x1b[?1049hb");
    expect(replayable("x\nplain\x1b[?1049hfull")).toBe("plain\x1b[?1049hfull");
    expect(replayable("no line break at all")).toBe("");
  });

  it("rejoins a wrapped line that has scrolled off the screen, keeping a space it wrapped at", async () => {
    const long = "the quick brown fox jumps over the lazy dog";
    const raw = `${long}\r\nexactly-10\r\nnext\r\n${"tail\r\n".repeat(8)}`;
    const shown = await plainTail(raw, 50, { cols: 10, rows: 4 });
    expect(shown.text.split("\n").slice(0, 3)).toEqual([long, "exactly-10", "next"]);
  });

  it("keeps wide characters and grapheme clusters whole", async () => {
    expect((await plainTail("é 👍🏽 日本語\r\n", 5)).text).toBe("é 👍🏽 日本語");
  });

  it("never shows one replay's text in the next", async () => {
    await plainTail(`${"TOKEN=hunter2 ".repeat(40)}\r\n`.repeat(40), 5);
    expect((await plainTail("hi\r\n", 50)).text).toBe("hi");
  });

  it("replays a full scrollback of short lines in well under a tool call's patience", async () => {
    const raw = Array.from({ length: 30_000 }, (_, i) => `l${i}`).join("\r\n");
    const started = performance.now();
    const shown = await plainTail(raw, 2);
    expect(shown).toEqual({ text: "l29998\nl29999", truncated: true });
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
