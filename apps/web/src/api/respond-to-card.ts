import type { PendingRequest, RequestAnswer, ThreadId } from "@gram/contracts";

import type { Api } from "./types";

/**
 * Answers `request` as it was shown, naming its key (`PendingRequest.shown`) when it has one: a
 * card the agent put up again under the id since refuses the answer rather than taking it.
 */
export const respondToCard = (
  api: Pick<Api, "respond">,
  threadId: ThreadId,
  request: Pick<PendingRequest, "id" | "shown">,
  answer: RequestAnswer,
): Promise<void> =>
  request.shown === undefined
    ? api.respond(threadId, request.id, answer)
    : api.respond(threadId, request.id, answer, request.shown);
