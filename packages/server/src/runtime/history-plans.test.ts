import { describe, expect, it } from "@effect/vitest";
import type { GramUIMessage, Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";

import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { makeResumePlans } from "./history-plans.ts";

const THREAD = "fork-1" as ThreadId;

const reply = (id: string, agentId: string) =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "text", text: id }],
    metadata: { createdAt: 0, agentMessageIds: [agentId] },
  }) as unknown as GramUIMessage;
const marker = (id: string) =>
  ({
    id,
    role: "assistant",
    parts: [{ type: "data-session-restart", data: {} }],
  }) as unknown as GramUIMessage;
const launch = (id: string) =>
  ({ id, role: "user", parts: [{ type: "text", text: "next" }] }) as unknown as GramUIMessage;

/** A store holding `history`, which reports each tail read's size and never reads all of it. */
const storeOf = (history: ReadonlyArray<GramUIMessage>, queued: ReadonlyArray<string>) => {
  const reads: Array<number> = [];
  const store = {
    listQueue: () => Effect.succeed(queued.map((id) => ({ id }))),
    lastMessages: (_threadId: ThreadId, count: number) =>
      Effect.sync(() => (reads.push(count), history.slice(-count))),
    listMessages: () => Effect.die("a fork's resume read its whole history"),
  } as unknown as ThreadStoreShape;
  return { store, reads };
};

const fork = {
  id: THREAD,
  agentSessionId: "own-session",
  agentSessionUnused: true,
  forkedFrom: { agentSessionId: "source-session" },
} as unknown as Thread;

describe("a fork's first resume", () => {
  it.effect(
    "forks the source at the last message it copied, reading only the end of a long history",
    () =>
      Effect.gen(function* () {
        const history = [
          ...Array.from({ length: 5_000 }, (_, i) => reply(`m${i}`, `sdk-${i}`)),
          launch("q1"),
        ];
        const { store, reads } = storeOf(history, ["q1"]);
        const options = yield* makeResumePlans({ store }).resumeOptions(fork, undefined);
        expect(options).toMatchObject({
          resumeId: "source-session",
          fork: true,
          resumeAt: "sdk-4999",
        });
        expect(reads).toEqual([16]);
      }),
  );

  it.effect("reads further back past more markers than one window holds", () =>
    Effect.gen(function* () {
      const history = [
        reply("first", "sdk-first"),
        reply("m1", "sdk-1"),
        ...Array.from({ length: 40 }, (_, i) => marker(`r${i}`)),
      ];
      const { store, reads } = storeOf(history, []);
      const options = yield* makeResumePlans({ store }).resumeOptions(fork, undefined);
      expect(options).toMatchObject({ resumeAt: "sdk-1" });
      expect(reads).toEqual([16, 128]);
    }),
  );

  it.effect("opens fresh under its own id when nothing was copied", () =>
    Effect.gen(function* () {
      const { store } = storeOf([marker("r0")], []);
      const options = yield* makeResumePlans({ store }).resumeOptions(fork, undefined);
      expect(options).toEqual({ sessionId: "own-session" });
    }),
  );
});
