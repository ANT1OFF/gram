// A stored message as the event sink sends it (`message`), cut to fit one event when it is large.
//
// A message can be megabytes, nearly all of it what tools returned. An event is at most
// `SINK_MESSAGE_EVENT_MAX_BYTES`, so what is cut goes in this order, largest first within each
// step, and only as far as it takes: what tools returned, what tools were given, every other part
// that isn't text, and last the text itself. Each cut leaves a mark where it was made
// (`SinkTruncated`). The whole message stays in the server's own store.

import {
  type GramUIMessage,
  SINK_MESSAGE_EVENT_MAX_BYTES,
  type SinkTruncated,
  type ThreadId,
} from "@gram/contracts";
import type { StoredMessage } from "../persistence/thread-store.ts";
import type { SinkRecord } from "./event-sink.ts";

/** Kept free of an event's size for what the outbox adds to it: its number and its time. */
const ENVELOPE_BYTES = 128;

/** What ends a text that was cut. */
export const TEXT_CUT_MARK = "\n[truncated]";

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "null");

type Part = Record<string, unknown> & { readonly type: string };

const isTool = (part: Part): boolean =>
  part.type.startsWith("tool-") || part.type === "dynamic-tool";

const mark = (bytes: number, part?: string): SinkTruncated => ({
  truncated: true,
  bytes,
  ...(part === undefined ? {} : { part }),
});

/** The longest start of `text` whose JSON is at most `bytes`, never ending inside a pair. */
const startOf = (text: string, bytes: number): string => {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytesOf(text.slice(0, middle)) <= bytes) low = middle;
    else high = middle - 1;
  }
  const last = text.charCodeAt(low - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? low - 1 : low);
};

/**
 * `message` as it fits in `budget` bytes of JSON, and whether anything was cut. Never more than
 * `budget`, whatever the message holds.
 */
export const fitMessage = (
  message: GramUIMessage,
  budget: number,
): { readonly message: GramUIMessage; readonly truncated: boolean } => {
  let total = bytesOf(message);
  if (total <= budget) return { message, truncated: false };
  const parts = (message.parts as ReadonlyArray<Part>).map((part): Part => ({ ...part }));
  const result = (): GramUIMessage => ({ ...message, parts }) as unknown as GramUIMessage;

  /** Cuts the largest first, until the message fits or there is nothing left to cut. */
  const cut = (
    candidates: ReadonlyArray<{ readonly bytes: number; readonly apply: () => number }>,
  ) => {
    for (const candidate of candidates.toSorted((a, b) => b.bytes - a.bytes)) {
      if (total <= budget) return;
      total += candidate.apply() - candidate.bytes;
    }
  };

  /** A tool part's `field`, replaced by its mark where that makes it smaller. */
  const fields = (field: "output" | "input") =>
    parts.flatMap((part, index) => {
      if (!isTool(part) || part[field] === undefined) return [];
      const bytes = bytesOf(part[field]);
      const replacement = mark(bytes);
      const after = bytesOf(replacement);
      if (after >= bytes) return [];
      return [
        {
          bytes,
          apply: () => {
            parts[index] = { ...parts[index]!, [field]: replacement };
            return after;
          },
        },
      ];
    });

  cut(fields("output"));
  cut(fields("input"));
  // Every other part that isn't text, whole: a file, a drawing, a tool call's error.
  cut(
    parts.flatMap((part, index) => {
      if (part.type === "text") return [];
      const bytes = bytesOf(part);
      const replacement: Part = { type: "data-truncated", data: mark(bytes, part.type) };
      const after = bytesOf(replacement);
      if (after >= bytes) return [];
      return [
        {
          bytes,
          apply: () => {
            parts[index] = replacement;
            return after;
          },
        },
      ];
    }),
  );
  // The text itself, only when it alone is too much: the largest gives up what is over.
  const texts = parts
    .flatMap((part, index) =>
      part.type === "text" && typeof part["text"] === "string"
        ? [{ index, text: part["text"], bytes: bytesOf(part["text"]) }]
        : [],
    )
    .toSorted((a, b) => b.bytes - a.bytes);
  for (const { index, text, bytes } of texts) {
    if (total <= budget) break;
    const kept = startOf(text, Math.max(0, bytes - (total - budget) - TEXT_CUT_MARK.length));
    const shortened = `${kept}${TEXT_CUT_MARK}`;
    const after = bytesOf(shortened);
    if (after >= bytes) continue;
    parts[index] = { ...parts[index]!, text: shortened };
    total += after - bytes;
  }
  if (bytesOf(result()) <= budget) return { message: result(), truncated: true };
  // What is left is over by its metadata or by more small parts than fit: only the mark is sent.
  return {
    message: {
      id: message.id,
      role: message.role,
      parts: [{ type: "data-truncated", data: mark(bytesOf(message)) }],
    } as unknown as GramUIMessage,
    truncated: true,
  };
};

/**
 * The `message` event for a stored message. `where` is the thread and its workspace, as the sink
 * scopes every thread's events; `now` stands for a message that doesn't say when it was written.
 */
export const messageEvent = (
  where: { readonly threadId: ThreadId; readonly workspaceId?: string },
  stored: StoredMessage,
  now: number,
): SinkRecord => {
  const { message } = stored;
  const person = message.metadata?.sentBy;
  const build = (fitted: GramUIMessage, truncated: boolean): SinkRecord => ({
    type: "message",
    ...where,
    ...(person === undefined ? {} : { actor: { kind: "person" as const, id: person } }),
    data: {
      id: message.id,
      rev: stored.rev,
      role: stored.role,
      ...(stored.turnId === undefined ? {} : { turnId: stored.turnId }),
      at: message.metadata?.createdAt ?? now,
      seq: stored.seq,
      message: fitted,
      truncated,
    },
  });
  const whole = build(message, false);
  const size = bytesOf(whole) + ENVELOPE_BYTES;
  if (size <= SINK_MESSAGE_EVENT_MAX_BYTES) return whole;
  const fitted = fitMessage(
    message,
    Math.max(0, bytesOf(message) - (size - SINK_MESSAGE_EVENT_MAX_BYTES)),
  );
  return build(fitted.message, fitted.truncated);
};
