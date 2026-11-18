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
import { mayReachThread, RoutedFor, threadOwner } from "../host/ownership.ts";
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
    // A memory update on a headless server: its folder here, its session on the machine.
    "t-dream",
    {
      id: ThreadId.make("t-dream"),
      role: "dream",
      checkout: { kind: "main", path: "/data/dreams/d-1" } satisfies Checkout,
      dreamHost: MACHINE,
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
            : token === "dream-token"
              ? ThreadId.make("t-dream")
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
      // A memory update's session is let through from the machine it runs on, not its folder's.
      expect(yield* gate(true, "Bearer dream-token")).toBe(true);
      expect(yield* gate(false, "Bearer dream-token")).toBe(false);
    }),
  );
});

const OTHER = HostId.make("m-fedcba9876543210fedcba98");
/** The machine was started for grace; every other one is no one's. */
const owners = (hostId: HostId) => (hostId === MACHINE ? "grace" : undefined);

describe("a memory update's session on a machine", () => {
  const dream = threads.get("t-dream")!;
  const reach = (person: string) =>
    mayReachThread(() => Effect.succeed(dream), owners, dream.id).pipe(
      Effect.provideService(RoutedFor, { person }),
    );
  it.effect("is reached only by its machine's owner, though its folder is no one's", () =>
    Effect.gen(function* () {
      expect(yield* reach("grace")).toBe(true);
      expect(yield* reach("ada")).toBe(false);
      expect(threadOwner(owners, dream)).toBe("grace");
      expect(threadOwner(owners, { ...dream, dreamHost: OTHER })).toBeUndefined();
    }),
  );
});
