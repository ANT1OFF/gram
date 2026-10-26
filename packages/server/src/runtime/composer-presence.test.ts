import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  DRAFT_REPORT_STALE_MS,
  DRAFT_WINDOW_FORGET_MS,
  makeComposerPresence,
  TYPING_HOLD_MS,
} from "./composer-presence.ts";

const a = "t-a" as ThreadId;
const b = "t-b" as ThreadId;

describe("ComposerPresence", () => {
  it.effect("holds every thread for a while after the user typed anywhere", () =>
    Effect.gen(function* () {
      const presence = yield* makeComposerPresence;
      expect(yield* presence.holdOf(a)).toBeUndefined();
      yield* presence.typed;
      expect(yield* presence.holdOf(a)).toBe("typing");
      yield* TestClock.adjust(TYPING_HOLD_MS);
      expect(yield* presence.holdOf(a)).toBeUndefined();
    }),
  );

  it.effect("holds the threads a window has drafts on, in any window", () =>
    Effect.gen(function* () {
      const presence = yield* makeComposerPresence;
      yield* presence.drafts("window-1", [a]);
      yield* presence.drafts("window-2", [b]);
      expect(yield* presence.holdOf(a)).toBe("draft");
      expect(yield* presence.holdOf(b)).toBe("draft");
      expect(yield* presence.holdOf("t-c" as ThreadId)).toBeUndefined();
      yield* presence.drafts("window-1", []);
      expect(yield* presence.holdOf(a)).toBeUndefined();
    }),
  );

  it.effect("holds every thread while a window that had drafts goes quiet, then forgets it", () =>
    Effect.gen(function* () {
      const presence = yield* makeComposerPresence;
      yield* presence.drafts("window-1", [a]);
      yield* TestClock.adjust(DRAFT_REPORT_STALE_MS);
      expect(yield* presence.holdOf(b)).toBe("unknownWindow");
      yield* TestClock.adjust(DRAFT_WINDOW_FORGET_MS - DRAFT_REPORT_STALE_MS);
      expect(yield* presence.holdOf(b)).toBeUndefined();
      expect(yield* presence.holdOf(a)).toBeUndefined();
    }),
  );
});
