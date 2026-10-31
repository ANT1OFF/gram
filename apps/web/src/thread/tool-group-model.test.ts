import type { GramUIMessage, TurnEnd, TurnId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import type { AnyToolPart, MessagePart } from "./parts";
import {
  missingToolImageLabel,
  reuseFolds,
  runState,
  runSummary,
  stepLabel,
  toolImageName,
  toolImagesOf,
  toolRuns,
  turnFoldLabel,
  turnFolds,
  type TurnSummary,
} from "./tool-group-model";

let calls = 0;
const tool = (
  name: string,
  input: Record<string, unknown> = {},
  state: AnyToolPart["state"] = "output-available",
) => ({ type: `tool-${name}`, toolCallId: `call-${calls++}`, state, input }) as AnyToolPart;
const text = (value: string) => ({ type: "text", text: value }) as MessagePart;
const image = (toolCallId: string, path?: string, size = 68) =>
  ({
    type: "data-tool-image",
    data: { toolCallId, mediaType: "image/png", size, ...(path === undefined ? {} : { path }) },
  }) as MessagePart;

describe("toolRuns", () => {
  it("folds consecutive tool calls and lets prose end a run", () => {
    const parts = [text("a"), tool("Bash"), tool("Read"), text("b"), tool("Read"), tool("Edit")];
    const { starts, absorbed } = toolRuns(parts);
    expect([...starts.keys()]).toEqual([1, 4]);
    expect(starts.get(1)).toEqual([parts[1], parts[2]]);
    expect([...absorbed]).toEqual([2, 5]);
  });

  it("reads through a tool's image, which its own card draws", () => {
    const parts = [tool("Read"), image("call-x", "/a.png"), tool("Bash"), text("b")];
    const { starts, absorbed } = toolRuns(parts);
    expect(starts.get(0)).toEqual([parts[0], parts[2]]);
    expect([...absorbed]).toEqual([2]);
  });

  it("reads through the step markers persisted between real tool calls", () => {
    const step = { type: "step-start" } as MessagePart;
    const parts = [step, tool("Bash"), step, tool("Read"), step, text("b"), step, tool("Read")];
    const { starts, absorbed } = toolRuns(parts);
    expect([...starts.keys()]).toEqual([1]);
    expect(starts.get(1)).toEqual([parts[1], parts[3]]);
    expect([...absorbed]).toEqual([3]);
  });

  it("reads through the thinking between tool calls, which leaves no row of its own", () => {
    const thought = { type: "reasoning", text: "", state: "done" } as MessagePart;
    const parts = [thought, tool("Bash"), thought, tool("Read"), thought, tool("Edit")];
    const { starts, absorbed } = toolRuns(parts);
    expect([...starts.keys()]).toEqual([1]);
    expect([...absorbed]).toEqual([3, 5]);
  });

  it("lets thinking that is still streaming end a run, since it draws a row", () => {
    const thinking = { type: "reasoning", text: "", state: "streaming" } as MessagePart;
    const parts = [tool("Bash"), tool("Read"), thinking, tool("Edit")];
    const { starts, absorbed } = toolRuns(parts);
    expect([...starts.keys()]).toEqual([0]);
    expect([...absorbed]).toEqual([1]);
  });

  it("leaves a lone tool call as its own card", () => {
    const { starts, absorbed } = toolRuns([text("a"), tool("Bash"), text("b")]);
    expect(starts.size).toBe(0);
    expect(absorbed.size).toBe(0);
  });

  it("keeps a subagent's card out of a run, and lets it split one", () => {
    const parts = [tool("Read"), tool("Task"), tool("Read"), tool("Bash")];
    const { starts, absorbed } = toolRuns(parts);
    expect([...starts.keys()]).toEqual([2]);
    expect([...absorbed]).toEqual([3]);
  });
});

describe("runSummary", () => {
  it("counts each kind of step in a fixed order", () => {
    expect(runSummary([tool("Read"), tool("Bash"), tool("Read"), tool("Bash")])).toBe(
      "Ran 2 commands, read 2 files",
    );
    expect(runSummary([tool("Edit"), tool("Write"), tool("Grep"), tool("mcp__x__y")])).toBe(
      "Made 2 edits, searched once, used 1 tool",
    );
  });

  it("puts edits first and names the files they changed", () => {
    const edit = (path: string) =>
      tool("Edit", { file_path: path, old_string: "a", new_string: "b" });
    expect(runSummary([tool("Bash"), edit("/r/src/a.ts"), tool("Read")])).toBe(
      "Edited a.ts, ran 1 command, read 1 file",
    );
    expect(runSummary([edit("/r/a.ts"), edit("/r/a.ts"), edit("/r/b.ts")])).toBe(
      "Edited a.ts, b.ts",
    );
    expect(runSummary([edit("/r/a.ts"), edit("/r/b.ts"), edit("/r/c.ts")])).toBe("Edited 3 files");
    expect(
      runSummary([tool("Write", { file_path: "/r/new.ts", content: "x" }), tool("Bash")]),
    ).toBe("Wrote new.ts, ran 1 command");
  });

  it("names a Codex patch's files, and counts an edit that names none", () => {
    const patch = tool("Edit", {
      changes: [
        { path: "/r/new.ts", kind: { type: "add" }, diff: "x\n" },
        { path: "/r/old.ts", kind: { type: "delete" }, diff: "y\n" },
      ],
    });
    expect(runSummary([patch, tool("NotebookEdit")])).toBe("Edited new.ts, old.ts, made 1 edit");
  });
});

describe("stepLabel", () => {
  it("prefers a command's description, then what the call is aimed at", () => {
    expect(
      stepLabel(tool("Bash", { command: "pnpm check", description: "Run the full check" })),
    ).toBe("Run the full check");
    expect(stepLabel(tool("Bash", { command: "pnpm check\necho done" }))).toBe("Bash pnpm check");
    expect(stepLabel(tool("Read", { file_path: "/repo/src/retry.ts" }))).toBe("Read retry.ts");
    expect(stepLabel(tool("Grep", { pattern: "useFakeTimers" }))).toBe("Grep useFakeTimers");
    expect(stepLabel(tool("TodoWrite"))).toBe("TodoWrite");
  });

  it("names a browser input by what the agent said it is for", () => {
    expect(
      stepLabel(
        tool("mcp__gram__browser_click", { ref: "ref_4", actionSummary: "Opens the Filters menu" }),
      ),
    ).toBe("mcp__gram__browser_click Opens the Filters menu");
  });
});

describe("runState", () => {
  it("names the last call in flight and counts failures", () => {
    const running = tool("Bash", {}, "input-available");
    expect(runState([tool("Read", {}, "output-error"), running])).toEqual({
      active: running,
      failed: 1,
      cancelled: 0,
      awaiting: false,
    });
  });

  it("flags a call waiting on the user", () => {
    expect(runState([tool("Read"), tool("Bash", {}, "approval-requested")])).toMatchObject({
      active: undefined,
      awaiting: true,
    });
  });
});

describe("toolImagesOf", () => {
  it("groups images by tool call, in order, showing a stored file once per call", () => {
    const byCall = toolImagesOf([
      image("read-1", "/a.png"),
      text("between"),
      image("shot-1", "/b.png"),
      image("shot-1", "/c.png"),
      image("shot-1", "/b.png"),
      image("read-2", "/a.png"),
      image("big-1"),
      image("big-1"),
    ]);
    expect([...byCall.keys()]).toEqual(["read-1", "shot-1", "read-2", "big-1"]);
    expect(byCall.get("shot-1")?.map((i) => i.path)).toEqual(["/b.png", "/c.png"]);
    expect(byCall.get("read-2")?.map((i) => i.path)).toEqual(["/a.png"]);
    expect(byCall.get("big-1")).toHaveLength(2);
    expect(toolImagesOf([text("none")]).size).toBe(0);
  });

  it("names an image after the file its call read, and otherwise after the tool", () => {
    expect(toolImageName(tool("Read", { file_path: "/repo/docs/logo.png" }), 0, 1)).toBe(
      "logo.png",
    );
    expect(toolImageName(tool("Read", { path: "C:/repo/shot.jpg" }), 1, 3)).toBe(
      "shot.jpg (2 of 3)",
    );
    const mcp = {
      type: "dynamic-tool",
      toolName: "mcp__browser__screenshot",
      toolCallId: "c",
      state: "output-available",
      input: {},
    } as AnyToolPart;
    expect(toolImageName(mcp, 0, 1)).toBe("mcp__browser__screenshot image");
    expect(toolImageName({ ...mcp, input: undefined } as AnyToolPart, 0, 1)).toBe(
      "mcp__browser__screenshot image",
    );
  });

  it("says why an image can't be shown", () => {
    const stored = { toolCallId: "c", mediaType: "image/png", size: 68, path: "/a.png" };
    expect(missingToolImageLabel(stored, "gone")).toBe("Image no longer available");
    expect(
      missingToolImageLabel(
        { toolCallId: "c", mediaType: "image/png", size: 7_500_000 },
        "unstored",
      ),
    ).toBe("Image too large to preview · 7.2 MB");
    expect(
      missingToolImageLabel({ toolCallId: "c", mediaType: "image/heic", size: 900 }, "unstored"),
    ).toBe("Image can't be previewed · image/heic");
  });
});

const user = (id: string, createdAt = 1_000): GramUIMessage => ({
  id,
  role: "user",
  metadata: { turnId: `turn-${id}` as TurnId, createdAt },
  parts: [{ type: "text", text: "Do it" }],
});
const reply = (id: string, parts: MessagePart[], end?: TurnEnd): GramUIMessage => ({
  id,
  role: "assistant",
  metadata: end === undefined ? {} : { turnEnd: end },
  parts,
});
const chapter = { type: "data-chapter", id: "c", data: { id: "c", title: "Fix" } } as MessagePart;
const chip = { type: "data-task-chip", id: "t", data: { id: "t" } } as MessagePart;
const failure = { type: "data-agent-error", id: "e", data: {} } as MessagePart;
const failedTool = () =>
  ({ ...tool("Bash", {}, "output-error"), errorText: "exit 1" }) as AnyToolPart;
const worked = { at: 186_000, reason: "completed" } as const;

describe("turnFolds", () => {
  it("folds everything before the last words, and keeps the last words", () => {
    const parts = [text("a"), chapter, tool("Read"), text("b"), tool("Bash"), text("final")];
    const fold = turnFolds([user("u"), reply("r", parts, worked)], false).get("r")!;
    expect([...fold.hidden]).toEqual([0, 1, 2, 3, 4]);
    expect(fold.row).toEqual({
      state: "worked",
      startedAt: 1_000,
      endedAt: 186_000,
      tools: 2,
      failed: 0,
    });
  });

  it("keeps a last message split into text parts whole", () => {
    const parts = [text("a"), tool("Bash"), text("one"), { type: "step-start" }, text("two")];
    const fold = turnFolds([user("u"), reply("r", parts as MessagePart[], worked)], false);
    expect([...fold.get("r")!.hidden]).toEqual([0, 1]);
  });

  it("folds what the agent did after its last words", () => {
    const parts = [text("a"), text("final"), chapter, tool("Bash")];
    const fold = turnFolds([user("u"), reply("r", parts)], false).get("r")!;
    expect([...fold.hidden]).toEqual([2, 3]);
  });

  it("has no row for a turn with nothing to fold", () => {
    expect(turnFolds([user("u"), reply("r", [text("final")])], false).size).toBe(0);
  });

  it("has no row when it would save none, a lone tool line keeping what it says", () => {
    const lone = [tool("Read"), text("final")];
    expect(turnFolds([user("u"), reply("r", lone)], false).size).toBe(0);
    const run = [tool("Read"), tool("Bash"), text("final")];
    expect(turnFolds([user("u"), reply("r", run)], false).size).toBe(0);
    const onlyTools = [tool("Bash")];
    expect(turnFolds([user("u"), reply("r", onlyTools)], false).size).toBe(0);
  });

  it("counts what it hides across a turn's replies", () => {
    const messages = [user("u"), reply("r1", [tool("Read")]), reply("r2", [tool("Bash")])];
    expect(turnFolds(messages, false).get("r1")?.row?.tools).toBe(2);
  });

  it("keeps a call that returned but goes on in view", () => {
    const agent = tool("Agent");
    const parts = [text("a"), tool("Read"), agent, text("final")];
    const working = new Set([agent.toolCallId]);
    const fold = turnFolds([user("u"), reply("r", parts)], false, working).get("r")!;
    expect([...fold.hidden]).toEqual([0, 1]);
  });

  it("keeps errors, failed tools and waiting approvals out of the fold", () => {
    const failed = failedTool();
    const waiting = tool("Bash", {}, "approval-requested");
    const parts = [text("a"), failed, tool("Read"), waiting, text("final"), failure];
    const fold = turnFolds(
      [user("u"), reply("r", parts, { at: 2_000, reason: "error" })],
      false,
    ).get("r")!;
    expect([...fold.hidden]).toEqual([0, 2]);
    expect([...fold.apart].toSorted()).toEqual([0, 1, 2, 3]);
    expect(fold.row).toMatchObject({ state: "failed", tools: 3, failed: 1 });
    expect(toolRuns(parts, fold.apart).starts.size).toBe(0);
  });

  it("keeps words still arriving in view, whatever the thread's status says", () => {
    const thinking = { type: "reasoning", text: "", state: "streaming" } as MessagePart;
    const parts = [text("a"), tool("Read"), text("final"), thinking];
    const fold = turnFolds([user("u"), reply("r", parts)], false).get("r");
    expect([...(fold?.hidden ?? [])]).toEqual([0, 1]);
  });

  it("keeps a tool still running in a finished turn in view", () => {
    const parts = [text("a"), tool("Read"), tool("Task", {}, "input-available"), text("final")];
    expect([...turnFolds([user("u"), reply("r", parts)], false).get("r")!.hidden]).toEqual([0, 1]);
  });

  it("moves an offered task under the reply, row or no row", () => {
    const folded = [text("a"), tool("Bash"), chip, text("final")];
    expect([...turnFolds([user("u"), reply("r", folded)], false).get("r")!.under]).toEqual([2]);
    const short = turnFolds([user("u"), reply("r", [chip, text("final")])], false).get("r")!;
    expect([...short.under]).toEqual([0]);
    expect(short.row).toBeUndefined();
  });

  it("folds finished steps of a running turn and leaves the current one", () => {
    const parts = [text("a"), tool("Read"), text("b"), tool("Bash", {}, "input-available")];
    const fold = turnFolds([user("u"), reply("r", parts)], true).get("r")!;
    expect([...fold.hidden]).toEqual([0, 1]);
    expect(fold.row).toMatchObject({ state: "running", endedAt: undefined, tools: 2 });
  });

  it("shows a running turn whole until it has a step behind it", () => {
    expect(turnFolds([user("u"), reply("r", [tool("Read"), tool("Bash")])], true).size).toBe(0);
  });

  it("only takes the thread's latest turn for the running one", () => {
    const messages = [
      user("u1"),
      reply("r1", [text("a"), tool("Read"), text("final")], worked),
      user("u2"),
      reply("r2", [text("a"), tool("Read"), text("b")]),
    ];
    const folds = turnFolds(messages, true);
    expect(folds.get("r1")!.row?.state).toBe("worked");
    expect(folds.get("r2")!.row?.state).toBe("running");
  });

  it("believes a stamp over the thread's status", () => {
    const messages = [user("u"), reply("r", [text("a"), tool("Read"), text("b")], worked)];
    expect(turnFolds(messages, true).get("r")!.row?.state).toBe("worked");
  });

  it("names a stopped turn, and a failure from before the stamp", () => {
    const stopped = { at: 2_000, reason: "interrupted" } as const;
    const parts = [text("a"), tool("Read"), text("final")];
    expect(turnFolds([user("u"), reply("r", parts, stopped)], false).get("r")!.row?.state).toBe(
      "stopped",
    );
    expect(
      turnFolds([user("u"), reply("r", [...parts, failure])], false).get("r")!.row?.state,
    ).toBe("failed");
  });

  it("carries the row on a turn's first reply and empties the ones between", () => {
    const messages = [
      user("u"),
      reply("r1", [tool("Read")]),
      reply("r2", [text("a"), tool("Bash")]),
      reply("r3", [tool("Bash"), text("final")]),
    ];
    const folds = turnFolds(messages, false);
    expect(folds.get("r1")).toMatchObject({ row: { tools: 3 }, empty: false });
    expect(folds.get("r2")).toMatchObject({ row: undefined, empty: true });
    expect(folds.get("r3")).toMatchObject({ row: undefined, empty: false });
  });

  it("gives a reply after its turn ended a turn of its own", () => {
    const parts = [text("a"), tool("Read"), text("final")];
    const messages = [user("u"), reply("r1", parts, worked), reply("r2", parts)];
    const folds = turnFolds(messages, false);
    expect(folds.get("r1")!.turn).toBe("turn-u");
    expect(folds.get("r1")!.hidden.has(2)).toBe(false);
    expect(folds.get("r2")!.turn).toBe("r2");
  });

  it("gives a reply the agent started a turn of its own", () => {
    const final = reply("r1", [text("a"), tool("Read"), text("final")]);
    const started = {
      ...reply("r2", [text("b")]),
      metadata: { initiator: "agent" as const },
    };
    const fold = turnFolds([user("u"), final, started], false).get("r1")!;
    expect(fold.hidden.has(2)).toBe(false);
  });

  it("leaves a subagent's transcript alone", () => {
    const nested = { ...reply("n", [text("a"), tool("Read")]) };
    nested.metadata = { parentToolUseId: "task" };
    const folds = turnFolds([user("u"), nested, reply("r", [text("final")])], false);
    expect(folds.has("n")).toBe(false);
  });

  it("folds a turn whose prompt has no turn id, by the prompt", () => {
    const prompt = { ...user("u"), metadata: { createdAt: 1 } };
    const parts = [text("a"), tool("Read"), text("final")];
    expect(turnFolds([prompt, reply("r", parts)], false).get("r")!.turn).toBe("u");
  });
});

const messages = (extra: string): GramUIMessage[] => [
  { id: "u", role: "user", metadata: { createdAt: 1 }, parts: [text("Do it")] },
  { id: "r", role: "assistant", parts: [text("a"), tool("Read"), text(extra)] },
];

describe("reuseFolds", () => {
  it("keeps a fold nothing changed in, so its row's memo holds", () => {
    const first = turnFolds(messages("one"), false);
    const second = reuseFolds(first, turnFolds(messages("two"), false));
    expect(second.get("r")).toBe(first.get("r"));
  });

  it("takes a fold that changed", () => {
    const first = turnFolds(messages("one"), false);
    const next = turnFolds(
      [
        ...messages("one").slice(0, 1),
        { id: "r", role: "assistant", parts: [text("a"), text("b"), tool("Read"), text("c")] },
      ],
      false,
    );
    expect(reuseFolds(first, next).get("r")).toBe(next.get("r"));
  });
});

const turn = (over: Partial<TurnSummary>): TurnSummary => ({
  state: "worked",
  startedAt: 0,
  endedAt: 185_000,
  tools: 5,
  failed: 0,
  ...over,
});

describe("turnFoldLabel", () => {
  it("says how long the turn took and what it used", () => {
    expect(turnFoldLabel(turn({}), 0)).toBe("Worked for 3m 05s · 5 tools");
    expect(turnFoldLabel(turn({ tools: 1 }), 0)).toBe("Worked for 3m 05s · 1 tool");
    expect(turnFoldLabel(turn({ tools: 0 }), 0)).toBe("Worked for 3m 05s");
  });

  it("words each ending", () => {
    expect(turnFoldLabel(turn({ state: "failed", endedAt: 161_000, tools: 4 }), 0)).toBe(
      "Failed after 2m 41s · 4 tools",
    );
    expect(turnFoldLabel(turn({ state: "stopped", endedAt: 72_000, tools: 3 }), 0)).toBe(
      "Stopped after 1m 12s · 3 tools",
    );
  });

  it("counts a running turn up from its start", () => {
    const running = turn({ state: "running", endedAt: undefined, tools: 4 });
    expect(turnFoldLabel(running, 134_000)).toBe("Working for 2m 14s · 4 tools");
  });

  it("drops the duration of a turn from before the stamp", () => {
    expect(turnFoldLabel(turn({ endedAt: undefined }), 0)).toBe("Worked · 5 tools");
    expect(turnFoldLabel(turn({ state: "failed", endedAt: undefined }), 0)).toBe(
      "Failed · 5 tools",
    );
  });
});
