// What an answer to a card carries when it came as its own signed request (`ask-answer.ts`).

import * as Context from "effect/Context";

/** Where a person answers a card while fronted sign-in is on. */
export const ASK_ANSWER_PATH = "/asks/answer";

/** What a card's answer over the socket is told while fronted sign-in is on. */
export const ANSWER_OVER_HTTP = `answer over HTTP: POST ${ASK_ANSWER_PATH}, so the answer is signed`;

/** The largest body taken: an answer is a few ids and a message. */
export const ASK_ANSWER_MAX_BYTES = 64 * 1024;

/** The request an answer came in, as received: what the proxy signed it with, and what it signed. */
export interface AnswerProof {
  /** The proxy's statement (`x-gram-identity`), exactly as received. */
  readonly statement: string;
  readonly method: string;
  /** The path and query, as this server received them. */
  readonly path: string;
  /** The body, exactly as received. */
  readonly body: string;
}

/** The proof of the request a call answers a card for, where it came as one. */
export const AnswerProofRef = Context.Reference<AnswerProof | undefined>(
  "@gram/server/AnswerProof",
  { defaultValue: () => undefined },
);
