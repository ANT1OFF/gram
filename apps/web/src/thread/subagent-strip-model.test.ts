import type { BackgroundTask, MessageId, SubagentUsageData, GramUIMessage } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { firstLine } from "@/lib/format";

import { splitSubagents } from "./parts";
import {
  formatElapsed,
  nextJump,
  rowHint,
  runningSubagents,
  stripRows,
  type RunningSubagent,
} from "./subagent-strip-model";

type Part = GramUIMessage["parts"][number];

const message = (id: string, parts: Part[], parentToolUseId?: string): GramUIMessage => ({
  id: id as MessageId,
  role: "assistant",
  parts,
  ...(parentToolUseId === undefined ? {} : { metadata: { agent: "claude", parentToolUseId } }),
});

const task = (
  toolCallId: string,
  state: "input-available" | "output-available",
  output?: unknown,
): Part =>
  ({
    type: "tool-Agent",
    toolCallId,
    state,
    input: { description: `Run ${toolCallId}`, prompt: "p", subagent_type: "Explore" },
    ...(state === "output-available" ? { output } : {}),
  }) as Part;

const usage = (
  toolCallId: string,
  status: SubagentUsageData["status"],
  startedAt?: number,
): Part => ({
  type: "data-subagent-usage",
  id: toolCallId,
  data: {
    toolCallId,
    status,
    ...(startedAt === undefined ? {} : { startedAt }),
    lastToolName: "Grep",
  },
});

/** `streaming` defaults to every message, as in a turn under way. */
const running = (messages: GramUIMessage[], streaming = messages.map((m) => m.id)) => {
  const { top, children, subagentUsage } = splitSubagents(messages);
  return runningSubagents({
    top,
    children,
    usage: subagentUsage,
    streamingIds: new Set(streaming),
  });
};

describe("runningSubagents", () => {
  it("lists what the agent reports running, the most recently started first", () => {
    const rows = running([
      message("u", []),
      message("m1", [task("a", "input-available"), usage("a", "running", 1_000)]),
      message("m2", [task("b", "input-available"), usage("b", "running", 5_000)]),
    ]);
    expect(rows).toEqual([
      {
        toolCallId: "b",
        index: 2,
        ancestors: [],
        label: "Run b",
        subagentType: "Explore",
        startedAt: 5_000,
        note: "Grep",
      },
      expect.objectContaining({ toolCallId: "a", index: 1 }),
    ]);
  });

  it("invents nothing: a card with no running snapshot, or a snapshot with no card, isn't listed", () => {
    expect(
      running([message("m1", [task("a", "input-available"), usage("orphan", "running")])]),
    ).toEqual([]);
  });

  it("drops a finished run, and a foreground one whose message no longer streams", () => {
    const done = { status: "completed", content: [] };
    expect(
      running([message("m1", [task("a", "output-available", done), usage("a", "running")])]),
    ).toEqual([]);
    expect(
      running([message("m1", [task("a", "input-available"), usage("a", "completed")])]),
    ).toEqual([]);
    // Interrupted without a final snapshot: a later turn streams other messages, not this one.
    expect(
      running(
        [message("m1", [task("a", "input-available"), usage("a", "running")]), message("m2", [])],
        ["m2"],
      ),
    ).toEqual([]);
  });

  it("keeps a background run only while its own transcript streams", () => {
    const launched = { status: "async_launched", agentId: "x" };
    const messages = [
      message("m1", [task("bg", "output-available", launched), usage("bg", "running")]),
      message("sub", [], "bg"),
    ];
    expect(running(messages, ["sub"])).toHaveLength(1);
    // A session closed without a final snapshot, then a new turn: the old run stays down.
    expect(running(messages, ["m1"])).toEqual([]);
  });

  it("finds a subagent's own subagent through the card nesting it", () => {
    const rows = running([
      message("u", []),
      message("m1", [task("outer", "input-available")]),
      message("sub", [task("inner", "input-available"), usage("inner", "running")], "outer"),
    ]);
    expect(rows).toMatchObject([{ toolCallId: "inner", index: 1, ancestors: ["outer"] }]);
  });
});

