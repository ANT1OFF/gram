import {
  NOTICE_CUT_LINE,
  NOTICE_ROW_CHARS,
  noticeBodyFits,
  noticePlain,
  type ApprovalRequest,
  type WorkspaceId,
} from "@gram/contracts";

import type { Ask } from "./ask-model";
import type { SendAction } from "./ask-answer";
import type { WorkspaceAsks } from "./ask-stack";

// Answering an ask from outside the window: a desktop notification, the menu bar. One rule for
// all of them:
//
// - An approval shows its exact command and extras, or says it was cut short and offers Open only.
// - Allow (Merge for a merge) is the ask's own Allow option, answered with `holdAnswer`.
// - An action answers only the very ask that was shown: same key, same fingerprint, still waiting.
//
// No React.

/** The most equal asks one Allow answers from outside the window ("Allow 99"). */
const MAX_AWAY_COUNT = 99;

/** The ask's own requests and inputs, exactly: equal only for the very same ask. */
export const askFingerprint = (ask: Ask): string =>
  JSON.stringify([
    ask.key,
    ask.command ?? null,
    ask.extras,
    ask.options.map((option) => option.label),
    (ask.group?.entries ?? []).map((entry) => [
      entry.threadId,
      entry.request.id,
      entry.request.kind,
      entry.request.kind === "approval"
        ? [entry.request.toolName, entry.request.input, entry.request.description ?? null]
        : null,
    ]),
    ask.memory === undefined ? null : [ask.memory.workspaceId, ask.memory.question.text],
    ask.worker === undefined
      ? null
      : [ask.worker.workspaceId, ask.worker.question.id, ask.worker.question.question],
  ]);

/**
 * Where an ask lives: its workspace and each request's thread and id. A request id is only unique
 * within one agent process (Codex numbers them from 0), so the same id in another thread or
 * workspace is another ask.
 */
export const askScope = (ask: Ask, workspaceId: WorkspaceId): string =>
  JSON.stringify([
    workspaceId,
    ask.group === undefined
      ? ask.ids
      : ask.group.entries.map((entry) => [entry.threadId, entry.request.id]),
  ]);

/** Each request (or question) of an ask, scoped as `askScope` scopes it, for "seen" sets. */
export const scopedIds = (ask: Ask, workspaceId: WorkspaceId): string[] =>
  ask.group === undefined
    ? ask.ids.map((id) => JSON.stringify([workspaceId, id]))
    : ask.group.entries.map((entry) =>
        JSON.stringify([workspaceId, entry.threadId, entry.request.id]),
      );

