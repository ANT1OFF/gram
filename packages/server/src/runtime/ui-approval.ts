import type { RequestId, ThreadId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

interface AnsweredCard {
  readonly threadId: ThreadId;
  readonly requestId: RequestId;
  readonly shown: string;
}

const UiApproval = Context.Reference<AnsweredCard | undefined>("@gram/server/UiApproval", {
  defaultValue: () => undefined,
});

/** A single card named by the admitted app connection, or the fronted UI's signed answer. */
export const withUiApproval = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  threadId: ThreadId,
  requestId: RequestId,
  shown: string | undefined,
) =>
  shown === undefined
    ? effect
    : effect.pipe(Effect.provideService(UiApproval, { threadId, requestId, shown }));

export const cameFromUi = (threadId: ThreadId, requestId: RequestId, shown: string | undefined) =>
  UiApproval.pipe(
    Effect.map(
      (card) =>
        card !== undefined &&
        card.threadId === threadId &&
        card.requestId === requestId &&
        card.shown === shown,
    ),
  );
