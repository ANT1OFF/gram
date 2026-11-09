import { describe, expect, it } from "@effect/vitest";
import {
  type Checkout,
  HostId,
  HostUnavailable,
  type Thread,
  ThreadId,
  ThreadNotFound,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { HostConnection } from "../host/protocol.ts";
import { placedOnMachine } from "./machine-routes.ts";

const MACHINE = HostId.make("m-0123456789abcdef01234567");
const threads = new Map<string, Thread>([
  [
    "t-remote",
    {
      id: ThreadId.make("t-remote"),
      checkout: { kind: "worktree", path: "/srv/w", hostId: MACHINE } satisfies Checkout,
    } as unknown as Thread,
  ],
  [
    "t-local",
    {
      id: ThreadId.make("t-local"),
      checkout: { kind: "main", path: "/Users/me/w" } satisfies Checkout,
    } as unknown as Thread,
  ],
]);

const gate = (online: boolean, authorization: string | undefined) =>
  placedOnMachine(
    {
      threadFor: (token) =>
        Effect.succeed(
          token === "remote-token"
            ? ThreadId.make("t-remote")
            : token === "local-token"
              ? ThreadId.make("t-local")
              : undefined,
        ),
    },
    {
      getThread: (id) => {
        const found = threads.get(id);
        return found === undefined
          ? Effect.fail(new ThreadNotFound({ threadId: id }))
          : Effect.succeed(found);
      },
    },
    {
      connection: (id) =>
        online && id === MACHINE
          ? Effect.succeed({} as HostConnection)
          : Effect.fail(new HostUnavailable({ hostId: id, message: "offline" })),
    },
    { authorization },
  );

describe("a joined machine's sessions reaching their app tools", () => {
  it.effect("are let through only with a token of a thread placed on an online machine", () =>
    Effect.gen(function* () {
      expect(yield* gate(true, "Bearer remote-token")).toBe(true);
      // This machine's own threads keep to the loopback endpoint.
      expect(yield* gate(true, "Bearer local-token")).toBe(false);
      expect(yield* gate(false, "Bearer remote-token")).toBe(false);
      expect(yield* gate(true, "Bearer someone-else")).toBe(false);
      expect(yield* gate(true, undefined)).toBe(false);
    }),
  );
});
