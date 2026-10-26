import { describe, expect, it } from "vitest";

import {
  isTrayAction,
  menuLabel,
  parseTrayMenu,
  trayAskCount,
  trayEntries,
  trayGlyphBitmap,
  type TrayEntry,
} from "./tray-menu.ts";

const PUSH = "git push -u origin feat/mail-trigger";

const ask = (more: Record<string, unknown> = {}) => ({
  id: "ask-0123abcd",
  title: "Allow git push × 3?",
  context: "agent-platform · mail-trigger",
  lines: [PUSH],
  answer: "Allow 3",
  ...more,
});

const labels = (entries: readonly TrayEntry[]) =>
  entries.map((entry) => (entry.kind === "separator" ? "—" : entry.label));

describe("parseTrayMenu", () => {
  it("keeps an answer under lines shown whole, by the notifications' rule", () => {
    expect(parseTrayMenu({ asks: [ask()], more: 0, workspaces: [] }).asks[0]).toEqual(ask());
  });

  it("drops the answer, whatever the page asked, when a line isn't shown whole", () => {
    for (const lines of [
      [`git push origin ${"x".repeat(120)}`],
      ["git push origin main‮; rm -rf ~"],
      ["git push\nrm -rf ~"],
      [],
      Array.from({ length: 7 }, (_, i) => `line ${i}`),
    ]) {
      const [parsed] = parseTrayMenu({ asks: [ask({ lines })], workspaces: [] }).asks;
      expect(parsed?.answer).toBeUndefined();
      for (const line of parsed?.lines ?? []) {
        expect([...line].length).toBeLessThanOrEqual(96);
        expect(line).not.toMatch(/[‮\n]/);
      }
    }
  });

  it("takes only Allow, Allow n and Merge as answers", () => {
    for (const answer of ["Deny", "Allow always", "Allow 0", "Allow 100", "merge"]) {
      expect(parseTrayMenu({ asks: [ask({ answer })] }).asks[0]?.answer).toBeUndefined();
    }
    expect(parseTrayMenu({ asks: [ask({ answer: "Merge" })] }).asks[0]?.answer).toBe("Merge");
  });

  it("leaves out what is malformed, and lists eight asks at most, counting the rest", () => {
    expect(parseTrayMenu(null)).toEqual({ asks: [], more: 0, workspaces: [] });
    const many = Array.from({ length: 10 }, (_, i) => ask({ id: `ask-${i}` }));
    const parsed = parseTrayMenu({
      asks: [...many, { id: "bad id!", title: "x", context: "", lines: [] }, 4],
      more: 3,
      workspaces: [{ id: "ws-1", name: "billing", busy: 2, asks: -1, failed: 1.5 }, {}],
    });
    expect(parsed.asks).toHaveLength(8);
    expect(parsed.more).toBe(5);
    expect(parsed.workspaces).toEqual([
      { id: "ws-1", name: "billing", busy: 2, asks: 0, failed: 0 },
    ]);
    expect(trayAskCount(parsed)).toBe(13);
  });
});

