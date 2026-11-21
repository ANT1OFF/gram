import type { GramUIMessage } from "@gram/contracts";

import { isToolPart, toolPhase, type AnyToolPart } from "@/thread/parts";
import { toolInputField } from "@/thread/tool-group-model";

export interface LastCommand {
  /** The tool call, so a view can tell a new command from more output of the same one. */
  readonly toolCallId: string;
  readonly command: string;
  /** Its output so far, its tail only, as plain text: no escape sequences, `\r` overwrites applied. */
  readonly output: string;
  /** Still running: started, or streaming output. */
  readonly running: boolean;
  /** It came back as an error, was denied or was cancelled. */
  readonly failed: boolean;
  /** Its exit code, when the agent reported one. */
  readonly exitCode?: number | undefined;
}

/** The newest shell command among `messages`' tool calls, and how it stands. */
export const lastCommandOf = (messages: readonly GramUIMessage[]): LastCommand | undefined => {
  for (const message of messages.toReversed()) {
    for (const part of message.parts.toReversed()) {
      if (!isToolPart(part)) continue;
      const command = toolInputField(part.input, "command") ?? toolInputField(part.input, "cmd");
      if (command !== undefined) return commandOf(part, command);
    }
  }
  return undefined;
};

const commandOf = (part: AnyToolPart, command: string) => {
  const phase = toolPhase(
    part.state,
    part.state === "output-error" ? part.errorText : undefined,
    part.state === "output-available" && part.preliminary === true,
  );
  const exitCode =
    part.state === "output-available" ? numberField(part.output, ["exitCode", "exit_code"]) : null;
  return {
    toolCallId: part.toolCallId,
    command,
    output: tail(rawOutput(part)),
    running: phase === "pending" || phase === "running",
    failed: phase === "error" || phase === "denied" || phase === "cancelled",
    ...(exitCode === null ? {} : { exitCode }),
  };
};

export const numberField = (output: unknown, keys: readonly string[]): number | null => {
  if (typeof output !== "object" || output === null) return null;
  for (const key of keys) {
    const value: unknown = Reflect.get(output, key);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
};

const OUTPUT_TAIL = 8_000;

/** A command's output as it came back: stdout then stderr, or the text it came back as. */
export const rawOutput = (part: AnyToolPart): string => {
  if (part.state === "output-error") return part.errorText;
  if (part.state !== "output-available") return "";
  const output: unknown = part.output;
  return typeof output === "string"
    ? output
    : typeof output === "object" && output !== null
      ? [
          Reflect.get(output, "stdout"),
          Reflect.get(output, "stderr"),
          Reflect.get(output, "output"),
          Reflect.get(output, "aggregated_output"),
        ]
          .filter((each): each is string => typeof each === "string" && each !== "")
          .join("\n")
      : "";
};

/** Output as plain text, its tail only. */
export const tail = (text: string): string => {
  const clean = terminalText(text.length <= OUTPUT_TAIL * 2 ? text : text.slice(-OUTPUT_TAIL * 2));
  return clean.length <= OUTPUT_TAIL ? clean : clean.slice(-OUTPUT_TAIL);
};

/* oxlint-disable no-control-regex -- these patterns match terminal control characters on purpose */
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const ESC = /\u001b(?:[ -/]*[0-~])?/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;
const ANY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
/* oxlint-enable no-control-regex */

/**
 * `raw` as a terminal would leave it, near enough for a read-only view: escape sequences dropped,
 * and a line rewritten after a carriage return (a progress bar's) shows only its last rewrite.
 */
export const terminalText = (raw: string): string => {
  if (!ANY_CONTROL.test(raw)) return raw;
  return raw
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => {
      const kept = line.replace(/\r+$/, "");
      return kept.slice(kept.lastIndexOf("\r") + 1);
    })
    .join("\n")
    .replace(CONTROL, "");
};
