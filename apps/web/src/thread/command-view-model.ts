import type {
  BackgroundOutput,
  BackgroundTask,
  GramUIMessage,
  SubagentUsageData,
  ThreadId,
} from "@gram/contracts";

import { numberField, rawOutput, tail } from "@/orchestration/last-command";

import { isToolPart, toolPhase, type AnyToolPart } from "./parts";
import { toolInputField } from "./tool-group-model";

// The right panel's Command tab: one command the agent ran, opened from its line above the
// composer. Nothing here starts, reads or stops a process. Its output is what already reaches the
// client: Codex streams a command's output into its tool call as it grows; the Claude adapter reads
// a running shell's output back from the CLI (on the thread's own machine, through its session) and
// sends it as preliminary output for a call still waiting, or beside the transcript
// (`thread.backgroundOutput`) for a shell in the background, whose call already has its result.

/** The command the Command tab shows, as its line in the strip named it when it was opened. */
export interface OpenCommand {
  readonly threadId: ThreadId;
  /** The agent's task for it, while it is one: what Stop stops and its output is filed under. */
  readonly taskId: string | undefined;
  /** The tool call that ran it, whose card and result the transcript holds. */
  readonly toolCallId: string | undefined;
  /** The whole command, as the strip had it; the tool call's own input wins once found. */
  readonly command: string;
  readonly startedAt: number | undefined;
}

/** Where it stands: still going, or how it ended. */
export type CommandState = "running" | "done" | "failed" | "stopped";

export interface CommandSnapshot {
  readonly command: string;
  /** The folder it ran in, where the agent reports one (Codex does; Claude Code's Bash doesn't). */
  readonly cwd: string | undefined;
  /** Its output so far, its tail only, as plain text: no escape sequences, `\r` overwrites applied. */
  readonly output: string;
  readonly state: CommandState;
  /** Its exit code, when the agent reported one. */
  readonly exitCode: number | undefined;
  /** The task is still listed in the background. */
  readonly background: boolean;
}

const callOf = (
  messages: readonly GramUIMessage[],
  toolCallId: string,
): AnyToolPart | undefined => {
  for (const message of messages.toReversed()) {
    for (const part of message.parts) {
      if (isToolPart(part) && part.toolCallId === toolCallId) return part;
    }
  }
  return undefined;
};

/**
 * The command `open` names as the thread has it now: its tool call (anywhere in the feed, a
 * subagent's lane included), its background task while one is listed, the output the adapter last
 * read back for that task, and how the agent said the task ended (`usage`, by tool call).
 */
export function commandSnapshot({
  open,
  messages,
  background,
  backgroundOutput,
  usage,
}: {
  open: OpenCommand;
  messages: readonly GramUIMessage[];
  background: readonly BackgroundTask[];
  backgroundOutput: readonly BackgroundOutput[];
  usage: ReadonlyMap<string, SubagentUsageData>;
}): CommandSnapshot {
  const ours = (each: { taskId: string; toolCallId?: string | undefined }) =>
    (open.taskId !== undefined && each.taskId === open.taskId) ||
    (open.toolCallId !== undefined && each.toolCallId === open.toolCallId);
  const task = background.find(ours);
  const beside = backgroundOutput.find(ours);
  const toolCallId = open.toolCallId ?? task?.toolCallId ?? beside?.toolCallId;
  const part = toolCallId === undefined ? undefined : callOf(messages, toolCallId);
  const phase =
    part === undefined
      ? undefined
      : toolPhase(
          part.state,
          part.state === "output-error" ? part.errorText : undefined,
          part.state === "output-available" && part.preliminary === true,
        );
  const running =
    task !== undefined || phase === "pending" || phase === "running" || phase === "awaiting";
  const ended = toolCallId === undefined ? undefined : usage.get(toolCallId)?.status;
  const exitCode =
    !running && part?.state === "output-available"
      ? (numberField(part.output, ["exitCode", "exit_code"]) ?? undefined)
      : undefined;
  const interrupted =
    part?.state === "output-available" &&
    typeof part.output === "object" &&
    part.output !== null &&
    Reflect.get(part.output, "interrupted") === true;
  const state: CommandState = running
    ? "running"
    : ended === "stopped" || phase === "cancelled" || interrupted
      ? "stopped"
      : ended === "failed" ||
          phase === "error" ||
          phase === "denied" ||
          (exitCode !== undefined && exitCode !== 0)
        ? "failed"
        : "done";
  // A shell in the background writes beside the transcript: its call's own result only said it
  // started. Anywhere else the call carries the output, interim while it runs and final once done.
  const output =
    beside !== undefined ? tail(beside.output) : part === undefined ? "" : tail(rawOutput(part));
  const command =
    (part === undefined
      ? undefined
      : (toolInputField(part.input, "command") ?? toolInputField(part.input, "cmd"))) ??
    task?.command ??
    open.command;
  return {
    command,
    cwd: part === undefined ? undefined : toolInputField(part.input, "cwd"),
    output,
    state,
    exitCode,
    background: task !== undefined,
  };
}

/** The state in a word or two, as the tab's header says it. */
export const stateLabel = (snapshot: Pick<CommandSnapshot, "state" | "exitCode">): string => {
  switch (snapshot.state) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "failed":
      return snapshot.exitCode === undefined ? "Failed" : `Exited ${snapshot.exitCode}`;
    case "done":
      return snapshot.exitCode === undefined ? "Finished" : `Exited ${snapshot.exitCode}`;
  }
};
