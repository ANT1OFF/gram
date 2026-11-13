import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TerminalId, ThreadId } from "@gram/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { KEPT_DIVIDER, type KeptTerminal, keptScreen, keptTerminalsIn } from "./kept.ts";
import { plainTail } from "./plain-text.ts";

const kept = (tail: string, overrides: Partial<KeptTerminal> = {}): KeptTerminal => ({
  terminalId: "0d6f6f3e-6c43-4f0f-9a43-1f1f6e0c2b11" as TerminalId,
  threadId: "thread-kept" as ThreadId,
  cwd: "/tmp",
  shell: "/bin/sh",
  path: "/usr/bin:/bin",
  cols: 40,
  rows: 6,
  tail,
  cut: false,
  ...overrides,
});

/** What the fresh terminal shows once `seed` is drawn, as plain text. */
const shown = async (seed: string) => (await plainTail(seed, 100, { cols: 40, rows: 6 })).text;

describe("keptScreen", () => {
  it("shows the old output above the divider, as plain text", async () => {
    const seed = await keptScreen(kept("$ \x1b[32mnpm test\x1b[0m\r\n12 passed\r\n$ "));
    expect(await shown(seed)).toBe(`$ npm test\n12 passed\n$\n── ${KEPT_DIVIDER} ──`);
    // Nothing of the old program's colour or modes carries over: only the divider's own dimming.
    expect(seed.replace(`\x1b[2m── ${KEPT_DIVIDER} ──\x1b[0m`, "")).not.toContain("\x1b");
  });

  it("keeps a full-screen program's last frame, on the normal screen", async () => {
    const seed = await keptScreen(kept("$ vim notes\r\n\x1b[?1049h\x1b[Hnotes.md\r\n~\r\n"));
    expect(await shown(seed)).toBe(`notes.md\n~\n── ${KEPT_DIVIDER} ──`);
    expect(seed).not.toContain("\x1b[?1049h");
  });

  it("shows only the divider for a terminal that had nothing on it", async () => {
    expect(await shown(await keptScreen(kept("")))).toBe(`── ${KEPT_DIVIDER} ──`);
  });
});

describe("keptTerminalsIn", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-kept-store-"));
    dirs.push(dir);
    return join(dir, "kept");
  };

  it("hands each kept terminal back once, and forgets a removed one", () => {
    const dir = fresh();
    const store = keptTerminalsIn(dir);
    const a = kept("a");
    const b = kept("b", { terminalId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" as TerminalId });
    store.write(a);
    store.write(b);
    store.write({ ...a, tail: "a again" });
    store.remove(b.terminalId);
    expect(store.takeAll()).toEqual([{ ...a, tail: "a again" }]);
    expect(store.takeAll()).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("drops what it can't read, a half-written file and one under another's name", () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    const good = kept("ok");
    writeFileSync(join(dir, `${good.terminalId}.json`), JSON.stringify(good));
    writeFileSync(join(dir, "11111111-1111-4111-8111-111111111111.json"), "{not json");
    writeFileSync(join(dir, "22222222-2222-4222-8222-222222222222.json"), JSON.stringify(good));
    writeFileSync(join(dir, `${good.terminalId}.json.tmp`), "{");
    writeFileSync(join(dir, "33333333-3333-4333-8333-333333333333.json"), JSON.stringify({}));
    expect(keptTerminalsIn(dir).takeAll()).toEqual([good]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("has nothing to hand back before anything was kept", () => {
    expect(keptTerminalsIn(fresh()).takeAll()).toEqual([]);
  });
});
