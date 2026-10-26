import type { TerminalEvent, ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { createMockApi } from "./mock";
import { listMockFiles, readMockFile, resolveInCheckout } from "./mock-files";
import { MockTerminals } from "./terminal/mock";

const ROOT = "/Users/dev/code/api";

describe("mock fs.list / fs.file", () => {
  it("lists folders first and hides dotfiles unless asked", () => {
    expect(listMockFiles(ROOT).entries.map((e) => e.name)).toEqual([
      "docs",
      "fixtures",
      "src",
      "latest",
      "package.json",
      "README.md",
    ]);
    expect(listMockFiles(`${ROOT}/`, { showHidden: true }).entries.map((e) => e.name)).toContain(
      ".github",
    );
  });

  it("serves worktree checkouts from the same tree", () => {
    const listing = listMockFiles(`${ROOT}/.worktrees/fix-flaky-retry/src`);
    expect(listing.entries.find((e) => e.name === "retry.ts")).toMatchObject({
      kind: "file",
      path: `${ROOT}/.worktrees/fix-flaky-retry/src/retry.ts`,
    });
    expect(listing.parent).toBe(`${ROOT}/.worktrees/fix-flaky-retry`);
  });

  it("reads text with a language, and flags binary and too-large files", () => {
    expect(readMockFile(`${ROOT}/src/retry.ts`)).toMatchObject({
      binary: false,
      tooLarge: false,
      language: "typescript",
      content: expect.stringContaining("export async function retry"),
    });
    expect(readMockFile(`${ROOT}/docs/font.woff2`)).toMatchObject({ binary: true, size: 24_512 });
    expect(readMockFile(`${ROOT}/fixtures/recording.json`)).toMatchObject({
      tooLarge: true,
      language: "json",
    });
    expect(readMockFile(`${ROOT}/src/retry.ts`).content).toBeDefined();
  });

  it("hides git-ignored entries unless showHidden, like dotfiles", () => {
    expect(listMockFiles(ROOT).entries.map((e) => e.name)).not.toContain("dist");
    const all = listMockFiles(ROOT, { showHidden: true }).entries.map((e) => e.name);
    expect(all).toEqual(expect.arrayContaining(["dist", ".gitignore", ".git"]));
    expect(all.indexOf("dist")).toBeLessThan(all.indexOf(".gitignore"));
  });

  it("resolves thread paths inside the checkout and rejects escapes", async () => {
    expect(resolveInCheckout("src/retry.ts", ROOT)).toBe(`${ROOT}/src/retry.ts`);
    expect(() => resolveInCheckout("../web/README.md", ROOT)).toThrow(
      "../web/README.md is outside this thread's folder",
    );
    const api = createMockApi({ speed: 0, autoplay: false });
    const threadId = "t-flaky" as ThreadId;
    await expect(api.fsList("src", { threadId })).resolves.toMatchObject({
      path: `${ROOT}/.worktrees/fix-flaky-retry/src`,
    });
    await expect(api.fsFile("/etc/hosts", { threadId })).rejects.toMatchObject({
      _tag: "InvalidState",
      message: "/etc/hosts is outside this thread's folder and not in its messages",
    });
    await expect(api.fsFile(`${ROOT}/src/retry.ts`)).rejects.toMatchObject({
      _tag: "InvalidState",
    });
  });

  it("rejects like the server", () => {
    expect(() => listMockFiles(`${ROOT}/nope`)).toThrow(
      expect.objectContaining({ _tag: "NotFound" }),
    );
    expect(() => readMockFile(`${ROOT}/src`)).toThrow(
      expect.objectContaining({ _tag: "InvalidState" }),
    );
  });
});

const collect = async (events: AsyncIterable<TerminalEvent>, out: TerminalEvent[]) => {
  for await (const event of events) out.push(event);
};

describe("MockTerminals", () => {
  it("replays scrollback, echoes entered lines and exits", async () => {
    const terminals = new MockTerminals();
    const { terminalId } = terminals.open(
      { threadId: "t-1" as ThreadId, cols: 80, rows: 24 },
      ROOT,
    );
    expect(terminals.list("t-1" as ThreadId)).toMatchObject([
      { terminalId, alive: true, cwd: ROOT },
    ]);

    const events: TerminalEvent[] = [];
    const done = collect(terminals.subscribe(terminalId, new AbortController().signal), events);
    terminals.input(terminalId, "ls\r");
    terminals.input(terminalId, "exit\r");
    await done;

    expect(events[0]).toMatchObject({ type: "replay", data: expect.stringContaining("$ ") });
    expect(events.map((e) => ("data" in e ? e.data : "")).join("")).toContain("echo: ls\r\n$ ");
    expect(events.at(-1)).toEqual({ type: "exit", code: 0 });
    expect(() => terminals.input(terminalId, "x")).toThrow("exited");

    const replay: TerminalEvent[] = [];
    await collect(terminals.subscribe(terminalId, new AbortController().signal), replay);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ type: "replay", data: expect.stringContaining("echo: ls") });
  });
});
