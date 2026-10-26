import { describe, expect, it } from "@effect/vitest";
import type * as GrokFixture from "../../../agents/src/grok/protocol.test-support.ts";
import { AgentUnavailable, type ThreadId } from "@gram/contracts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "./agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { makeRuntimeTestLayer, TEST_CONFIG } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

// Deliberately outside package exports; this test loads source-only fixture support.
const { makeUnqualifiedGrokProtocolFixture }: typeof GrokFixture = await import(
  new URL("../../../agents/src/grok/protocol.test-support.ts", import.meta.url).href
);
const peer = fileURLToPath(new URL("../../../agents/fixtures/grok/cli.cjs", import.meta.url));
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "gram-grok-restart-"));
  const control = join(root, "control");
  mkdirSync(control);
  const log = join(root, "protocol.jsonl");
  writeFileSync(log, "");
  const host = makeUnqualifiedGrokProtocolFixture({
    home: join(root, "grok"),
    authPath: join(root, "synthetic-auth-never-open.json"),
    binary: process.execPath,
    args: [peer, "lifecycle", log, control],
    env: { HOME: root, PATH: "" },
  });
  const agents = Layer.effectContext(
    Effect.gen(function* () {
      const existing = yield* AgentHosts;
      const fake = yield* FakeAgentControl;
      return Context.make(AgentHosts, {
        get: (kind) => (kind === "grok" ? Effect.succeed(host) : existing.get(kind)),
      }).pipe(Context.add(FakeAgentControl, fake));
    }),
  ).pipe(Layer.provide(FakeAgentAdapter));
  return {
    root,
    control,
    host,
    layer: makeRuntimeTestLayer(undefined, undefined, { ...TEST_CONFIG, dataDir: root }, agents),
    read: () =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              pid: number;
              method?: string;
              exited?: boolean;
              params?: { sessionId?: string };
            },
        ),
  };
};
const withFixture = <A, E, R>(body: (f: ReturnType<typeof fixture>) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(fixture),
    (f) => body(f).pipe(Effect.provide(f.layer)),
    (f) => Effect.sync(() => rmSync(f.root, { recursive: true, force: true })),
  );
