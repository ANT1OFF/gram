import * as Schema from "effect/Schema";
import { MessageId, ThreadId } from "./ids.ts";

/**
 * What waits on the user: things the user owes a thread outside the
 * conversation, such as a draft to send, a link to review or a step only they can take. Only these
 * deliverables are stored, as `WaitItem`s. Questions and pending requests keep their own stores and
 * are folded into a `WaitView` when a surface lists them.
 */

/** The longest a title is, as the tray's line shows it. */
export const WAIT_TITLE_MAX = 80;
/** The longest a body is: why the item waits, or what it is. */
export const WAIT_BODY_MAX = 500;
/** The longest text Copy puts on the clipboard. */
export const WAIT_COPY_MAX = 20_000;
/**
 * The most items one thread keeps open, suggestions not counted; the next is refused until one is
 * resolved or updated.
 */
export const MAX_OPEN_WAITS = 12;
/** How long an item the helper resolved offers Undo in the tray. */
export const HELPER_RESOLVE_UNDO_MS = 10 * 60_000;

/** An item of a thread's Waiting on you; unique within the thread. */
export const WaitId = Schema.NonEmptyString.pipe(Schema.brand("WaitId"));
export type WaitId = typeof WaitId.Type;

/**
 * What the user is to do: send a `draft` elsewhere, read or approve a `review` link, make a
 * `decision` the agent can't, or take an `action` only they can. A stored literal: never removed.
 */
export const WaitKind = Schema.Literals(["draft", "review", "decision", "action"]);
export type WaitKind = typeof WaitKind.Type;

/** Who added an item: the agent (`wait_on_user`), the helper model, or the user. Stored. */
export const WaitSource = Schema.Literals(["agent", "helper", "user"]);
export type WaitSource = typeof WaitSource.Type;

/** Who resolved an item. Stored. */
export const WaitResolver = Schema.Literals(["agent", "user", "helper"]);
export type WaitResolver = typeof WaitResolver.Type;

/** One deliverable waiting on the user, as `wait_items` stores it. */
export const WaitItem = Schema.Struct({
  id: WaitId,
  kind: WaitKind,
  /** The tray's line: "Teams message to Kari: rollout". Plain text. */
  title: Schema.String,
  /** Why it waits, or what it is; plain text, shown on the expanded row. */
  body: Schema.optionalKey(Schema.String),
  /** The exact text Copy puts on the clipboard; absent, Copy takes it from the anchored message. */
  copy: Schema.optionalKey(Schema.String),
  /** An http(s) link Open opens. */
  link: Schema.optionalKey(Schema.String),
  source: WaitSource,
  /** Epoch ms. */
  createdAt: Schema.Number,
  /** Epoch ms of the last update in place; absent until one. */
  updatedAt: Schema.optionalKey(Schema.Number),
  /** The message it was added in, for Jump to; absent when there is none. */
  messageId: Schema.optionalKey(MessageId),
  /** Epoch ms; absent while it waits. */
  resolvedAt: Schema.optionalKey(Schema.Number),
  resolvedBy: Schema.optionalKey(WaitResolver),
  /** What the resolver said about it ("sent in Teams"). */
  note: Schema.optionalKey(Schema.String),
  /**
   * Proposed by the helper model and not yet kept: listed dashed, never counted and drawn as no
   * chip. Kept, the flag goes; dismissed, or lapsed when the user next sends, it is resolved.
   */
  suggested: Schema.optionalKey(Schema.Literal(true)),
  /**
   * Bumped on every change to the item, an update in place, Done and Undo alike, so whoever read it
   * can tell it changed since; absent is 0.
   */
  revision: Schema.optionalKey(Schema.Int),
});
export type WaitItem = typeof WaitItem.Type;

/** Whether `item` still waits on the user. */
export const waitIsOpen = (item: Pick<WaitItem, "resolvedAt">): boolean =>
  item.resolvedAt === undefined;

/** Whether `item` counts: open and not a suggestion still to be kept. */
export const waitIsKept = (item: Pick<WaitItem, "resolvedAt" | "suggested">): boolean =>
  waitIsOpen(item) && item.suggested !== true;

