import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";
import { WaitId, WaitKind } from "./waits.ts";

/** The most open items a digest names, and the most finished ones it names by title. */
export const DIGEST_WAITING_LISTED = 12;

/**
 * Why an open item likely no longer waits on the user: the thread that added it is `archived`, or
 * its pull request `merged`.
 */
export const DigestWaitingStale = Schema.Literals(["archived", "merged"]);
export type DigestWaitingStale = typeof DigestWaitingStale.Type;

/** An open item a digest names, so a fresh session knows what the user still has to do. */
export const DigestWaitingItem = Schema.Struct({
  threadId: ThreadId,
  /** The title of the thread it lives in. */
  thread: Schema.optionalKey(Schema.String),
  id: WaitId,
  kind: WaitKind,
  title: Schema.String,
  /** Minutes it has waited when the digest was built. */
  ageMin: Schema.Int,
  /** Set when its thread is archived or merged, so it is likely stale. */
  stale: Schema.optionalKey(DigestWaitingStale),
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
 * What waits on the user across the orchestrator's workspace, every thread in it, its workers'
 * live and archived among them: the items of their Waiting on you, counted, so the orchestrator
 * can say what is still owed without repeating it every reply, and keep the list true.
 */
export const DigestWaiting = Schema.Struct({
  /** Items still open. */
  open: Schema.Int,
  /** How many of each kind, in the order kinds first appear. */
  kinds: Schema.Array(Schema.Struct({ kind: WaitKind, count: Schema.Int })),
  /** Minutes the oldest open item has waited; absent with none open. */
  oldestMin: Schema.optionalKey(Schema.Int),
  /** How many open items are from an archived or merged thread (`DigestWaitingStale`). */
  stale: Schema.optionalKey(Schema.Int),
  /**
   * The open items by name, at most `DIGEST_WAITING_LISTED`: all of them on a boot, as a session
   * that starts fresh, a handoff's among them, remembers none of them, and otherwise the stale ones.
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

/** How long an item has waited, as a digest says it: "42m", "3 h", "2 d". */
export const waitAgeText = (minutes: number): string =>
  minutes < 60
    ? `${minutes}m`
    : minutes < 48 * 60
      ? `${Math.floor(minutes / 60)} h`
      : `${Math.floor(minutes / (24 * 60))} d`;

/** The sentence after the digest's "Waiting on the user" line on `stale` items; "" with none. */
export const staleWaitsText = (stale: number | undefined): string =>
  stale === undefined || stale === 0
    ? ""
    : ` ${stale === 1 ? "1 is" : `${stale} are`} from an archived or merged thread, likely stale: withdraw with resolve_wait (its threadId) what no longer waits on the user, or keep it.`;

/** A named item's line in the digest, its text made one line by `inline`. */
export const digestWaitingItemText = (
  item: DigestWaitingItem,
  inline: (text: string) => string,
): string =>
  `- ${item.kind} "${inline(item.title)}" ${item.thread === undefined ? "" : `in "${inline(item.thread)}" `}[thread ${item.threadId}] (${item.id}), ${waitAgeText(item.ageMin)}` +
  (item.stale === undefined ? "" : `, ${item.stale}: likely stale`);
