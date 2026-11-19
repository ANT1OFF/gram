import { GramRpcs, NotImplemented, type ServerHandshake } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "./rpc-client";
import { createServed, gateClient, HANDSHAKE_TAG, startHandshake } from "./served";

// A server older than this build, over Effect RPC's own client and server: it serves only some of
// `GramRpcs`, and answers what it lacks as its RpcServer does.

const KEPT = {
  available: false,
  on: false,
  running: false,
  sessions: 0,
} as const;

const scopes: Scope.Closeable[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
});

/** A client of the whole surface, on a server of `tags` alone; `sent` lists what reached it. */
async function olderServer(options: {
  readonly handshake: boolean;
  /** Holds the handshake's answer until it is resolved. */
  readonly hold?: Deferred.Deferred<void>;
}) {
  const tags = options.handshake ? [HANDSHAKE_TAG, "app.keptHost"] : ["app.keptHost"];
  const group = RpcGroup.make(...tags.map((tag) => GramRpcs.requests.get(tag)!));
  const answer: ServerHandshake = { version: "1.30.0", rpcs: tags };
  const handlers = group.toLayer({
    "app.keptHost": () => Effect.succeed(KEPT),
    "app.handshake": () =>
      (options.hold === undefined ? Effect.void : Deferred.await(options.hold)).pipe(
        Effect.as(answer),
      ),
  } as never);
  const sent: string[] = [];
  const scope = await Effect.runPromise(Scope.make());
  scopes.push(scope);
  const client = await Effect.runPromise(
    Effect.gen(function* () {
      // oxlint-disable-next-line prefer-const
      let made!: Effect.Success<ReturnType<typeof RpcClient.makeNoSerialization<never, never>>>;
      const server = yield* RpcServer.makeNoSerialization(group as never, {
        disableFatalDefects: true,
        onFromServer: (response) => made.write(response as never),
      });
      made = (yield* RpcClient.makeNoSerialization(GramRpcs, {
        supportsAck: true,
        onFromClient: ({ message }) => {
          if (message._tag === "Request") sent.push(message.tag);
          return server.write(0, message as never);
        },
      })) as never;
      return made.client as unknown as RpcClient.FromGroup<typeof GramRpcs>;
    }).pipe(Effect.provide(handlers), Scope.provide(scope)),
  );
  const served = createServed();
  const ready = startHandshake(
    () => run(client[HANDSHAKE_TAG](undefined)),
    served,
    () => {},
  );
  return { client: gateClient(client, served, ready), served, sent, ready };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
};

describe("a client against a server older than itself", () => {
  it("never sends a tag the server's handshake leaves out, and fails it at once", async () => {
    const { client, served, sent } = await olderServer({ handshake: true });
    const error = await failure(run(client["thread.savedDiff"]({ threadId: "t1" as never })));
    expect(error).toBeInstanceOf(NotImplemented);
    expect((error as NotImplemented).rpc).toBe("thread.savedDiff");
    const stream = await failure(
      Effect.runPromise(Stream.runCollect(client["events.subscribe"](undefined))),
    );
    expect(stream).toBeInstanceOf(NotImplemented);
    await expect(run(client["app.keptHost"](undefined))).resolves.toEqual(KEPT);
    expect(sent).toEqual([HANDSHAKE_TAG, "app.keptHost"]);
    expect(served.serves("thread.savedDiff")).toBe(false);
    expect(served.version).toBe("1.30.0");
  });

  it("holds a call made before the handshake answers, then refuses it unsent", async () => {
    const hold = await Effect.runPromise(Deferred.make<void>());
    const { client, sent } = await olderServer({ handshake: true, hold });
    const early = failure(run(client["thread.savedDiff"]({ threadId: "t1" as never })));
    const served = run(client["app.keptHost"](undefined));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([HANDSHAKE_TAG]);
    await Effect.runPromise(Deferred.succeed(hold, undefined));
    expect(await early).toBeInstanceOf(NotImplemented);
    await expect(served).resolves.toEqual(KEPT);
    expect(sent).toEqual([HANDSHAKE_TAG, "app.keptHost"]);
  });

  it("fails fast with NotImplemented on a server too old for a handshake, and stops asking", async () => {
    const { client, served, sent, ready } = await olderServer({ handshake: false });
    await ready.wait;
    // Every tag counts as served until the server refuses one.
    expect(served.serves("thread.savedDiff")).toBe(true);
    const error = await failure(run(client["thread.savedDiff"]({ threadId: "t1" as never })));
    expect(error).toBeInstanceOf(NotImplemented);
    expect(served.serves("thread.savedDiff")).toBe(false);
    const stream = await failure(
      Effect.runPromise(Stream.runCollect(client["events.subscribe"](undefined))),
    );
    expect(stream).toBeInstanceOf(NotImplemented);
    // Refused once, never sent again.
    await failure(run(client["thread.savedDiff"]({ threadId: "t1" as never })));
    expect(sent).toEqual([HANDSHAKE_TAG, "thread.savedDiff", "events.subscribe"]);
    await expect(run(client["app.keptHost"](undefined))).resolves.toEqual(KEPT);
  });
});
