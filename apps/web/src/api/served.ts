import { GramRpcs, NotImplemented, type ServerHandshake } from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Stream from "effect/Stream";
import { sleep } from "@/lib/sleep";

/** One RPC of the whole wire surface, by its tag. */
export type GramRpcTag = RpcGroup.Rpcs<typeof GramRpcs>["_tag"];

/**
 * Which RPCs the server this window talks to serves. An embedding app ships the web at one commit
 * and its server at another, so a control backed by an RPC the server lacks is hidden or greyed.
 * Until the server says, and for a server too old to say, every tag counts as served; one it
 * refuses as unknown is struck off from then on.
 */
export interface ServedRpcs {
  serves(tag: GramRpcTag): boolean;
  /** Gram's version on the server, once its handshake has answered. */
  readonly version: string | undefined;
  /** Told when what is served changes: the handshake answered, or a tag was refused. */
  subscribe(listener: () => void): () => void;
}

export interface ServedRecord extends ServedRpcs {
  /** The server's handshake: from now on only its tags are served. */
  answered(handshake: ServerHandshake): void;
  /** The server refused `tag` as unknown. */
  refused(tag: string): void;
}

export function createServed(): ServedRecord {
  let known: ReadonlySet<string> | undefined;
  const refused = new Set<string>();
  let version: string | undefined;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    serves: (tag) => !refused.has(tag) && (known === undefined || known.has(tag)),
    get version() {
      return version;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    answered: (handshake) => {
      known = new Set(handshake.rpcs);
      version = handshake.version;
      refused.clear();
      changed();
    },
    refused: (tag) => {
      if (refused.has(tag)) return;
      refused.add(tag);
      changed();
    },
  };
}

/** A server that serves everything but `lacking`, as the in-memory one is. */
export function servedAllBut(lacking: readonly string[] = []): ServedRpcs {
  const served = createServed();
  if (lacking.length > 0)
    served.answered({
      version: "mock",
      rpcs: [...GramRpcs.requests.keys()].filter((tag) => !lacking.includes(tag)),
    });
  return served;
}

export const HANDSHAKE_TAG = "app.handshake" satisfies GramRpcTag;

const unknownTag = (cause: Cause.Cause<unknown>, tag: string): boolean =>
  Cause.squash(cause) === `Unknown request tag: ${tag}`;

const isRpcTag = (key: string): key is GramRpcTag => GramRpcs.requests.has(key);
const isCallable = (value: unknown): value is (...args: unknown[]) => unknown =>
  typeof value === "function";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stream tag's call is a Stream
const asStream = (answer: unknown) => answer as Stream.Stream<unknown, unknown>;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- any other tag's call is an Effect
const asEffect = (answer: unknown) => answer as Effect.Effect<unknown, unknown>;

const STREAMS: ReadonlySet<string> = new Set(
  [...GramRpcs.requests.values()]
    .filter((rpc) => RpcSchema.isStreamSchema(rpc.successSchema))
    .map((rpc) => rpc._tag),
);

/**
 * `client` that sends no RPC before `ready` (the handshake's answer, or giving up on it) and none
 * `served` says the server lacks: such a call fails at once with `NotImplemented`. A server that
 * refuses a tag as unknown, one too old for a handshake, gets the same error, and the tag is
 * struck off.
 */
export function gateClient<C extends object>(
  client: C,
  served: ServedRecord,
  ready: { readonly settled: () => boolean; readonly wait: Promise<void> },
): C {
  const waitReady = Effect.suspend(() =>
    ready.settled() ? Effect.void : Effect.promise(() => ready.wait),
  );
  const calls = new Map<string, unknown>();
  const gated = (tag: GramRpcTag, call: (...args: unknown[]) => unknown) => {
    const missing = () => new NotImplemented({ rpc: tag });
    const strike = <E>(cause: Cause.Cause<E>) => {
      if (!unknownTag(cause, tag)) return cause;
      served.refused(tag);
      return Cause.fail(missing());
    };
    return STREAMS.has(tag)
      ? (...args: unknown[]) =>
          Stream.unwrap(
            Effect.map(waitReady, () =>
              served.serves(tag)
                ? asStream(call(...args)).pipe(
                    Stream.catchCause((cause) => Stream.failCause(strike(cause))),
                  )
                : Stream.fail(missing()),
            ),
          )
      : (...args: unknown[]) =>
          Effect.flatMap(waitReady, () =>
            served.serves(tag)
              ? asEffect(call(...args)).pipe(
                  Effect.catchCause((cause) => Effect.failCause(strike(cause))),
                )
              : Effect.fail(missing()),
          );
  };
  return new Proxy(client, {
    get(target, key, receiver) {
      // oxlint-disable-next-line anti-slop/no-reflect-get -- a Proxy trap forwards through Reflect
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof key !== "string" || !isCallable(value) || !isRpcTag(key)) return value;
      let call = calls.get(key);
      if (call === undefined) {
        call = gated(key, value);
        calls.set(key, call);
      }
      return call;
    },
  });
}

/** How long calls wait for a handshake that hasn't answered before they go out regardless. */
export const HANDSHAKE_WAIT_MS = 5_000;

/**
 * Asks the server what it serves, once now and again each time the socket reopens (a host may
 * start a newer server meanwhile). Calls wait for the first answer, at most `HANDSHAKE_WAIT_MS`.
 */
export function startHandshake(
  ask: () => Promise<ServerHandshake>,
  served: ServedRecord,
  reopened: (again: () => void) => void,
  waitMs = HANDSHAKE_WAIT_MS,
): { readonly settled: () => boolean; readonly wait: Promise<void> } {
  let settled = false;
  const once = () =>
    ask().then(
      (handshake) => served.answered(handshake),
      () => undefined,
    );
  const wait = Promise.race([once(), sleep(waitMs)]).then(() => {
    settled = true;
  });
  reopened(() => void once());
  return { settled: () => settled, wait };
}
