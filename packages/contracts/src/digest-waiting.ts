import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";
import { WaitId, WaitKind } from "./waits.ts";

/** The most open items a digest names, and the most finished ones it names by title. */
export const DIGEST_WAITING_LISTED = 12;

/** An open item a digest names, so a fresh session knows what the user still has to do. */
export const DigestWaitingItem = Schema.Struct({
  threadId: ThreadId,
  id: WaitId,
  kind: WaitKind,
  title: Schema.String,
  /** Minutes it has waited when the digest was built. */
  ageMin: Schema.Int,
});
export type DigestWaitingItem = typeof DigestWaitingItem.Type;

/** An item a digest names as ended other than done: its thread, title and why. */
export const DigestWaitingEnded = Schema.Struct({
  threadId: ThreadId,
  id: WaitId,
  title: Schema.String,
  note: Schema.optionalKey(Schema.String),
});
export type DigestWaitingEnded = typeof DigestWaitingEnded.Type;

/**
 * What waits on the user across the orchestrator and its workers: the
 * items of their Waiting on you, counted, so the orchestrator can say what is still owed without
 * repeating it every reply.
 */
export const DigestWaiting = Schema.Struct({
  /** Items still open. */
  open: Schema.Int,
  /** How many of each kind, in the order kinds first appear. */
  kinds: Schema.Array(Schema.Struct({ kind: WaitKind, count: Schema.Int })),
  /** Minutes the oldest open item has waited; absent with none open. */
  oldestMin: Schema.optionalKey(Schema.Int),
  /**
   * The open items by name, at most `DIGEST_WAITING_LISTED`, on a boot: a session that starts
   * fresh, a handoff's among them, remembers none of them.
   */
  items: Schema.optionalKey(Schema.Array(DigestWaitingItem)),
  /** Titles of what the user marked done since the last digest, at most `DIGEST_WAITING_LISTED`. */
  resolved: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * What the user dismissed since the last digest, without doing it, and what a worker withdrew
   * itself, at most `DIGEST_WAITING_LISTED` each; `note` is why, as they said it.
   */
  dismissed: Schema.optionalKey(Schema.Array(DigestWaitingEnded)),
  withdrawn: Schema.optionalKey(Schema.Array(DigestWaitingEnded)),
});
export type DigestWaiting = typeof DigestWaiting.Type;