describe("stripRows", () => {
  const explore: RunningSubagent = {
    toolCallId: "a1",
    index: 0,
    ancestors: [],
    label: "List the files",
    subagentType: "Explore",
    startedAt: 1_000,
    note: "Glob",
  };
  const subagentTask: BackgroundTask = {
    taskId: "task-a1",
    kind: "subagent",
    description: "List the files",
    toolCallId: "a1",
    startedAt: 900,
  };
  const shell: BackgroundTask = {
    taskId: "b1",
    kind: "shell",
    description: "Run the tests",
    command: "pnpm test",
    toolCallId: "t-bash",
    startedAt: 2_000,
  };

  it("lists subagents and the other background tasks, newest first, Stop only on tasks", () => {
    const rows = stripRows([explore], [subagentTask, shell], true);
    expect(rows.map((r) => [r.kind, r.label, r.command, r.note, r.taskId])).toEqual([
      ["shell", "pnpm test", "pnpm test", "Run the tests", "b1"],
      ["subagent", "List the files", undefined, "Glob", "task-a1"],
    ]);
    expect(rows[1]).toMatchObject({ chip: "Explore", jump: explore, startedAt: 1_000 });
    expect(rows[0]!.jump).toBeUndefined();
    // A foreground subagent has no task to stop.
    expect(stripRows([explore], [], true)[0]!.taskId).toBeUndefined();
  });

  it("keeps a line's key as its task and card arrive, in either order", () => {
    const keys = [
      stripRows([], [subagentTask], true),
      stripRows([explore], [subagentTask], true),
      stripRows([explore], [], true),
    ].map((rows) => rows.map((r) => r.key));
    expect(keys).toEqual([["a1"], ["a1"], ["a1"]]);
    // A shell is told its tool call after it is first listed, and keeps its key when it is.
    const { toolCallId: _toolCallId, ...unlinked } = shell;
    expect([unlinked, shell].map((listed) => stripRows([], [listed], true)[0]!.key)).toEqual([
      "b1",
      "b1",
    ]);
  });

  it("keeps a background subagent without a card, and offers no Stop where the agent has none", () => {
    const { command: _command, ...described } = shell;
    const rows = stripRows([], [subagentTask, described], false);
    expect(rows.map((r) => [r.label, r.command, r.chip, r.taskId])).toEqual([
      ["Run the tests", undefined, undefined, undefined],
      ["List the files", undefined, undefined, undefined],
    ]);
    expect(stripRows([], [], true)).toEqual([]);
  });

  it("shows a heredoc by its first line, keeps the whole of it for Copy, and hints two lines", () => {
    // As Claude Code lists a shell it moved to the background, the description falling back to
    // the command (`p14-background-shells` has the shape; this one outran its 120 s timeout).
    const command = `cat > app/sampling.py <<'EOF'\n"""Stratified sampling."""\n${"x = 1\n".repeat(300)}EOF\nls`;
    const hung: BackgroundTask = { ...shell, taskId: "b2", description: command, command };
    const [row] = stripRows([], [hung], true);
    expect(row).toMatchObject({
      label: "cat > app/sampling.py <<'EOF' …",
      command,
      note: undefined,
    });
    expect(rowHint(row!)).toEqual({ title: undefined, command: "cat > app/sampling.py <<'EOF' …" });
    const indented = { ...shell, command: "  pnpm test\n" };
    expect(stripRows([], [indented], true)[0]).toMatchObject({
      label: "pnpm test",
      command: "  pnpm test\n",
    });
    expect(stripRows([], [{ ...shell, command: " \n" }], true)[0]!.command).toBeUndefined();
    const long = { ...shell, command: `python3 -c '${"a".repeat(300)}'` };
    const hint = rowHint(stripRows([], [long], true)[0]!);
    expect(hint.title).toBe("Run the tests");
    expect(hint.command).toHaveLength(80);
    expect(hint.command!.endsWith("…")).toBe(true);
    expect(rowHint(stripRows([explore], [], true)[0]!)).toEqual({
      title: "List the files",
      command: undefined,
    });
  });
});

describe("firstLine", () => {
  it("keeps a short line whole and marks whatever it leaves out", () => {
    expect(firstLine("pnpm test")).toBe("pnpm test");
    expect(firstLine("\n  sleep 840; echo done \r\n")).toBe("sleep 840; echo done");
    expect(firstLine("python3 - <<'EOF'\r\nprint(1)\nEOF")).toBe("python3 - <<'EOF' …");
    expect(firstLine("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("nextJump", () => {
  const rows = running([
    message("m1", [task("a", "input-available"), usage("a", "running", 1)]),
    message("m2", [task("b", "input-available"), usage("b", "running", 2)]),
  ]);

  it("starts at the most recent run and cycles through the older ones", () => {
    expect(nextJump(rows, undefined)?.toolCallId).toBe("b");
    expect(nextJump(rows, "b")?.toolCallId).toBe("a");
    expect(nextJump(rows, "a")?.toolCallId).toBe("b");
    expect(nextJump(rows, "gone")?.toolCallId).toBe("b");
    expect(nextJump([], undefined)).toBeUndefined();
  });
});

describe("formatElapsed", () => {
  it("reads as a running clock", () => {
    expect(formatElapsed(-50)).toBe("0s");
    expect(formatElapsed(8_900)).toBe("8s");
    expect(formatElapsed(245_000)).toBe("4m 05s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
  });
});
