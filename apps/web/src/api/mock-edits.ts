import type { GramUIMessage, MessageMetadata } from "@gram/contracts";

// Two finished transcripts made of file edits, one per agent, as each mapper stores them: Claude's
// Edit, MultiEdit and Write calls with the SDK's structured results, and Codex's file changes,
// which its mapper turns into dynamic `Edit`/`Write` calls carrying the patch's `changes`.

type Part = GramUIMessage["parts"][number];

const WEB = "/Users/dev/code/web/.worktrees/feat-file-tabs";
const API = "/Users/dev/code/api/.worktrees/fix-rate-limit";

const meta = (id: string, agent: "claude" | "codex"): MessageMetadata => ({
  createdAt: Date.now() - 50 * 60_000,
  agent,
  model: agent === "claude" ? "opus" : "gpt-5-codex",
  agentMessageIds: [`sdk-${id}`],
});

const user = (id: string, text: string): GramUIMessage => ({
  id,
  role: "user",
  metadata: { createdAt: Date.now() - 51 * 60_000 },
  parts: [{ type: "text", text }],
});

const say = (text: string): Part => ({ type: "text", text, state: "done" });

const claudeTool = (name: string, id: string, input: unknown, output: unknown): Part =>
  ({
    type: `tool-${name}`,
    toolCallId: id,
    state: "output-available",
    input,
    output,
    providerExecuted: true,
  }) as Part;

const codexTool = (name: string, id: string, input: unknown, output: unknown): Part => ({
  type: "dynamic-tool",
  toolName: name,
  toolCallId: id,
  state: "output-available",
  input,
  output,
  providerExecuted: true,
});

// ---------------------------------------------------------------------------------------------
// Claude

const TABS_TEST = `${WEB}/src/tabs/file-tabs.test.tsx`;
const TABS = `${WEB}/src/tabs/file-tabs.tsx`;
const FORMAT_PATH = `${WEB}/src/tabs/format-path.ts`;
const README = `${WEB}/README.md`;
const STORE = `${WEB}/src/tabs/tabs-store.ts`;

const FORMAT_PATH_SOURCE = [
  'import { basename, dirname } from "node:path";',
  "",
  "/** `src/tabs/file-tabs.tsx` as `file-tabs.tsx — src/tabs`, for a tab's tooltip. */",
  "export function formatPath(path: string): string {",
  "  const dir = dirname(path);",
  '  return dir === "." ? basename(path) : `${basename(path)} — ${dir}`;',
  "}",
  "",
].join("\n");

