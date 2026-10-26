import { describe, expect, it } from "vitest";

import type { AnyToolPart, MessagePart } from "./parts";
import {
  missingToolImageLabel,
  runState,
  runSummary,
  stepLabel,
  toolImageName,
  toolImagesOf,
  toolRuns,
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