describe("trayEntries", () => {
  it("lays out Open, the asks with their exact lines before the answer, the workspaces and Quit", () => {
    const menu = parseTrayMenu({
      asks: [ask(), ask({ id: "ask-2", title: "A worker asks", lines: [], answer: undefined })],
      more: 2,
      workspaces: [{ id: "ws-1", name: "agent-platform", busy: 6, asks: 1, failed: 0 }],
    });
    const entries = trayEntries(menu, "Gram");
    expect(labels(entries)).toEqual([
      "Open Gram",
      "—",
      "Allow git push × 3?",
      "A worker asks",
      "2 more asks",
      "—",
      "agent-platform — 6 busy · 1 ask",
      "—",
      "Quit Gram",
    ]);
    const push = entries[2];
    if (push?.kind !== "item" || push.submenu === undefined) throw new Error("no submenu");
    expect(labels(push.submenu)).toEqual([
      "agent-platform · mail-trigger",
      "—",
      PUSH,
      "—",
      "Allow 3",
      "Open",
    ]);
    // Read-only lines pick nothing; the answer and Open echo the ask's token.
    expect(push.submenu.map((entry) => (entry.kind === "item" ? entry.run : undefined))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      { kind: "answer", id: "ask-0123abcd" },
      { kind: "open", id: "ask-0123abcd" },
    ]);
    const open = entries[3];
    if (open?.kind !== "item" || open.submenu === undefined) throw new Error("no submenu");
    expect(labels(open.submenu)).toEqual(["agent-platform · mail-trigger", "—", "Open"]);
  });

  it("sends lines it can't answer under to the window, and offers Open only", () => {
    const menu = parseTrayMenu({ asks: [ask({ lines: [`git push ${"x".repeat(200)}`] })] });
    const [, , item] = trayEntries(menu, "Gram");
    if (item?.kind !== "item" || item.submenu === undefined) throw new Error("no submenu");
    expect(labels(item.submenu)).toContain("Open to review");
    expect(labels(item.submenu)).not.toContain("Allow 3");
  });

  it("ends the workspace lines with Pause all, or Resume all when every one is paused", () => {
    const workspaces = [{ id: "ws-1", name: "agent-platform", busy: 6, asks: 0, failed: 0 }];
    const entries = trayEntries(parseTrayMenu({ workspaces, allPaused: false }), "Gram");
    expect(labels(entries)).toEqual([
      "Open Gram",
      "—",
      "agent-platform — 6 busy",
      "Pause all",
      "—",
      "Quit Gram",
    ]);
    const pause = entries[3];
    expect(pause?.kind === "item" && pause.run).toEqual({ kind: "pauseAll", paused: true });
    const resume = trayEntries(parseTrayMenu({ workspaces, allPaused: true }), "Gram")[3];
    expect(resume).toMatchObject({ label: "Resume all", run: { kind: "pauseAll", paused: false } });
  });

  it("offers Pause all only for a true or false, and only beside workspaces", () => {
    const workspaces = [{ id: "ws-1", name: "billing", busy: 0, asks: 0, failed: 0 }];
    for (const allPaused of ["yes", 1, null, undefined, {}]) {
      const menu = parseTrayMenu({ workspaces, allPaused });
      expect(menu).not.toHaveProperty("allPaused");
      expect(labels(trayEntries(menu, "Gram"))).not.toContain("Pause all");
    }
    expect(parseTrayMenu({ workspaces: [], allPaused: false })).not.toHaveProperty("allPaused");
    expect(parseTrayMenu({ workspaces: [{}], allPaused: true })).not.toHaveProperty("allPaused");
  });

  it("is only Open and Quit with nothing to show", () => {
    expect(labels(trayEntries(parseTrayMenu({}), "Gram"))).toEqual(["Open Gram", "—", "Quit Gram"]);
  });
});

describe("isTrayAction", () => {
  it("knows only the menu's own picks", () => {
    expect(isTrayAction({ kind: "answer", id: "ask-1" })).toBe(true);
    expect(isTrayAction({ kind: "asks" })).toBe(true);
    expect(isTrayAction({ kind: "answer", id: "has space" })).toBe(false);
    expect(isTrayAction({ kind: "deny", id: "ask-1" })).toBe(false);
    expect(isTrayAction({ kind: "pauseAll", paused: true })).toBe(true);
    expect(isTrayAction({ kind: "pauseAll", paused: false })).toBe(true);
    expect(isTrayAction({ kind: "pauseAll" })).toBe(false);
    expect(isTrayAction({ kind: "pauseAll", paused: "true" })).toBe(false);
  });
});

describe("menuLabel", () => {
  it("keeps an exact command's & on Windows and Linux, where a single one is a mnemonic", () => {
    const command = "bun install && bun test";
    expect(menuLabel(command, "darwin")).toBe(command);
    expect(menuLabel(command, "win32")).toBe("bun install &&&& bun test");
    expect(menuLabel(command, "linux")).toBe("bun install &&&& bun test");
  });
});

describe("trayGlyphBitmap", () => {
  it("is black, carrying the shape in alpha alone, with four squares and clear between", () => {
    const size = 32;
    const bitmap = trayGlyphBitmap(size);
    expect(bitmap.length).toBe(size * size * 4);
    const alpha = (x: number, y: number) => bitmap[(y * size + x) * 4 + 3]!;
    for (let i = 0; i < bitmap.length; i += 4) {
      expect([bitmap[i], bitmap[i + 1], bitmap[i + 2]]).toEqual([0, 0, 0]);
    }
    expect(alpha(9, 9)).toBe(255);
    expect(alpha(22, 22)).toBe(255);
    expect(alpha(16, 16)).toBe(0);
    expect(alpha(0, 0)).toBe(0);
  });
});