const claudeMessages = (): GramUIMessage[] => [
  user("m-e1", "Fix the failing file tabs test, then add a path helper for the tooltips."),
  {
    id: "m-e2",
    role: "assistant",
    metadata: meta("m-e2", "claude"),
    parts: [
      { type: "step-start" },
      say("The test closes a tab and expects the next one to take focus. Fixing the assertion."),
      claudeTool(
        "Edit",
        "toolu_edit_test",
        {
          file_path: TABS_TEST,
          old_string: "    expect(tabs.active).toBe(0);",
          new_string: "    expect(tabs.active).toBe(1);",
        },
        {
          filePath: TABS_TEST,
          oldString: "    expect(tabs.active).toBe(0);",
          newString: "    expect(tabs.active).toBe(1);",
          originalFile: null,
          userModified: false,
          structuredPatch: [
            {
              oldStart: 41,
              oldLines: 7,
              newStart: 41,
              newLines: 10,
              lines: [
                '  it("focuses the next tab after a close", () => {',
                '    const tabs = openTabs(["a.ts", "b.ts", "c.ts"]);',
                "    tabs.close(0);",
                "-    expect(tabs.active).toBe(0);",
                "+    expect(tabs.active).toBe(1);",
                '+    expect(tabs.list.map((tab) => tab.name)).toEqual(["b.ts", "c.ts"]);',
                "+",
                '+    tabs.close("c.ts");',
                "+    expect(tabs.active).toBe(0);",
                "  });",
                "",
                '  it("keeps a pinned tab first", () => {',
              ],
            },
          ],
        },
      ),
      say("Now the off-by-one in the component, and a run of the suite."),
      claudeTool(
        "Edit",
        "toolu_edit_tabs",
        {
          file_path: TABS,
          old_string: "const next = Math.max(0, index - 1);",
          new_string: "const next = Math.min(index, tabs.length - 2);",
        },
        {
          filePath: TABS,
          oldString: "const next = Math.max(0, index - 1);",
          newString: "const next = Math.min(index, tabs.length - 2);",
          originalFile: null,
          userModified: false,
          structuredPatch: [
            {
              oldStart: 88,
              oldLines: 6,
              newStart: 88,
              newLines: 6,
              lines: [
                "  const close = (index: number) => {",
                "    const tabs = get().tabs;",
                "-    const next = Math.max(0, index - 1);",
                "+    const next = Math.min(index, tabs.length - 2);",
                "    set({ tabs: tabs.toSpliced(index, 1), active: next });",
                "  };",
                "",
              ],
            },
          ],
        },
      ),
      claudeTool(
        "Bash",
        "toolu_run_tests",
        { command: "bun test src/tabs", description: "Run the tabs tests" },
        {
          stdout: " ✓ src/tabs/file-tabs.test.tsx (6 tests) 41ms\n\n Tests  6 passed (6)",
          stderr: "",
          interrupted: false,
        },
      ),
      say("Green. Adding the helper for the tooltips."),
      claudeTool(
        "Write",
        "toolu_write_new",
        { file_path: FORMAT_PATH, content: FORMAT_PATH_SOURCE },
        {
          type: "create",
          filePath: FORMAT_PATH,
          content: FORMAT_PATH_SOURCE,
          structuredPatch: [],
          originalFile: null,
        },
      ),
      say("Using it in the store, in one pass over the file."),
      claudeTool(
        "MultiEdit",
        "toolu_multi",
        {
          file_path: STORE,
          edits: [
            {
              old_string: 'import { create } from "zustand";',
              new_string:
                'import { create } from "zustand";\n\nimport { formatPath } from "./format-path";',
            },
            { old_string: "title: path,", new_string: "title: formatPath(path)," },
          ],
        },
        {
          filePath: STORE,
          originalFileContents: null,
          userModified: false,
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 3,
              newStart: 1,
              newLines: 5,
              lines: [
                ' import { create } from "zustand";',
                "+",
                '+import { formatPath } from "./format-path";',
                " ",
                ' import type { Tab } from "./types";',
              ],
            },
            {
              oldStart: 27,
              oldLines: 5,
              newStart: 29,
              newLines: 5,
              lines: [
                "   const open = (path: string) => {",
                "     const tab: Tab = {",
                "       path,",
                "-      title: path,",
                "+      title: formatPath(path),",
                "     };",
              ],
            },
          ],
        },
      ),
      say("A subagent also tidied the README's tab section."),
      // A subagent's result is plain text: the SDK sends no structured result on a sidechain.
      claudeTool(
        "Edit",
        "toolu_edit_readme",
        {
          file_path: README,
          old_string: "Tabs show the file name.\nHover a tab for nothing.",
          new_string: "Tabs show the file name.\nHover a tab for its folder.",
        },
        `The file ${README} has been updated successfully.`,
      ),
      say("Done: the test passes and tabs show their folder on hover."),
    ],
  },
];

// ---------------------------------------------------------------------------------------------
// Codex

const LIMITER = `${API}/src/limiter.ts`;
const LIMITER_TEST = `${API}/src/limiter.test.ts`;
const WINDOW = `${API}/src/window.ts`;
const LEGACY = `${API}/src/legacy-bucket.ts`;

const LIMITER_DIFF = [
  "@@ -12,9 +12,10 @@ export class Limiter {",
  "   hit(key: string, now = Date.now()): boolean {",
  "-    const count = (this.counts.get(key) ?? 0) + 1;",
  "-    this.counts.set(key, count);",
  "-    return count <= this.limit;",
  "+    const window = windowOf(now, this.windowMs);",
  "+    const entry = this.counts.get(key);",
  "+    const count = entry?.window === window ? entry.count + 1 : 1;",
  "+    this.counts.set(key, { window, count });",
  "+    return count <= this.limit;",
  "   }",
  " ",
  "   reset(key: string): void {",
  "",
].join("\n");

