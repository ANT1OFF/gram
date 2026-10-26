import * as Effect from "effect/Effect";
import type { Handlers } from "../rpc/handlers/common.ts";
import { ReviewRequestsPoller } from "./review-requests.ts";

/** `reviewRequests.list`, `reviewRequests.refresh` and `openPrs.list`, all one poll's. */
export const reviewRequestsHandlers = Effect.gen(function* () {
  const poller = yield* ReviewRequestsPoller;
  return {
    "reviewRequests.list": () => poller.current,
    "reviewRequests.refresh": ({ force }) => poller.refresh({ force: force === true }),
    "openPrs.list": () => poller.own,
  } satisfies Partial<Handlers>;
});