/** A stable id for an ask's key, the same in every window: two 32-bit FNV-1a hashes, hex. */
export const awayAskId = (key: string): string => {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `ask-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
};

const MERGE_TOOLS: ReadonlySet<string> = new Set(["merge_when_ready", "set_auto_merge"]);

/** An approval that merges a pull request: a merge tool's call, or `gh pr merge`. */
export const mergesPr = (request: ApprovalRequest): boolean =>
  (MERGE_TOOLS.has(request.displayName) && request.input["enabled"] !== false) ||
  (typeof request.input["command"] === "string" &&
    /^gh pr merge(?:\s|$)/.test(request.input["command"]));

/** The approval an ask answers, if it is one. */
const approvalOf = (ask: Ask): ApprovalRequest | undefined => {
  const request = ask.group?.entries[0]?.request;
  return ask.icon === "approval" && request?.kind === "approval" ? request : undefined;
};

/** A line that can't be shown whole: a plain start, marked as cut. */
const cutLine = (line: string): string => {
  const plain = [...line].map((char) => (noticePlain(char) ? char : "�"));
  return `${plain.slice(0, NOTICE_ROW_CHARS - 1).join("")}…`;
};

/** A plain word or two of the command for a title, or nothing when it has none. */
const verbOf = (command: string): string | undefined => {
  const words = command.trim().split(/\s+/).slice(0, 2);
  const plain = words.filter(
    (word, i) => /^[\w./-]{1,20}$/.test(word) && (i === 0 || !word.startsWith("-")),
  );
  return plain.length === 0 ? undefined : plain.join(" ");
};

/** The template's title: short, from the ask's kind and command, never in place of the command. */
export const templateTitle = (ask: Ask): string => {
  const request = approvalOf(ask);
  const times = ask.count > 1 ? ` × ${ask.count}` : "";
  if (request !== undefined) {
    if (mergesPr(request)) return `Merge a pull request${times}?`;
    const verb =
      ask.command !== undefined && typeof request.input["command"] === "string"
        ? verbOf(ask.command)
        : undefined;
    return `Allow ${verb ?? request.displayName}${times}?`;
  }
  if (ask.icon === "plan") return "A plan to review";
  if (ask.memory !== undefined) return "The orchestrator asks";
  return ask.count > 1 ? `${ask.count} workers ask` : "A worker asks";
};

/** One button that answers: its label and which of the ask's options it takes. */
export interface AwayButton {
  readonly label: string;
  /** Index into the ask's `options`. */
  readonly option: number;
}

/** The input field an approval leads with, as `approvalSubject` picks it. */
const SUBJECT_KEYS = ["command", "file_path", "url"] as const;

/** An input value as the stack's Details shows it: a string as is, anything else as JSON. */
const raw = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * The exact lines an approval answers, from its raw input, or `undefined` when they can't be shown
 * faithfully: a value with a control, format or line-breaking character (a tab, a newline, a bidi
 * override) would read as something else once drawn, so it is refused before anything is joined
 * or normalized.
 *
 * - A command, path or URL: it, then each other argument as `label: value`.
 * - An app tool: the server's description of the resolved call (its PR, method and holds for a
 *   merge), then the tool and its whole input. A merge tool without that description is refused:
 *   its input alone doesn't name the pull request.
 */
const exactLines = (request: ApprovalRequest): string[] | undefined => {
  const key = SUBJECT_KEYS.find((candidate) => typeof request.input[candidate] === "string");
  const lines =
    key === undefined
      ? [
          ...(request.description === undefined || request.description === ""
            ? []
            : [request.description]),
          `${request.displayName} ${JSON.stringify(request.input)}`,
        ]
      : [
          raw(request.input[key]),
          ...Object.entries(request.input).flatMap(([label, value]) =>
            label === key ||
            value === undefined ||
            (label === "description" && value === request.description)
              ? []
              : [`${label}: ${raw(value)}`],
          ),
        ];
  if (!lines.every(noticePlain)) return undefined;
  if (key === undefined && mergesPr(request) && lines.length < 2) return undefined;
  return lines;
};

/** What an ask shows outside the window, and whether it may be answered there. */
export interface AwayAsk {
  /**
   * The exact command and its extras, one per line, when it fits whole; else as much of it as
   * fits and `NOTICE_CUT_LINE`. A question's or plan's words, cut to fit.
   */
  readonly text: string;
  /** Whether `text` is the whole command: the only case an Allow may be offered. */
  readonly whole: boolean;
  /** Allow or Merge; absent for Open only. */
  readonly button?: AwayButton | undefined;
}

/**
 * What `ask` shows outside the window. Allow (or Merge) only when `actions` is on, the ask answers
 * in place with an Allow, and its exact lines (`exactLines`) fit whole (`noticeBodyFits`).
 */
export const awayAsk = (ask: Ask, actions: boolean): AwayAsk => {
  const request = approvalOf(ask);
  if (request === undefined) {
    const words = (ask.icon === "plan" ? ask.context : (ask.freeForm?.question ?? ask.lead))
      .replace(/\s+/g, " ")
      .trim();
    return noticeBodyFits(words)
      ? { text: words, whole: true }
      : { text: cutLine(words), whole: false };
  }
  const lines = exactLines(request);
  if (lines === undefined) {
    const start = ask.command ?? `${request.displayName} ${JSON.stringify(request.input)}`;
    return { text: `${cutLine(start)}\n${NOTICE_CUT_LINE}`, whole: false };
  }
  const text = lines.join("\n");
  if (!noticeBodyFits(text))
    return { text: `${cutLine(lines[0] ?? "")}\n${NOTICE_CUT_LINE}`, whole: false };
  const option = ask.options.findIndex(
    (candidate) => candidate.action.kind === "group" && candidate.action.decision === "allow",
  );
  if (!actions || option < 0 || ask.count > MAX_AWAY_COUNT) return { text, whole: true };
  const label = mergesPr(request) ? "Merge" : ask.count > 1 ? `Allow ${ask.count}` : "Allow";
  return { text, whole: true, button: { label, option } };
};

/** What was shown for an ask, which an action answers against. */
export interface ShownAsk {
  readonly workspaceId: WorkspaceId;
  readonly askKey: string;
  readonly fingerprint: string;
  readonly button?: AwayButton | undefined;
}

/**
 * The ask and answer an action on `shown` sends, or `undefined` to send nothing: the ask was
 * answered, changed or hidden, or the button isn't an Allow it still has.
 */
export const checkAwayAction = (
  all: readonly WorkspaceAsks[],
  shown: ShownAsk,
): { ask: Ask; workspace: WorkspaceAsks; done: string; action: SendAction } | undefined => {
  if (shown.button === undefined) return undefined;
  const found = findShownAsk(all, shown);
  if (found === undefined) return undefined;
  // The button the ask would offer now, with its lines still whole, must be the one shown.
  const now = awayAsk(found.ask, true).button;
  if (now?.label !== shown.button.label || now.option !== shown.button.option) return undefined;
  const option = found.ask.options[now.option];
  if (option?.action.kind !== "group" || option.action.decision !== "allow") return undefined;
  return { ...found, done: option.done, action: option.action };
};

/**
 * The ask `shown` was built from, if it still waits unchanged: in the same workspace, with the
 * same key and the same fingerprint (threads, request ids, tools, inputs, descriptions).
 */
export const findShownAsk = (
  all: readonly WorkspaceAsks[],
  shown: Pick<ShownAsk, "workspaceId" | "askKey" | "fingerprint">,
): { ask: Ask; workspace: WorkspaceAsks } | undefined => {
  const workspace = all.find((candidate) => candidate.workspaceId === shown.workspaceId);
  const ask = workspace?.asks.find((candidate) => candidate.key === shown.askKey);
  if (workspace === undefined || ask === undefined) return undefined;
  return askFingerprint(ask) === shown.fingerprint ? { ask, workspace } : undefined;
};