/**
 * The `data-wait` part in the transcript where an item was added: its line, restyled as it is
 * resolved. `revised` means a later update moved the item to another message.
 */
export const WaitDataSchema = Schema.Struct({
  id: WaitId,
  kind: WaitKind,
  title: Schema.String,
  state: Schema.Literals(["open", "done", "revised"]),
  /** Epoch ms it was resolved, while `done`. */
  resolvedAt: Schema.optionalKey(Schema.Number),
  resolvedBy: Schema.optionalKey(WaitResolver),
});
export type WaitData = typeof WaitDataSchema.Type;

/** The chip an item draws where it was added, in the state the item is in. */
export const waitData = (item: WaitItem, state?: "revised"): WaitData => ({
  id: item.id,
  kind: item.kind,
  title: item.title,
  state: state ?? (waitIsOpen(item) ? "open" : "done"),
  ...(item.resolvedAt === undefined ? {} : { resolvedAt: item.resolvedAt }),
  ...(item.resolvedBy === undefined ? {} : { resolvedBy: item.resolvedBy }),
});

/** Where a `WaitView` row comes from: a stored item's source, or a store it is folded in from. */
export const WaitViewSource = Schema.Literals(["agent", "helper", "user", "question", "request"]);
export type WaitViewSource = typeof WaitViewSource.Type;

/** A row's kind: a stored item's, or an open question's, or a pending request's. */
export const WaitViewKind = Schema.Literals([
  "draft",
  "review",
  "decision",
  "action",
  "question",
  "approval",
  "plan",
]);
export type WaitViewKind = typeof WaitViewKind.Type;

/**
 * One row of Waiting on you, the read model the tray, the sidebar count and the board all list.
 * Each action still goes to its source's own answer path.
 */
export const WaitView = Schema.Struct({
  /** `w:<threadId>:<id>` for a stored item, `q:<workspaceId>:<questionId>`, `r:<threadId>:<requestId>`. */
  key: Schema.String,
  /** Where it lives; for a question, the orchestrator. */
  threadId: ThreadId,
  source: WaitViewSource,
  kind: WaitViewKind,
  title: Schema.String,
  /** One line, plain text. */
  preview: Schema.optionalKey(Schema.String),
  /** Epoch ms. */
  createdAt: Schema.Number,
  /** Jump to's target. */
  messageId: Schema.optionalKey(MessageId),
  /** Proposed by the helper and not yet kept: listed, never counted. */
  suggested: Schema.optionalKey(Schema.Literal(true)),
});
export type WaitView = typeof WaitView.Type;

/** A stored item's row, with a one-line preview from its body or its copy text. */
export const waitViewOf = (threadId: ThreadId, item: WaitItem): WaitView => {
  const preview = (item.body ?? item.copy)?.replace(/\s+/gu, " ").trim();
  return {
    key: `w:${threadId}:${item.id}`,
    threadId,
    source: item.source,
    kind: item.kind,
    title: item.title,
    ...(preview === undefined || preview === "" ? {} : { preview }),
    createdAt: item.createdAt,
    ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
    ...(item.suggested === true ? { suggested: true } : {}),
  };
};

/**
 * Agent-written text as plain left-to-right text: bidirectional overrides, isolates and invisible
 * spaces are dropped, so it can't reorder or hide what the row says, and other control characters
 * become spaces. `multiline` keeps line breaks and tabs, for a body or the text Copy copies.
 */
export const plainWaitText = (text: string, multiline = false): string => {
  const visible = text.replace(
    /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu,
    "",
  );
  return multiline
    ? visible.replace(/\r\n?/gu, "\n").replace(/[^\P{Cc}\n\t]+/gu, " ")
    : visible.replace(/\p{Cc}+/gu, " ").trim();
};

/** Whether `link` is one Open may open: an absolute http(s) URL. */
export const isWaitLink = (link: string): boolean => {
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    // Not a URL at all.
    return false;
  }
};

