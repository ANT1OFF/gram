import type { RequestAnswer, RespondManyResult } from "@gram/contracts";

import { serverUrl } from "../server-base";

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
  threadId: string,
  requestId: string,
  answer: RequestAnswer,
): Promise<void> => {
  const response = await fetch(serverUrl(ASK_ANSWER_PATH), {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, requestId, answer }),
  });
  if (response.ok) return;
  const value: unknown = await response.json().catch(() => undefined);
  const error =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  throw Object.assign(
    new Error(typeof error["message"] === "string" ? error["message"] : "The answer wasn't taken."),
    error,
  );
};

/** Each answer posted in turn, as the socket's `thread.respondMany` would take them. */
export const postAnswers = async (
  answers: ReadonlyArray<{ threadId: string; requestId: string; answer: RequestAnswer }>,
): Promise<ReadonlyArray<RespondManyResult>> => {
  const results: Array<RespondManyResult> = [];
  for (const { threadId, requestId, answer } of answers) {
    try {
      await postAnswer(threadId, requestId, answer);
      results.push({ threadId, requestId, ok: true } as RespondManyResult);
    } catch (error) {
      results.push({
        threadId,
        requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } as RespondManyResult);
    }
  }
  return results;
};
