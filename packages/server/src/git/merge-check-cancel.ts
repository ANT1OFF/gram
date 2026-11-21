import type { PrStatus, Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";

import { isBadgeOf } from "./extra-prs.ts";
import type { CheckPr } from "./local-check-cancel.ts";
import type { LocalCheck, LocalChecksShape } from "./local-checks.ts";

const readAfter = (badge: PrStatus, check: LocalCheck) =>
  badge.updatedAt !== undefined && Date.parse(badge.updatedAt) > check.startedAt;

export const makeCheckSettle = (localChecks: LocalChecksShape | undefined) => {
  const armed = new Map<ThreadId, CheckPr>();
  return (thread: Thread, badge: PrStatus | undefined): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (localChecks === undefined) return;
      const bound = thread.boundPr;
      const was = armed.get(thread.id);
      if (bound?.mergeWhenReady !== undefined) armed.set(thread.id, bound);
      else armed.delete(thread.id);
      if (
        was !== undefined &&
        (bound?.mergeWhenReady === undefined ||
          bound.number !== was.number ||
          bound.repo.toLowerCase() !== was.repo.toLowerCase())
      )
        yield* localChecks.cancel(was, "merge_when_ready was dropped");
      if (bound === undefined || badge === undefined || !isBadgeOf(badge, bound)) return;
      const head = badge.headRefOid;
      if (badge.state === "MERGED") yield* localChecks.cancel(bound, "the pull request merged");
      else if (badge.state === "CLOSED")
        yield* localChecks.cancel(
          bound,
          "the pull request was closed",
          (check) => !readAfter(badge, check),
        );
      else if (head !== undefined)
        yield* localChecks.cancel(
          bound,
          `the pull request's head moved to ${head.slice(0, 7)}`,
          (check) => check.head === head || !readAfter(badge, check),
        );
    });
};
