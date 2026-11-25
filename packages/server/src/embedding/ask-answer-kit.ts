import type { PendingRequest, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ThreadStore } from "../persistence/thread-store.ts";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { type AskAnswerDeps, answerAsk } from "./ask-answer.ts";

/**
 * For tests: `decision` on `card`, posted to `/asks/answer` by a member a fronting proxy signed
 * in, with the response's status and body.
 */
export const answerAsMemberForTests = (
  threadId: ThreadId,
  card: PendingRequest,
  decision: "allow" | "deny",
) =>
  Effect.gen(function* () {
    const deps: AskAnswerDeps = { runtimes: yield* ThreadRuntimes, store: yield* ThreadStore };
    const body = JSON.stringify({
      threadId,
      requestId: card.id,
      answer: { kind: "approval", decision, scope: "once" },
      ...(card.shown === undefined ? {} : { shown: card.shown }),
    });
    const request = HttpServerRequest.fromWeb(
      new Request("http://127.0.0.1/asks/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    const member = { id: "member-1", name: "M", role: "member" } as const;
    const web = HttpServerResponse.toWeb(yield* answerAsk(deps, request, member, "signed"));
    const said: unknown = yield* Effect.promise(() => web.json());
    return { status: web.status, body: said };
  });
