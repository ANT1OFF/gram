import type { RequestId, ThreadId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

interface AnsweredCard {
  readonly threadId: ThreadId;
  readonly requestId: RequestId;
  readonly shown: string;
}

const LocalAppApproval = Context.Reference<AnsweredCard | undefined>(
  "@gram/server/LocalAppApproval",
  {
    defaultValue: () => undefined,
  },
);

/** A single card named by the authenticated local app connection. */
export const withLocalAppApproval = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  threadId: ThreadId,
  requestId: RequestId,
  shown: string | undefined,
) =>
  shown === undefined
    ? effect
    : effect.pipe(Effect.provideService(LocalAppApproval, { threadId, requestId, shown }));

export const cameFromLocalApp = (
  threadId: ThreadId,
  requestId: RequestId,
  shown: string | undefined,
) =>
  LocalAppApproval.pipe(
    Effect.map(
      (card) =>
        card !== undefined &&
        card.threadId === threadId &&
        card.requestId === requestId &&
        card.shown === shown,
    ),
  );