/** The longest a title made from a message is, as "Add to Waiting on you" names it. */
export const WAIT_TITLE_FROM_MESSAGE_MAX = 60;

/** One Markdown marker opening a line; each is stripped in turn, so no pattern backtracks. */
const LINE_MARKER = /^(?:#{1,6}[ \t]|>|[-*+][ \t]|\d{1,9}[.)][ \t])/u;
const FENCE_LINE = /^(?:`{3}|~{3})/u;

/** `line` without the markers that open it. */
const unmarked = (line: string): string => {
  let rest = line.trimStart();
  for (let marker = LINE_MARKER.exec(rest); marker !== null; marker = LINE_MARKER.exec(rest)) {
    rest = rest.slice(marker[0].length).trimStart();
  }
  return rest;
};

/**
 * The title of an item the user adds from a message: its first line with text, without the
 * Markdown that opens a heading, quote or list item, and not a fence's own line, plain and clipped
 * to `WAIT_TITLE_FROM_MESSAGE_MAX`. `undefined` for a message with no text.
 */
export const waitTitleOf = (text: string): string | undefined => {
  for (const raw of text.split("\n")) {
    const marked = unmarked(raw);
    if (FENCE_LINE.test(marked)) continue;
    const line = plainWaitText(marked.replace(/[*_`]+/gu, ""));
    if (line === "") continue;
    return line.length <= WAIT_TITLE_FROM_MESSAGE_MAX
      ? line
      : `${line.slice(0, WAIT_TITLE_FROM_MESSAGE_MAX - 1).trimEnd()}…`;
  }
  return undefined;
};

/**
 * A title as the note quotes it: a JSON string, with angle brackets escaped, so text the agent or a
 * reply wrote can neither close the quote nor the fence and pass for Gram's own words.
 */
const quotedTitle = (title: string) =>
  JSON.stringify(title).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");

const named = (items: ReadonlyArray<WaitItem>) =>
  items.map((item) => `${quotedTitle(item.title)} (${item.id})`).join(", ");

/**
 * What Gram tells the agent of Waiting on you, with the user's
 * next message. `news` are the items whose state the agent hasn't heard: resolved by the user or
 * the helper, added or kept by the user, or reopened after the agent was told they were done. The
 * rest of `open` follows as still waiting. `undefined` without news.
 */
export const waitNoteText = (
  news: ReadonlyArray<WaitItem>,
  open: ReadonlyArray<WaitItem>,
): string | undefined => {
  if (news.length === 0) return undefined;
  const fresh = new Set(news.map((item) => item.id));
  const done = news.filter((item) => !waitIsOpen(item));
  // A suggestion the user kept is theirs as much as one they added.
  const added = news.filter((item) => waitIsOpen(item) && item.source !== "agent");
  const reopened = news.filter((item) => waitIsOpen(item) && item.source === "agent");
  const still = open.filter((item) => !fresh.has(item.id));
  const sentences = [
    done.length === 0 ? undefined : `The user marked done: ${named(done)}.`,
    added.length === 0
      ? undefined
      : `The user added to Waiting on you, to act on themselves: ${named(added)}.`,
    reopened.length === 0 ? undefined : `The user reopened: ${named(reopened)}.`,
    still.length === 0 ? undefined : `Still waiting: ${named(still)}.`,
  ].filter((sentence) => sentence !== undefined);
  return sentences.join(" ");
};

/** A note as it follows the user's text, fenced so the agent reads it as Gram's. */
export const fenceWaitNote = (note: string): string => `<gram-note>${note}</gram-note>`;

/** The `data-wait-note` part of a user message: what Gram told the agent with it. */
export const WaitNoteDataSchema = Schema.Struct({
  /** The note as the agent read it, after the user's text. */
  text: Schema.String,
});
export type WaitNoteData = typeof WaitNoteDataSchema.Type;

/** Which items a list answers: the open ones, or with `all` the resolved ones kept too. */
export const WaitListState = Schema.Literals(["open", "all"]);
export type WaitListState = typeof WaitListState.Type;
