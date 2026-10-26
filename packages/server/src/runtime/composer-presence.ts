/*
 * What the user is doing in the composers of every connected window, as far as the server can know:
 * when they last typed, and which threads have a draft. Idle compaction never runs while either
 * says the user may be about to send, and a window that stops reporting counts as one that might.
 * Counts and thread ids only: no draft text reaches the server.
 */
import type { ThreadId } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** A report this old is late: the window may have drafts it hasn't told of. */
export const DRAFT_REPORT_STALE_MS = 75_000;
/** A window silent this long is taken to be gone (a crash, a sleep it never woke from). */
export const DRAFT_WINDOW_FORGET_MS = 15 * 60_000;
/** Typing anywhere holds idle compaction this long after the last keystroke report. */
export const TYPING_HOLD_MS = 2 * 60_000;

/** Why the composers hold a thread: the user is typing, has a draft, or a window went quiet. */
export type ComposerHold = "typing" | "draft" | "unknownWindow";

export interface ComposerPresenceShape {
  /** The user typed in some composer just now. */
  readonly typed: Effect.Effect<void>;
  /** Window `windowId`'s threads with a draft, all of them; empty when it has none or closes. */
  readonly drafts: (windowId: string, threadIds: ReadonlyArray<ThreadId>) => Effect.Effect<void>;
  /** What holds `threadId` now, if anything. */
  readonly holdOf: (threadId: ThreadId) => Effect.Effect<ComposerHold | undefined>;
}

interface WindowReport {
  readonly at: number;
  readonly threads: ReadonlySet<string>;
}

export const makeComposerPresence = Effect.sync(() => {
  let typedAt = Number.NEGATIVE_INFINITY;
  const windows = new Map<string, WindowReport>();
  const shape: ComposerPresenceShape = {
    typed: Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        typedAt = now;
      }),
    ),
    drafts: (windowId, threadIds) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          // A closing window says it has none; keeping it would count it as gone quiet.
          if (threadIds.length === 0) windows.delete(windowId);
          else windows.set(windowId, { at: now, threads: new Set(threadIds) });
        }),
      ),
    holdOf: (threadId) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now): ComposerHold | undefined => {
          if (now - typedAt < TYPING_HOLD_MS) return "typing";
          let quiet = false;
          for (const [windowId, report] of windows) {
            const age = now - report.at;
            if (age >= DRAFT_WINDOW_FORGET_MS) {
              windows.delete(windowId);
              continue;
            }
            if (age >= DRAFT_REPORT_STALE_MS) quiet = true;
            else if (report.threads.has(threadId)) return "draft";
          }
          return quiet ? "unknownWindow" : undefined;
        }),
      ),
  };
  return shape;
});

export class ComposerPresence extends Context.Service<ComposerPresence, ComposerPresenceShape>()(
  "@gram/server/ComposerPresence",
) {
  static readonly layer = Layer.effect(ComposerPresence, makeComposerPresence);
}
