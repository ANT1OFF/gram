import {
  NOTICE_CUT_LINE,
  NOTICE_ROW_CHARS,
  noticeBodyFits,
  noticePlain,
  revealHidden,
  type ApprovalRequest,
  type PendingRequest,
  type WorkspaceId,
} from "@gram/contracts";

import { allowOnceLabel } from "@/thread/request-model";

import type { Ask } from "./ask-model";
import type { SendAction } from "./ask-answer";
import type { WorkspaceAsks } from "./ask-stack";

const MAX_AWAY_COUNT = 99;

const choicesOf = (
  choices: ReadonlyArray<{
    readonly label: string;
    readonly description?: string | undefined;
  }> = [],
) => choices.map((choice) => [choice.label, choice.description ?? null]);

const requestRead = (request: PendingRequest) => {
  switch (request.kind) {
    case "approval":
      return [
        request.toolName,
        request.displayName,
        request.title ?? null,
        request.input,
        request.description ?? null,
      ];
    case "question":
      return request.questions.map((question) => [
        question.question,
        question.header,
        choicesOf(question.options),
        question.multiSelect,
      ]);
    case "plan":
      return [request.plan];
  }
};

/**
 * The ask's own requests, inputs and words, exactly: equal only for the very same ask, so another
 * request in its place, or a question reworded, reads as another ask.
 */
export const askFingerprint = (ask: Ask): string =>
  JSON.stringify([
    ask.key,
    ask.lead,
    ask.description ?? null,
    ask.command ?? null,
    ask.extras,
    choicesOf(ask.options),
    (ask.group?.entries ?? []).map((entry) => [
      entry.threadId,
      entry.request.id,
      entry.request.kind,
      requestRead(entry.request),
    ]),
    ask.memory === undefined
      ? null
      : [
          ask.memory.workspaceId,
          ask.memory.question.text,
          ask.memory.question.detail ?? null,
          choicesOf(ask.memory.question.options),
        ],
    ask.worker === undefined
      ? null
      : [
          ask.worker.workspaceId,
          ask.worker.question.id,
          ask.worker.question.question,
          ask.worker.question.context ?? null,
          ask.worker.question.note ?? null,
          choicesOf(ask.worker.question.options),
        ],
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

const approvalOf = (ask: Ask): ApprovalRequest | undefined => {
  const request = ask.group?.entries[0]?.request;
  return ask.icon === "approval" && request?.kind === "approval" ? request : undefined;
};

const cutLine = (line: string): string => {
  const plain = [...revealHidden(line)].map((char) => (noticePlain(char) ? char : "�"));
  return `${plain.slice(0, NOTICE_ROW_CHARS - 1).join("")}…`;
};

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
    if (request.title !== undefined)
      return times === "" ? request.title : `${request.title}${times}`;
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

const SUBJECT_KEYS = ["command", "file_path", "url"] as const;

const raw = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

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
  const label = mergesPr(request)
    ? "Merge"
    : (ask.options[option]?.label ?? allowOnceLabel(ask.count));
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
