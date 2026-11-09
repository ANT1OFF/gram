import type {
  BackgroundOutput,
  BackgroundTask,
  GramUIMessage,
  SubagentUsageData,
  ThreadId,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { commandSnapshot, stateLabel, type OpenCommand } from "./command-view-model";

let ids = 0;
const message = (...parts: unknown[]): GramUIMessage =>
  ({ id: `m${++ids}`, role: "assistant", parts }) as unknown as GramUIMessage;

const THREAD = "t-1" as ThreadId;
const COMMAND = "pnpm dev --port 5173 && echo 'served from a long command line'";

const open = (more: Partial<OpenCommand> = {}): OpenCommand => ({
  threadId: THREAD,
  taskId: "b1",
  toolCallId: "call-1",
  command: COMMAND,
  startedAt: 1_000,
  ...more,
});

const task = (more: Partial<BackgroundTask> = {}): BackgroundTask => ({
  taskId: "b1",
  kind: "shell",
  description: "Start the dev server",
  command: COMMAND,
  toolCallId: "call-1",
  startedAt: 1_000,
  ...more,
});

/** A Claude Bash call sent to the background: its result came at once and says only that. */
const claudeBackground = message({
  type: "tool-Bash",
  toolCallId: "call-1",
  state: "output-available",
  input: { command: COMMAND, run_in_background: true },
  output: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b1" },
});

/** A Codex command: a dynamic tool part under Claude's name, with the folder it ran in. */
const call = (more: Record<string, unknown>) =>
  message({
    type: "dynamic-tool",
    toolName: "Bash",
    toolCallId: "item-1",
    input: { command: "uv run pytest", cwd: "/work/repo" },
    ...more,
  });

/** A Claude Bash call in the foreground. */
const fg = (more: Record<string, unknown>) =>
  message({ type: "tool-Bash", toolCallId: "call-1", input: { command: COMMAND }, ...more });

const snapshot = ({
  messages = [claudeBackground],
  background = [],
  backgroundOutput = [],
  usage = new Map(),
  opened = open(),
}: {
  messages?: readonly GramUIMessage[];
  background?: readonly BackgroundTask[];
  backgroundOutput?: readonly BackgroundOutput[];
  usage?: ReadonlyMap<string, SubagentUsageData>;
  opened?: OpenCommand;
}) => commandSnapshot({ open: opened, messages, background, backgroundOutput, usage });

describe("a command in the Command tab", () => {
  it("follows a Claude background shell's output beside the transcript while its task runs", () => {
    const running = snapshot({
      background: [task()],
      backgroundOutput: [
        { taskId: "b1", toolCallId: "call-1", output: "\u001b[32mVITE ready\u001b[0m\n" },
      ],
    });
    expect(running).toEqual({
      command: COMMAND,
      cwd: undefined,
      output: "VITE ready\n",
      state: "running",
      exitCode: undefined,
      background: true,
    });
    expect(stateLabel(running)).toBe("Running");
  });

  it("has no output yet before the adapter has read any back", () => {
    expect(snapshot({ background: [task()] })).toMatchObject({ output: "", state: "running" });
  });

  it("ends as the agent reports it: finished, failed or stopped", () => {
    const ended = (status: SubagentUsageData["status"]) =>
      snapshot({ usage: new Map([["call-1", { toolCallId: "call-1", status }]]) });
    expect(snapshot({}).state).toBe("done");
    expect(stateLabel(snapshot({}))).toBe("Finished");
    expect(ended("completed").state).toBe("done");
    expect(ended("failed").state).toBe("failed");
    expect(ended("stopped").state).toBe("stopped");
    expect(stateLabel(ended("stopped"))).toBe("Stopped");
  });

  it("keeps what a background shell last wrote once its task has gone", () => {
    expect(
      snapshot({ backgroundOutput: [{ taskId: "b1", toolCallId: "call-1", output: "bye\n" }] }),
    ).toMatchObject({ output: "bye\n", state: "done", background: false });
  });

  it("streams a Codex command's output in its call, with its folder and exit code", () => {
    const opened = open({ taskId: "turn-1:item-1", toolCallId: "item-1", command: "uv run" });
    const running = snapshot({
      opened,
      messages: [
        call({
          state: "output-available",
          preliminary: true,
          output: { stdout: "collected 52 items", stderr: "", interrupted: false },
        }),
      ],
      background: [task({ taskId: "turn-1:item-1", toolCallId: "item-1" })],
    });
    expect(running).toMatchObject({
      command: "uv run pytest",
      cwd: "/work/repo",
      output: "collected 52 items",
      state: "running",
    });
    const exited = (exitCode: number) =>
      snapshot({
        opened,
        messages: [
          call({
            state: "output-available",
            output: { stdout: "1 failed", stderr: "", interrupted: false, exitCode },
          }),
        ],
      });
    expect(exited(1)).toMatchObject({ state: "failed", exitCode: 1, output: "1 failed" });
    expect(stateLabel(exited(1))).toBe("Exited 1");
    expect(exited(0)).toMatchObject({ state: "done", exitCode: 0 });
    expect(stateLabel(exited(0))).toBe("Exited 0");
  });

  it("follows a foreground call's interim output until its result, which replaces it", () => {
    expect(snapshot({ messages: [fg({ state: "input-available" })] })).toMatchObject({
      output: "",
      state: "running",
    });
    expect(
      snapshot({
        messages: [
          fg({
            state: "output-available",
            preliminary: true,
            output: { stdout: "step 1", stderr: "", interrupted: false },
          }),
        ],
      }),
    ).toMatchObject({ output: "step 1", state: "running" });
    expect(
      snapshot({
        messages: [fg({ state: "output-error", errorText: "Exit code 2\nboom" })],
      }),
    ).toMatchObject({ output: "Exit code 2\nboom", state: "failed" });
    expect(
      snapshot({
        messages: [
          fg({
            state: "output-available",
            output: { stdout: "partial", stderr: "", interrupted: true },
          }),
        ],
      }).state,
    ).toBe("stopped");
  });

  it("finds a call in a subagent's lane, and keeps the strip's command when there is none", () => {
    const nested = {
      ...claudeBackground,
      id: "lane-1",
      metadata: { parentToolUseId: "task-9" },
    } as GramUIMessage;
    expect(snapshot({ messages: [nested], background: [task()] }).state).toBe("running");
    expect(
      snapshot({
        messages: [],
        background: [task({ command: "from the task" })],
        opened: open({ toolCallId: undefined }),
      }).command,
    ).toBe("from the task");
    expect(snapshot({ messages: [], opened: open({ toolCallId: undefined }) }).command).toBe(
      COMMAND,
    );
  });
});
