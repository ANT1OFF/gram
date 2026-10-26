import type { GramUIMessage } from "@gram/contracts";

import { isToolPart, toolPhase, type AnyToolPart } from "@/thread/parts";
import { toolInputField } from "@/thread/tool-group-model";

// A worker's terminal as its transcript has it: the beside dock's Terminal tab and its peek.
//
// Nothing here starts or reads a process. A command's output arrives in the transcript: Codex sends
// the running command's output as it grows (preliminary `tool-output-available` snapshots, each the
// whole tail so far), and the Claude adapter sends the same snapshots from the output it reads back
// once Claude Code registers the command as a task, a few seconds in. So the running command shows
// live where the agent streams it, and its output on exit where it doesn't. A Claude shell in the
// background has its call's result at once ("Background command started"), so its output comes
// beside the transcript instead (`thread.backgroundOutput`, read back the same way) and stands in
// for that result here.

export interface LastCommand {
  /** The tool call, so a view can tell a new command from more output of the same one. */
  readonly toolCallId: string;
  readonly command: string;
  /** Its output so far, its tail only, as plain text: no escape sequences, `\r` overwrites applied. */
  readonly output: string;
  /** Still running: started, streaming output, or kept going in the background. */
  readonly running: boolean;
  /** It came back as an error, was denied or was cancelled. */
  readonly failed: boolean;
  /** Its exit code, when the agent reported one. */
  readonly exitCode?: number | undefined;
}

/**
 * The newest shell command among `messages`' tool calls: what a worker's terminal is showing.
 * `background` holds the tool calls the agent reports still running in the background, whose cards
 * say they finished when they only went to the background. `backgroundOutput` is what such a
 * call's shell last wrote, by tool call, which shows in place of the call's own output.
 */
export const lastCommandOf = (
  messages: readonly GramUIMessage[],
  background: ReadonlySet<string> = NONE,
  backgroundOutput: ReadonlyMap<string, string> = NO_OUTPUT,
): LastCommand | undefined => {
  for (const message of messages.toReversed()) {
    for (const part of message.parts.toReversed()) {
      if (!isToolPart(part)) continue;
      const command = toolInputField(part.input, "command") ?? toolInputField(part.input, "cmd");
      if (command !== undefined) return commandOf(part, command, background, backgroundOutput);
    }
  }
  return undefined;
};

const NONE: ReadonlySet<string> = new Set();
const NO_OUTPUT: ReadonlyMap<string, string> = new Map();

const commandOf = (
  part: AnyToolPart,
  command: string,
  background: ReadonlySet<string>,
  backgroundOutput: ReadonlyMap<string, string>,
) => {
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
    output: tail(backgroundOutput.get(part.toolCallId) ?? rawOutput(part)),
    running: phase === "pending" || phase === "running" || background.has(part.toolCallId),
    failed: phase === "error" || phase === "denied" || phase === "cancelled",
    ...(exitCode === null ? {} : { exitCode }),
  };
};

const numberField = (output: unknown, keys: readonly string[]): number | null => {
  if (typeof output !== "object" || output === null) return null;
  for (const key of keys) {
    const value: unknown = Reflect.get(output, key);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
};

const OUTPUT_TAIL = 8_000;

/** A command's output as it came back: stdout then stderr, or the text it came back as. */
const rawOutput = (part: AnyToolPart): string => {
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
const tail = (text: string): string => {
  // Cleaned from a little more than is kept, so a sequence cut in half at the edge is dropped too.
  const clean = terminalText(text.length <= OUTPUT_TAIL * 2 ? text : text.slice(-OUTPUT_TAIL * 2));
  return clean.length <= OUTPUT_TAIL ? clean : clean.slice(-OUTPUT_TAIL);
};

// Control sequences a shell's output carries for a terminal to act on: colours and cursor moves
// (CSI), titles and links (OSC, ended by BEL or ST), and the other escapes (charset picks, keypad
// modes). A plain-text view shows none of them. Matching control characters is the point here.
/* oxlint-disable no-control-regex */
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
