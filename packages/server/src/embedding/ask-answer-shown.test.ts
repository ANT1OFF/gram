// An answer posted to `asks/answer` names the card it was given for, as `ask.opened` carried it, so
// a relay's stale click is refused like the app's.

import { describe, expect, it } from "@effect/vitest";
import type { RequestAnswer } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "../platform/unstable.ts";
import { type AskAnswerDeps, answerAsk } from "./ask-answer.ts";

describe("an answer over HTTP", () => {
  it.effect("passes on the card it was given for", () =>
    Effect.gen(function* () {
      const given: Array<{ answer: RequestAnswer; shown: string | undefined }> = [];
      const respond: AskAnswerDeps["runtimes"]["respond"] = (
        _threadId,
        _requestId,
        answer,
        shown,
      ) =>
        Effect.sync(() => {
          given.push({ answer, shown });
        });
      const deps = {
        runtimes: { respond },
        store: { appendActorEvents: () => Effect.void },
      } as unknown as AskAnswerDeps;
      const body = JSON.stringify({
        threadId: "t-1",
        requestId: "r1",
        answer: { kind: "approval", decision: "allow", scope: "once" },
        shown: "card-a",
      });
      const request = HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1/asks/answer", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          },
          body,
        }),
      );
      yield* answerAsk(deps, request, { id: "p-1", name: "P", role: "member" }, "signed");
      expect(given).toEqual([
        { answer: { kind: "approval", decision: "allow", scope: "once" }, shown: "card-a" },
      ]);
    }),
  );
});
