import {
  fieldsOf,
  type RequestAnswer,
  type RequestId,
  type RespondManyResult,
  type ThreadId,
} from "@gram/contracts";

import { serverUrl } from "../server-base";
import { withOriginKey } from "../origin-key";

/**
 * A server whose people sign in through a fronting proxy takes an answer to a card only as its own
 * HTTP request, which the proxy can sign, and refuses it over the socket with this. The words match
 * `ANSWER_OVER_HTTP` in the server's `embedding/ask-answer.ts`.
 */
export const ANSWER_OVER_HTTP_MARK = "answer over HTTP: POST /asks/answer";
const ASK_ANSWER_PATH = "/asks/answer";

/** Whether `error` is the socket's refusal of an answer, telling the client to post it. */
export const isAnswerOverHttp = (error: unknown): boolean =>
  error instanceof Error && error.message.includes(ANSWER_OVER_HTTP_MARK);

/** One answer, posted. A refusal throws the server's `{_tag, message}`, as the socket's would. */
export const postAnswer = async (
  threadId: ThreadId,
  requestId: RequestId,
  answer: RequestAnswer,
  shown?: string,
): Promise<void> => {
  const response = await fetch(
    serverUrl(ASK_ANSWER_PATH),
    withOriginKey({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        requestId,
        answer,
        ...(shown === undefined ? {} : { shown }),
      }),
    }),
  );
  if (response.ok) return;
  const value: unknown = await response.json().catch(() => undefined);
  const error = typeof value === "object" && value !== null ? value : {};
  const message = fieldsOf(error).get("message");
  throw Object.assign(
    new Error(typeof message === "string" ? message : "The answer wasn't taken."),
    error,
  );
};

/** Each answer posted in turn, as the socket's `thread.respondMany` would take them. */
export const postAnswers = async (
  answers: ReadonlyArray<{
    threadId: ThreadId;
    requestId: RequestId;
    answer: RequestAnswer;
    shown?: string | undefined;
  }>,
): Promise<ReadonlyArray<RespondManyResult>> => {
  const results: Array<RespondManyResult> = [];
  for (const { threadId, requestId, answer, shown } of answers) {
    try {
      await postAnswer(threadId, requestId, answer, shown);
      results.push({ threadId, requestId, ok: true });
    } catch (error) {
      results.push({
        threadId,
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
};
