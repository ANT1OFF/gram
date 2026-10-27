import { describe, expect, it } from "@effect/vitest";
import type { RequestId } from "@gram/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ServerConfig } from "../config.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { CheckoutService, TurnHooks } from "./hooks.ts";
import { TEST_CONFIG, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

// Explicit invented Codex/account-free fixtures, in-memory SQL and no-op checkout hooks.
const fields = {
  toolName: "invented_action",
  displayName: "Invented",
  input: {},
  description: "Invented approval",
  suggestions: [],
  scopes: ["once"] as const,
};
const answer = (decision: "allow" | "deny") => ({
  kind: "approval" as const,
  decision,
  scope: "once" as const,
});
type Fault =
  | "none"
  | "mode"
  | "list"
  | "clear"
  | "remove"
  | "hub"
  | "resolved-log"
  | "requested-log";
const harness = (file = ":memory:") => {
  let fault: Fault = "none";
  let loggedFaults = 0;
  const store = Layer.effect(
    ThreadStore,
    Effect.gen(function* () {
      const s = yield* ThreadStore;
      return {
        ...s,
        getThread: (id: Parameters<typeof s.getThread>[0]) =>
          fault === "mode" ? Effect.die("invented metadata read fault") : s.getThread(id),
        listRequests: (id: Parameters<typeof s.listRequests>[0]) =>
          fault === "list" ? Effect.die("invented withdrawal read fault") : s.listRequests(id),
        clearRequests: (...args: Parameters<typeof s.clearRequests>) =>
          fault === "clear"
            ? Effect.die("invented withdrawal clear fault")
            : s.clearRequests(...args),
        removeRequest: (...args: Parameters<typeof s.removeRequest>) =>
          fault === "remove"
            ? Effect.die("invented withdrawal write fault")
            : s.removeRequest(...args),
      };
    }),
  ).pipe(Layer.provide(ThreadStore.layerSqlite(file)));
  const hub = Layer.effect(
    EventHub,
    Effect.gen(function* () {
      const h = yield* EventHub;
      return {
        ...h,
        publish: (e: Parameters<typeof h.publish>[0]) =>
          fault === "hub" && e.type === "thread.requestResolved"
            ? Effect.die("invented withdrawal event fault")
            : h.publish(e),
      };
    }),
  ).pipe(Layer.provide(EventHub.layer));
  const logger = Logger.make(({ message }) => {
    if (
      (fault === "resolved-log" && String(message) === "app tool approval resolved") ||
      (fault === "requested-log" && String(message) === "app tool approval requested")
    ) {
      loggedFaults++;
      throw new Error("invented diagnostic logger fault");
    }
  });
  const layer = ThreadRuntimes.layer.pipe(
    Layer.provideMerge(store),
    Layer.provideMerge(hub),
    Layer.provideMerge(FakeAgentAdapter),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(ServerConfig.layer(TEST_CONFIG)),
    Layer.provideMerge(Logger.layer([logger])),
    Layer.orDie,
  );
  return {
    layer,
    inject: (next: Fault) => {
      fault = next;
    },
    faults: () => loggedFaults,
  };
};

const setup = Effect.gen(function* () {
  const rt = yield* ThreadRuntimes;
  const store = yield* ThreadStore;
  const thread = yield* rt.create({
    projectRoot: "/invented",
    checkout: { kind: "main", path: "/invented" },
    model: { agent: "codex", model: "gpt-6.1-sol" },
    mode: "default",
  });
  yield* rt.send(thread.id, { text: "invented turn" });
  yield* waitFor("running", rt.status(thread.id).pipe(Effect.map((s) => s === "running")));
  return { rt, store, thread };
});
const settled = <A, E>(call: Fiber.Fiber<A, E>) =>
  waitFor(
    "captured waiter released",
    Effect.sync(() => call.pollUnsafe()),
  );

describe("approval release survives diagnostic defects", () => {
  for (const fault of ["mode", "resolved-log", "list", "hub"] as const) {
    it.effect(`releases all captured waiters with ${fault} fault and refuses late Allow`, () => {
      const h = harness();
      return Effect.gen(function* () {
        const { rt, store, thread } = yield* setup;
        const calls = [];
        for (let i = 0; i < 3; i++)
          calls.push(yield* Effect.forkScoped(rt.requestApproval(thread.id, fields)));
        const cards = yield* waitFor(
          "three cards",
          store.listRequests(thread.id).pipe(Effect.map((rs) => rs.length === 3 && rs)),
        );
        h.inject(fault);
        const stop = yield* Effect.exit(rt.interrupt(thread.id));
        h.inject("none");
        for (const call of calls)
          expect(yield* settled(call)).toMatchObject({
            _tag: "Success",
            value: { decision: "deny", resolution: { origin: "runtime" } },
          });
        for (const card of cards)
          expect(
            Exit.isFailure(yield* Effect.exit(rt.respond(thread.id, card.id, answer("allow")))),
          ).toBe(true);
        if (fault === "list" || fault === "hub") expect(Exit.isFailure(stop)).toBe(true);
        if (fault === "resolved-log") {
          expect(h.faults()).toBe(3);
          expect(Exit.isSuccess(stop)).toBe(true);
        }
        // Recover only invented functional withdrawal faults, preserving their failed result.
        yield* rt.interrupt(thread.id);
        expect(yield* store.listRequests(thread.id)).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    });
  }

  for (const decision of ["allow", "deny"] as const) {
    for (const fault of ["mode", "resolved-log"] as const) {
      it.effect(`preserves actual ${decision} with ${fault} diagnostic fault`, () => {
        const h = harness();
        return Effect.gen(function* () {
          const { rt, store, thread } = yield* setup;
          const call = yield* Effect.forkScoped(rt.requestApproval(thread.id, fields));
          const card = yield* waitFor(
            "card",
            store.listRequests(thread.id).pipe(Effect.map(([r]) => r)),
          );
          h.inject(fault);
          const response = yield* Effect.exit(rt.respond(thread.id, card.id, answer(decision)));
          h.inject("none");
          expect(yield* settled(call)).toMatchObject({
            _tag: "Success",
            value: {
              decision,
              resolution: {
                origin: "user",
                reason: decision === "allow" ? "approved" : "rejected",
              },
            },
          });
          if (fault === "resolved-log") expect(Exit.isSuccess(response)).toBe(true);
          expect(yield* store.listRequests(thread.id)).toEqual([]);
          yield* rt.interrupt(thread.id);
        }).pipe(Effect.provide(h.layer));
      });
    }
  }

  for (const fault of ["remove", "hub"] as const) {
    it.effect(`failed ${fault} withdrawal propagates and releases Allow fail-closed`, () => {
      const h = harness();
      return Effect.gen(function* () {
        const { rt, store, thread } = yield* setup;
        const call = yield* Effect.forkScoped(rt.requestApproval(thread.id, fields));
        const card = yield* waitFor(
          "card",
          store.listRequests(thread.id).pipe(Effect.map(([r]) => r)),
        );
        h.inject(fault);
        const response = yield* Effect.exit(rt.respond(thread.id, card.id, answer("allow")));
        h.inject("none");
        expect(Exit.isFailure(response)).toBe(true);
        expect(yield* settled(call)).toMatchObject({
          _tag: "Success",
          value: {
            decision: "deny",
            resolution: { origin: "runtime", reason: "approval-response-cleanup-failed" },
          },
        });
        expect(
          Exit.isFailure(yield* Effect.exit(rt.respond(thread.id, card.id, answer("allow")))),
        ).toBe(true);
        yield* rt.interrupt(thread.id);
      }).pipe(Effect.provide(h.layer));
    });
  }

  for (const fault of ["mode", "requested-log"] as const) {
    it.effect(`still raises and answers a card when ${fault} request diagnostic fails`, () => {
      const h = harness();
      return Effect.gen(function* () {
        const { rt, store, thread } = yield* setup;
        h.inject(fault);
        const call = yield* Effect.forkScoped(rt.requestApproval(thread.id, fields));
        const card = yield* waitFor(
          "card",
          store.listRequests(thread.id).pipe(Effect.map(([r]) => r)),
        );
        h.inject("none");
        yield* rt.respond(thread.id, card.id, answer("deny"));
        expect(yield* settled(call)).toMatchObject({
          _tag: "Success",
          value: { decision: "deny", resolution: { origin: "user", reason: "rejected" } },
        });
        expect(yield* store.listRequests(thread.id)).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect(
    "caller interruption with a logger fault withdraws only its card and releases the lock",
    () => {
      const h = harness();
      return Effect.gen(function* () {
        const { rt, store, thread } = yield* setup;
        const first = yield* Effect.forkScoped(rt.requestApproval(thread.id, fields));
        const second = yield* Effect.forkScoped(rt.requestApproval(thread.id, fields));
        const cards = yield* waitFor(
          "two cards",
          store.listRequests(thread.id).pipe(Effect.map((rs) => rs.length === 2 && rs)),
        );
        h.inject("resolved-log");
        yield* Fiber.interrupt(first);
        h.inject("none");
        expect(yield* store.listRequests(thread.id)).toHaveLength(1);
        expect(
          Exit.isFailure(yield* Effect.exit(rt.respond(thread.id, cards[0]!.id, answer("allow")))),
        ).toBe(true);
        expect(second.pollUnsafe()).toBeUndefined();
        yield* rt.interrupt(thread.id);
        expect(yield* settled(second)).toMatchObject({
          _tag: "Success",
          value: { decision: "deny", resolution: { origin: "runtime" } },
        });
        expect(yield* store.listRequests(thread.id)).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    },
  );
});

describe("orphan routing retains server-card ownership", () => {
  for (const fault of ["list", "clear"] as const) {
    for (const scope of ["once", "session", "always"] as const) {
      it.effect(`orphan routing blocks late Allow/Reject/${scope} after ${fault} fault`, () => {
        const h = harness();
        return Effect.gen(function* () {
          const { rt, store, thread } = yield* setup;
          const fake = yield* FakeAgentControl;
          const native = yield* fake.latest(thread.id);
          const other = yield* rt.create({
            projectRoot: "/invented",
            checkout: { kind: "main", path: "/invented" },
            model: { agent: "codex", model: "gpt-6.1-sol" },
            mode: "default",
          });
          const calls = [];
          for (let i = 0; i < 2; i++)
            calls.push(yield* Effect.forkScoped(rt.requestApproval(thread.id, fields)));
          const cards = yield* waitFor(
            "two cards",
            store.listRequests(thread.id).pipe(Effect.map((rs) => rs.length === 2 && rs)),
          );
          h.inject(fault);
          expect(Exit.isFailure(yield* Effect.exit(rt.interrupt(thread.id)))).toBe(true);
          h.inject("none");
          for (const call of calls) {
            const receipt = yield* settled(call);
            expect(receipt).toMatchObject({
              _tag: "Success",
              value: { decision: "deny" },
            });
          }
          // Both cards really remain stored after the failed withdrawal; this is no simulated native call.
          expect(yield* store.listRequests(thread.id)).toHaveLength(2);
          const forwardedBefore = native.responses.length;
          for (const card of cards) {
            for (const id of [thread.id, other.id]) {
              for (const decision of ["allow", "deny"] as const) {
                const result = yield* Effect.exit(
                  rt.respond(id, card.id, { ...answer(decision), scope }),
                );
                expect(Exit.isFailure(result)).toBe(true);
              }
            }
          }
          expect(native.responses.length).toBe(forwardedBefore);
          yield* rt.interrupt(thread.id);
          expect(yield* store.listRequests(thread.id)).toEqual([]);
          // Successful matching cleanup retires the origin; a genuine new native card using the
          // same ID is handled by the provider, without broadly blocking native approvals.
          yield* rt.send(thread.id, { text: "invented next turn" });
          yield* waitFor("running", rt.status(thread.id).pipe(Effect.map((s) => s === "running")));
          yield* native.emit({
            type: "request",
            request: {
              kind: "approval",
              id: cards[0]!.id,
              toolName: "Bash",
              displayName: "Invented native",
              input: {},
              suggestions: [],
            },
          });
          yield* waitFor(
            "native card",
            store.listRequests(thread.id).pipe(Effect.map((rs) => rs.length === 1)),
          );
          yield* rt.respond(thread.id, cards[0]!.id, answer("deny"));
          expect(native.responses.length).toBe(forwardedBefore + 1);
          expect(
            Exit.isFailure(
              yield* Effect.exit(rt.respond(thread.id, cards[0]!.id, answer("allow"))),
            ),
          ).toBe(true);
        }).pipe(Effect.provide(h.layer));
      });
    }
  }

  for (const lifecycle of ["turn", "session"] as const) {
    it.effect(`${lifecycle} end releases app cards and refuses duplicate late answers`, () => {
      const h = harness();
      return Effect.gen(function* () {
        const { rt, store, thread } = yield* setup;
        const native = yield* (yield* FakeAgentControl).latest(thread.id);
        const calls = [];
        for (let i = 0; i < 2; i++)
          calls.push(yield* Effect.forkScoped(rt.requestApproval(thread.id, fields)));
        const cards = yield* waitFor(
          "two cards",
          store.listRequests(thread.id).pipe(Effect.map((rs) => rs.length === 2 && rs)),
        );
        if (lifecycle === "turn") yield* native.emit({ type: "turnEnd", reason: "completed" });
        else yield* native.end();
        for (const call of calls)
          expect(yield* settled(call)).toMatchObject({
            _tag: "Success",
            value: { decision: "deny", resolution: { origin: "runtime" } },
          });
        expect(yield* store.listRequests(thread.id)).toEqual([]);
        for (const card of cards) {
          expect(
            Exit.isFailure(yield* Effect.exit(rt.respond(thread.id, card.id, answer("allow")))),
          ).toBe(true);
          expect(
            Exit.isFailure(yield* Effect.exit(rt.respond(thread.id, card.id, answer("deny")))),
          ).toBe(true);
        }
        expect(native.responses).toHaveLength(0);
      }).pipe(Effect.provide(h.layer));
    });
  }

  it.effect("session replacement clears old origin without blocking a new native card", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { rt, store, thread } = yield* setup;
      const fake = yield* FakeAgentControl;
      const old = yield* fake.latest(thread.id);
      const call = yield* Effect.forkScoped(rt.requestApproval(thread.id, fields));
      const card = yield* waitFor(
        "card",
        store.listRequests(thread.id).pipe(Effect.map(([r]) => r)),
      );
      yield* rt.restartSession(thread.id, "interrupt");
      expect(yield* settled(call)).toMatchObject({ _tag: "Success", value: { decision: "deny" } });
      const fresh = yield* waitFor(
        "replacement session",
        fake.latest(thread.id).pipe(Effect.map((s) => s !== old && s)),
      );
      expect(
        Exit.isFailure(yield* Effect.exit(rt.respond(thread.id, card.id, answer("allow")))),
      ).toBe(true);
      yield* rt.send(thread.id, { text: "invented replacement turn" });
      yield* waitFor("running", rt.status(thread.id).pipe(Effect.map((s) => s === "running")));
      yield* fresh.emit({
        type: "request",
        request: {
          kind: "approval",
          id: card.id,
          toolName: "Bash",
          displayName: "Invented native",
          input: {},
          suggestions: [],
        },
      });
      yield* waitFor(
        "native replacement card",
        store.listRequests(thread.id).pipe(Effect.map((rs) => rs.length === 1)),
      );
      yield* rt.respond(thread.id, card.id, answer("deny"));
      expect(fresh.responses).toHaveLength(1);
      expect(old.responses).toHaveLength(0);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("restart clears persisted orphan cards; failed boot withdrawal refuses startup", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gram-invented-approval-restart-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
      const file = join(dir, "invented.sqlite");
      const first = harness(file);
      const saved = yield* Effect.gen(function* () {
        const { rt, store, thread } = yield* setup;
        const call = yield* Effect.forkScoped(rt.requestApproval(thread.id, fields));
        const card = yield* waitFor(
          "card",
          store.listRequests(thread.id).pipe(Effect.map(([r]) => r)),
        );
        first.inject("clear");
        expect(Exit.isFailure(yield* Effect.exit(rt.interrupt(thread.id)))).toBe(true);
        expect(yield* settled(call)).toMatchObject({
          _tag: "Success",
          value: { decision: "deny" },
        });
        return { threadId: thread.id, requestId: card.id };
      }).pipe(Effect.provide(first.layer));
      expect(
        yield* Effect.gen(function* () {
          return (yield* (yield* ThreadStore).listRequests(saved.threadId)).length;
        }).pipe(Effect.provide(ThreadStore.layerSqlite(file))),
      ).toBe(1);
      const failed = harness(file);
      failed.inject("clear");
      let reached = false;
      const boot = yield* Effect.exit(
        Effect.sync(() => {
          reached = true;
        }).pipe(Effect.provide(failed.layer)),
      );
      expect(Exit.isFailure(boot)).toBe(true);
      expect(reached).toBe(false);
      const fresh = harness(file);
      yield* Effect.gen(function* () {
        const rt = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const fake = yield* FakeAgentControl;
        expect(yield* store.listRequests(saved.threadId)).toEqual([]);
        yield* rt.send(saved.threadId, { text: "invented restart turn" });
        yield* waitFor(
          "restarted turn running",
          rt.status(saved.threadId).pipe(Effect.map((s) => s === "running")),
        );
        const session = yield* waitFor("new session", fake.latest(saved.threadId));
        expect(
          Exit.isFailure(
            yield* Effect.exit(rt.respond(saved.threadId, saved.requestId, answer("allow"))),
          ),
        ).toBe(true);
        yield* session.emit({
          type: "request",
          request: {
            kind: "approval",
            id: saved.requestId as RequestId,
            toolName: "Bash",
            displayName: "Invented native",
            input: {},
            suggestions: [],
          },
        });
        yield* waitFor(
          "native restart card",
          store.listRequests(saved.threadId).pipe(Effect.map((rs) => rs.length === 1)),
        );
        yield* rt.respond(saved.threadId, saved.requestId, answer("deny"));
        expect(session.responses).toHaveLength(1);
      }).pipe(Effect.provide(fresh.layer));
    }),
  );
});