const waitFor = <A, E, R>(label: string, check: Effect.Effect<A | false | undefined, E, R>) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const value = yield* check;
      if (value !== false && value !== undefined) return value;
      yield* Effect.sleep(10);
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${label}`));
  });
const status = (id: ThreadId, expected: string) =>
  Effect.flatMap(ThreadRuntimes, (r) =>
    waitFor(expected, r.status(id).pipe(Effect.map((s) => s === expected))),
  );
const create = (root: string, text = "Synthetic saved exchange") =>
  Effect.flatMap(ThreadRuntimes, (r) =>
    r.create({
      projectRoot: root,
      checkout: { kind: "main", path: root },
      model: { agent: "grok", model: "synthetic-grok" },
      mode: "default",
      input: { text },
    }),
  );
const settledRestart = (id: ThreadId) =>
  Effect.flatMap(ThreadRuntimes, (r) =>
    waitFor(
      "restart settled",
      r.status(id).pipe(Effect.map((s) => (s === "idle" || s === "error" ? s : false))),
    ),
  );

function expectExitBeforeLoad(rows: ReturnType<ReturnType<typeof fixture>["read"]>) {
  const load = rows.findIndex((row) => row.method === "session/load");
  const first = rows.find((row) => row.method === "session/new")!;
  const exit = rows.findIndex((row) => row.exited && row.pid === first.pid);
  expect(exit).toBeGreaterThan(-1);
  expect(load).toBeGreaterThan(exit);
  expect(
    rows.findIndex((row) => row.method === "initialize" && row.pid !== first.pid),
  ).toBeGreaterThan(exit);
  expect(rows[load]!.pid).not.toBe(first.pid);
}

describe("runtime to unqualified Grok protocol fixture restart lifecycle (offline peer)", () => {
  it.live(
    "explicit restart resumes after actual old EXIT and refuses a live owning child",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const runtime = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const thread = yield* create(f.root);
          yield* status(thread.id, "idle");
          const saved = (yield* store.getThread(thread.id)).agentSessionId!;
          const before = f.read().filter((row) => row.method === "initialize").length;
          const refused = yield* Effect.scoped(
            f.host.open({ threadId: thread.id, cwd: f.root, resumeId: saved }),
          ).pipe(Effect.flip);
          expect(refused).toBeInstanceOf(AgentUnavailable);
          expect(refused.message).toContain("previous Grok Build child still owns");
          expect(f.read().filter((row) => row.method === "initialize")).toHaveLength(before);
          yield* runtime.restartSession(thread.id);
          expect(yield* settledRestart(thread.id)).toBe("idle");
          expect((yield* store.getThread(thread.id)).agentSessionId).toBe(saved);
          expectExitBeforeLoad(f.read());
          yield* runtime.send(thread.id, { text: "Synthetic exchange after restart" });
          yield* status(thread.id, "idle");
          expect(f.read().filter((row) => row.method === "session/prompt")).toHaveLength(2);
        }),
      ),
    15_000,
  );

  it.live(
    "contains failed replacement authentication and retries the same saved conversation",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const runtime = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const thread = yield* create(f.root);
          yield* status(thread.id, "idle");
          const saved = (yield* store.getThread(thread.id)).agentSessionId;
          writeFileSync(join(f.control, "refuse-auth"), "synthetic");
          yield* runtime.restartSession(thread.id);
          expect(yield* settledRestart(thread.id)).toBe("error");
          expect(f.read().filter((row) => row.method === "authenticate")).toHaveLength(2);
          expect(f.read().some((row) => row.method === "session/load")).toBe(false);
          expect((yield* store.getThread(thread.id)).agentSessionId).toBe(saved);
          rmSync(join(f.control, "refuse-auth"));
          yield* runtime.restartSession(thread.id);
          expect(yield* settledRestart(thread.id)).toBe("idle");
          expect((yield* store.getThread(thread.id)).agentSessionId).toBe(saved);
          expectExitBeforeLoad(f.read());
        }),
      ),
    15_000,
  );

  it.live(
    "mid-turn cancel/restart preserves the saved identity and old-child EXIT ordering",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const runtime = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const thread = yield* create(f.root, "hold synthetic turn");
          yield* waitFor(
            "prompt delivered",
            Effect.sync(() => f.read().some((row) => row.method === "session/prompt")),
          );
          const saved = (yield* store.getThread(thread.id)).agentSessionId;
          const restart = yield* Effect.forkScoped(runtime.restartSession(thread.id, "interrupt"));
          yield* Fiber.join(restart);
          expect(yield* settledRestart(thread.id)).toBe("idle");
          expect((yield* store.getThread(thread.id)).agentSessionId).toBe(saved);
          expect(f.read().some((row) => row.method === "session/cancel")).toBe(true);
          expectExitBeforeLoad(f.read());
        }),
      ),
    15_000,
  );
  it.live(
    "recovers a hung cancellation at the unchanged watchdog and resumes only after old EXIT",
    () =>
      withFixture((f) =>
        Effect.gen(function* () {
          const runtime = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          writeFileSync(join(f.control, "ignore-cancel"), "synthetic");
          const thread = yield* create(f.root, "hold synthetic turn");
          yield* waitFor(
            "prompt delivered",
            Effect.sync(() => f.read().some((row) => row.method === "session/prompt")),
          );
          const saved = (yield* store.getThread(thread.id)).agentSessionId;
          yield* runtime.restartSession(thread.id, "interrupt");
          expect(yield* settledRestart(thread.id)).toBe("idle");
          expect((yield* store.getThread(thread.id)).agentSessionId).toBe(saved);
          expect(f.read().some((row) => row.method === "session/cancel")).toBe(true);
          expectExitBeforeLoad(f.read());
          rmSync(join(f.control, "ignore-cancel"));
          yield* runtime.send(thread.id, { text: "Synthetic retry after hung cancellation" });
          yield* status(thread.id, "idle");
          expect(f.read().filter((row) => row.method === "session/prompt")).toHaveLength(2);
        }),
      ),
    15_000,
  );
});
