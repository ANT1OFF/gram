import { describe, expect, it } from "@effect/vitest";
import { RequestId, ThreadId, type AgentEvent } from "@gram/contracts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import type { AgentSession } from "../host.ts";
import { ClaudeHost } from "./session.ts";

const live = process.env["GRAM_LIVE_CLAUDE"] === "1";

/** Polls the collected events until `predicate` matches one after `from`. */
const waitFor = (
  events: ReadonlyArray<AgentEvent>,
  from: number,
  predicate: (event: AgentEvent) => boolean,
) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1200; i++) {
      const index = events.findIndex((e, n) => n >= from && predicate(e));
      if (index !== -1) return index;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.die(new Error("timed out waiting for an event"));
  });

const turnEnd = (e: AgentEvent) => e.type === "turnEnd";

/** The text the agent streamed from `from` on. */
const textAfter = (events: ReadonlyArray<AgentEvent>, from: number) =>
  events
    .slice(from)
    .flatMap((e) => (e.type === "chunk" && e.chunk.type === "text-delta" ? [e.chunk.delta] : []))
    .join("");

const collect = (session: AgentSession, into: Array<AgentEvent>) =>
  Effect.forkScoped(Stream.runForEach(session.events, (e) => Effect.sync(() => into.push(e))));

describe.skipIf(!live)("live Claude (GRAM_LIVE_CLAUDE=1)", () => {
  it.live(
    "runs a Haiku turn and an approval round-trip through the real CLI",
    () =>
      Effect.gen(function* () {
        const root = process.platform === "win32" ? tmpdir() : "/tmp";
        const cwd = mkdtempSync(join(root, "gram-live-claude-"));
        execFileSync("git", ["init", "-q"], { cwd });
        // Loaded lazily so skipped runs never load the SDK.
        const { ClaudeHostLive } = yield* Effect.promise(() => import("./live.ts"));
        const events: Array<AgentEvent> = [];

        yield* Effect.gen(function* () {
          const host = yield* ClaudeHost;
          const session = yield* host.open({
            threadId: ThreadId.make("live"),
            cwd,
            model: { agent: "claude", model: "haiku" },
            permissionMode: "default",
          });
          yield* collect(session, events);
          yield* waitFor(events, 0, (e) => e.type === "identity");

          yield* session.send({ text: "Reply with just: OK" });
          const first = yield* waitFor(events, 0, turnEnd);
          expect(events[first]).toEqual({ type: "turnEnd", reason: "completed" });
          expect(events.some((e) => e.type === "chunk" && e.chunk.type === "text-delta")).toBe(
            true,
          );
          yield* waitFor(events, first, (e) => e.type === "status" && e.status === "idle");

          yield* session.send({
            text: "Run this exact bash command: echo hi > hi.txt   Then reply with just: DONE",
          });
          const requestIndex = yield* waitFor(events, first + 1, (e) => e.type === "request");
          const request = events[requestIndex];
          if (request?.type !== "request") throw new Error("expected a request");
          expect(request.request).toMatchObject({ kind: "approval", toolName: "Bash" });
          yield* session.respond(RequestId.make(request.request.id), {
            kind: "approval",
            decision: "allow",
            scope: "once",
          });
          const second = yield* waitFor(events, requestIndex, turnEnd);
          expect(events[second]).toEqual({ type: "turnEnd", reason: "completed" });
          expect(existsSync(join(cwd, "hi.txt"))).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(ClaudeHostLive({ settingSources: [] })));
      }),
    180_000,
  );

  it.live(
    "restarts a session on the same conversation, reading a CLAUDE.md written in between",
    () =>
      Effect.gen(function* () {
        const root = process.platform === "win32" ? tmpdir() : "/tmp";
        const cwd = mkdtempSync(join(root, "gram-live-claude-restart-"));
        execFileSync("git", ["init", "-q"], { cwd });
        const { ClaudeHostLive } = yield* Effect.promise(() => import("./live.ts"));

        // Only the temp project's settings and CLAUDE.md, never the user's own.
        yield* Effect.gen(function* () {
          const host = yield* ClaudeHost;
          const options = {
            threadId: ThreadId.make("live-restart"),
            cwd,
            model: { agent: "claude", model: "haiku" },
            permissionMode: "default",
          } as const;
          const firstEvents: Array<AgentEvent> = [];
          const firstScope = yield* Scope.make();
          const first = yield* host.open(options).pipe(Scope.provide(firstScope));
          yield* collect(first, firstEvents).pipe(Scope.provide(firstScope));
          const identity =
            firstEvents[yield* waitFor(firstEvents, 0, (e) => e.type === "identity")];
          if (identity?.type !== "identity") throw new Error("expected an identity");
          yield* first.send({ text: "Remember the word PELICAN. Reply with just: OK" });
          yield* waitFor(firstEvents, 0, turnEnd);

          writeFileSync(
            join(cwd, "CLAUDE.md"),
            "End every reply with the word ZEBRA on a line of its own.\n",
          );
          yield* host.reloadConfig?.(undefined) ?? Effect.void;
          yield* Scope.close(firstScope, Exit.void);

          const events: Array<AgentEvent> = [];
          const second = yield* host.open({ ...options, resumeId: identity.agentSessionId });
          yield* collect(second, events);
          yield* second.send({ text: "Which word did I ask you to remember? Reply with it." });
          const end = yield* waitFor(events, 0, turnEnd);
          expect(events[end]).toEqual({ type: "turnEnd", reason: "completed" });
          const reply = textAfter(events, 0);
          expect(reply).toContain("PELICAN");
          expect(reply).toContain("ZEBRA");
        }).pipe(Effect.scoped, Effect.provide(ClaudeHostLive({ settingSources: ["project"] })));
      }),
    180_000,
  );

  it.live(
    "lists the signed-in account's own models",
    () =>
      Effect.gen(function* () {
        const { ClaudeHostLive } = yield* Effect.promise(() => import("./live.ts"));
        const models = yield* Effect.gen(function* () {
          return yield* (yield* ClaudeHost).listModels();
        }).pipe(Effect.provide(ClaudeHostLive({ settingSources: [] })));
        // Ids and names only: what an account is granted is the point, and nothing secret.
        console.info(models.map((m) => `${m.id} (${m.displayName})`).join(", "));
        expect(models.some((m) => m.isDefault === true)).toBe(true);
        expect(models.every((m) => m.displayName !== "")).toBe(true);
      }),
    60_000,
  );
});