const WINDOW_SOURCE = [
  "/** The fixed window `now` falls in, as its start in epoch ms. */",
  "export const windowOf = (now: number, windowMs: number): number =>",
  "  now - (now % windowMs);",
  "",
].join("\n");

const LEGACY_SOURCE = [
  "// Superseded by the fixed-window limiter.",
  "export class LegacyBucket {",
  "  take(): boolean {",
  "    return true;",
  "  }",
  "}",
  "",
].join("\n");

const TEST_DIFF = [
  '@@ -30,4 +30,12 @@ describe("Limiter", () => {',
  '     expect(limiter.hit("a", 0)).toBe(false);',
  "   });",
  "+",
  '+  it("starts a new count each window", () => {',
  "+    const limiter = new Limiter({ limit: 1, windowMs: 1000 });",
  '+    expect(limiter.hit("a", 0)).toBe(true);',
  '+    expect(limiter.hit("a", 999)).toBe(false);',
  '+    expect(limiter.hit("a", 1000)).toBe(true);',
  "+  });",
  " });",
  "",
].join("\n");

/** The `structuredPatch` the Codex mapper puts on a finished file change, flattened across files. */
const flatHunks = (diff: string) => {
  const [header, ...lines] = diff.trimEnd().split("\n");
  const [, oldStart, oldLines, newStart, newLines] =
    /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(header!) ?? [];
  return {
    oldStart: Number(oldStart),
    oldLines: Number(oldLines),
    newStart: Number(newStart),
    newLines: Number(newLines),
    lines,
  };
};
const wholeFile = (source: string, sign: "+" | "-") => {
  const lines = source.replace(/\n$/, "").split("\n");
  return {
    oldStart: sign === "+" ? 0 : 1,
    oldLines: sign === "+" ? 0 : lines.length,
    newStart: sign === "+" ? 1 : 0,
    newLines: sign === "+" ? lines.length : 0,
    lines: lines.map((line) => `${sign}${line}`),
  };
};

const update = (path: string, diff: string) => ({
  path,
  kind: { type: "update", move_path: null },
  diff,
});

const codexMessages = (): GramUIMessage[] => [
  user("m-c1", "Make the rate limiter reset its count every window."),
  {
    id: "m-c2",
    role: "assistant",
    metadata: meta("m-c2", "codex"),
    parts: [
      { type: "step-start" },
      say("The limiter never forgets a key. Counting per fixed window instead."),
      codexTool(
        "Edit",
        "item_patch_1",
        { file_path: LIMITER, changes: [update(LIMITER, LIMITER_DIFF)] },
        { type: "update", structuredPatch: [flatHunks(LIMITER_DIFF)] },
      ),
      say("Moving the window maths out, dropping the old bucket, and covering the reset."),
      codexTool(
        "Edit",
        "item_patch_2",
        {
          file_path: WINDOW,
          changes: [
            { path: WINDOW, kind: { type: "add" }, diff: WINDOW_SOURCE },
            { path: LEGACY, kind: { type: "delete" }, diff: LEGACY_SOURCE },
            update(LIMITER_TEST, TEST_DIFF),
          ],
        },
        {
          type: "update",
          structuredPatch: [
            wholeFile(WINDOW_SOURCE, "+"),
            wholeFile(LEGACY_SOURCE, "-"),
            flatHunks(TEST_DIFF),
          ],
        },
      ),
      codexTool(
        "Bash",
        "item_cmd_1",
        { command: "pnpm vitest run src/limiter.test.ts", cwd: API },
        {
          stdout: " ✓ src/limiter.test.ts (4 tests) 9ms\n\n Tests  4 passed (4)",
          stderr: "",
          interrupted: false,
          exitCode: 0,
        },
      ),
      say("The count now resets each window; the tests pass."),
    ],
  },
];

/** The edit transcripts by thread id; other threads have none here. */
export const mockEditMessages = (threadId: string): GramUIMessage[] | undefined =>
  threadId === "t-edits"
    ? claudeMessages()
    : threadId === "t-edits-codex"
      ? codexMessages()
      : undefined;
