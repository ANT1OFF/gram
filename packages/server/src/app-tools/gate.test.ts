import { describe, expect, it } from "@effect/vitest";
import type { ServerEvent, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import type { AppToolCall } from "./definition.ts";
import { AppToolRegistry, defineAppTool } from "./registry.ts";

const calls: Array<string> = [];

const probe = (name: string, toolClass: "read" | "crossThread" | "outward" | "outwardGated") =>
  defineAppTool({
    descriptor: { name, class: toolClass, description: `A ${toolClass} probe.` },
    input: Schema.Struct({ n: Schema.Number }),
    handle: (_threadId, { n }) =>
      Effect.sync(() => {
        calls.push(`${name}:${n}`);
        return { n };
      }),
  });

/** A probe whose own answer is `n > 1`: the class's rule is overridden per call. */
const asking = (name: string, toolClass: "self" | "crossThread" | "outward") =>
  defineAppTool({
    descriptor: { name, class: toolClass, description: `A ${toolClass} probe that asks.` },
    input: Schema.Struct({ n: Schema.Number }),
    handle: (_threadId, { n }) =>
      Effect.sync(() => {
        calls.push(`${name}:${n}`);
        return { n };
      }),
    needsApproval: (_threadId, { n }) => Effect.succeed(n > 1),
  });

/** An idle thread, with probe tools registered next to the core ones. */
const setup = Effect.gen(function* () {
  const registry = yield* AppToolRegistry;
  const runtimes = yield* ThreadRuntimes;
  yield* registry.register([
    probe("probe_read", "read"),
    probe("probe_cross", "crossThread"),
    probe("probe_outward", "outward"),
    asking("asking_self", "self"),
    asking("asking_cross", "crossThread"),
    asking("asking_outward", "outward"),
    probe("probe_gated", "outwardGated"),
    defineAppTool({
      ...probe("delegated_outward", "outward"),
      handle: (_threadId: ThreadId, { n }: { readonly n: number }, call: AppToolCall) =>
        Effect.succeed({ n, carded: call.carded }),
      delegatedAtFullAutonomy: (_threadId, { n }) => Effect.succeed(n === 1),
    }),
  ]);
  const thread = yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
  });
  yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
  const pick = (binding: "transport" | "session" | "ungated", name: string) => {
    const tools =
      binding === "transport"
        ? registry.forTransport(thread.id)
        : binding === "session"
          ? registry.forSession(thread.id)
          : registry.forThread(thread.id);
    const tool = tools.find((t) => t.descriptor.name === name);
    if (tool === undefined) throw new Error(`no app tool ${name}`);
    return tool;
  };
  return {
    thread,
    runtimes,
    transport: (name: string) => pick("transport", name),
    session: (name: string) => pick("session", name),
    hosted: (name: string) => pick("ungated", name),
  };
});

const nextCard = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    return yield* waitFor(
      "an approval card",
      store.listRequests(threadId).pipe(Effect.map((requests) => requests[0])),
    );
  });

const answer = (threadId: ThreadId, decision: "allow" | "deny", scope: "once" | "session") =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const card = yield* nextCard(threadId);
    yield* runtimes.respond(threadId, card.id, { kind: "approval", decision, scope });
    return card;
  });

describe("registry-enforced safety classes", () => {
  it.effect("runs read tools without a card and refuses a declined outward call", () =>
    Effect.gen(function* () {
      const { thread, runtimes, transport } = yield* setup;
      expect(yield* transport("probe_read").run({ n: 1 })).toEqual({ n: 1 });

      const call = yield* Effect.forkScoped(transport("probe_outward").run({ n: 2 }));
      const card = yield* nextCard(thread.id);
      expect(card).toMatchObject({
        kind: "approval",
        toolName: "mcp__gram__probe_outward",
        displayName: "probe_outward",
        input: { n: 2 },
        scopes: ["once"],
      });
      expect(yield* runtimes.status(thread.id)).toBe("needsApproval");
      yield* runtimes.respond(thread.id, card.id, {
        kind: "approval",
        decision: "deny",
        scope: "once",
      });
      expect(yield* Fiber.join(call).pipe(Effect.flip)).toMatchObject({
        tool: "probe_outward",
        approvalRequired: true,
      });
      expect(calls).not.toContain("probe_outward:2");
      expect(yield* runtimes.status(thread.id)).toBe("idle");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "remembers a crossThread allow for the session but asks for outward calls every time",
    () =>
      Effect.gen(function* () {
        const { thread, transport } = yield* setup;
        const cross = yield* Effect.forkScoped(transport("probe_cross").run({ n: 1 }));
        expect(yield* answer(thread.id, "allow", "session")).toMatchObject({
          scopes: ["once", "session"],
        });
        expect(yield* Fiber.join(cross)).toEqual({ n: 1 });
        expect(yield* transport("probe_cross").run({ n: 2 })).toEqual({ n: 2 });

        for (const n of [1, 2]) {
          const outward = yield* Effect.forkScoped(transport("probe_outward").run({ n }));
          yield* answer(thread.id, "allow", "session");
          expect(yield* Fiber.join(outward)).toEqual({ n });
        }
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("denies a waiting card when the session closes", () =>
    Effect.gen(function* () {
      const { thread, runtimes, transport } = yield* setup;
      const call = yield* Effect.forkScoped(transport("probe_outward").run({ n: 3 }));
      yield* nextCard(thread.id);
      yield* runtimes.close(thread.id);
      expect(yield* Fiber.join(call).pipe(Effect.flip)).toMatchObject({ approvalRequired: true });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("raises no card for a thread in bypass mode", () =>
    Effect.gen(function* () {
      const { thread, runtimes, transport } = yield* setup;
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        mode: "bypassPermissions" as const,
      }));
      expect(yield* transport("probe_outward").run({ n: 5 })).toEqual({ n: 5 });
      expect(yield* transport("probe_cross").run({ n: 5 })).toEqual({ n: 5 });
      expect(yield* (yield* ThreadStore).listRequests(thread.id)).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("lets a crossThread call through when the tool says it needs no card", () =>
    Effect.gen(function* () {
      const { thread, transport } = yield* setup;
      expect(yield* transport("asking_cross").run({ n: 1 })).toEqual({ n: 1 });
      expect(yield* (yield* ThreadStore).listRequests(thread.id)).toEqual([]);

      const asked = yield* Effect.forkScoped(transport("asking_cross").run({ n: 2 }));
      expect(yield* answer(thread.id, "allow", "once")).toMatchObject({ scopes: ["once"] });
      expect(yield* Fiber.join(asked)).toEqual({ n: 2 });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps an outward card whatever the tool says", () =>
    Effect.gen(function* () {
      const { thread, transport } = yield* setup;
      const call = yield* Effect.forkScoped(transport("asking_outward").run({ n: 1 }));
      expect(yield* answer(thread.id, "deny", "once")).toMatchObject({ scopes: ["once"] });
      expect(yield* Fiber.join(call).pipe(Effect.flip)).toMatchObject({ approvalRequired: true });
      expect(calls).not.toContain("asking_outward:1");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "raises a once-only card a self tool asks for, in bypass mode and after a session allow",
    () =>
      Effect.gen(function* () {
        const { thread, runtimes, transport } = yield* setup;
        expect(yield* transport("asking_self").run({ n: 1 })).toEqual({ n: 1 });
        expect(yield* (yield* ThreadStore).listRequests(thread.id)).toEqual([]);

        for (const n of [2, 3]) {
          const call = yield* Effect.forkScoped(transport("asking_self").run({ n }));
          expect(yield* answer(thread.id, "allow", "session")).toMatchObject({
            displayName: "asking_self",
            scopes: ["once"],
          });
          expect(yield* Fiber.join(call)).toEqual({ n });
        }

        yield* runtimes.updateThread(thread.id, (t) => ({
          ...t,
          mode: "bypassPermissions" as const,
        }));
        const bypassed = yield* Effect.forkScoped(transport("asking_self").run({ n: 4 }));
        yield* answer(thread.id, "deny", "once");
        expect(yield* Fiber.join(bypassed).pipe(Effect.flip)).toMatchObject({
          tool: "asking_self",
          approvalRequired: true,
        });
        expect(calls).not.toContain("asking_self:4");
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("gates nothing on the binding for names and scripted calls", () =>
    Effect.gen(function* () {
      const { hosted } = yield* setup;
      expect(yield* hosted("probe_outward").run({ n: 4 })).toEqual({ n: 4 });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

/** Makes the setup's thread a worker, an orchestrator or leaves it plain, in `mode`. */
const castAs = (
  threadId: ThreadId,
  as: "plain" | "worker" | "orchestrator",
  mode: "default" | "auto" | "bypassPermissions",
) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* runtimes.updateThread(threadId, (t) => ({
      ...t,
      mode,
      ...(as === "worker"
        ? { spawnedBy: { threadId: "orch" as ThreadId, feature: "f" } }
        : as === "orchestrator"
          ? { role: "orchestrator" as const }
          : {}),
    }));
  });

/** The card a call raises and the call's result once it is answered, or its result with none. */
const cardFor = (
  threadId: ThreadId,
  tool: { run(input: unknown): Effect.Effect<unknown, unknown> },
  n: number,
  scope: "once" | "session" = "once",
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const call = yield* Effect.forkScoped(tool.run({ n }));
    const card = yield* waitFor(
      "a card or the result",
      Effect.gen(function* () {
        const [request] = yield* store.listRequests(threadId);
        if (request !== undefined) return request;
        return call.pollUnsafe() === undefined ? undefined : ("none" as const);
      }),
    );
    if (card === "none") return { card, result: yield* Fiber.join(call) };
    yield* answer(threadId, "allow", scope);
    return {
      card: card.kind === "approval" ? card.scopes : card.kind,
      result: yield* Fiber.join(call),
    };
  });

describe("Claude's in-process binding (`forSession`)", () => {
  // On main before this binding, Claude's tools ran ungated and every one of these calls ran with
  // no card: Claude's SDK let them through in `bypassPermissions`, and Auto's classifier could.
  for (const as of ["worker", "orchestrator"] as const) {
    it.effect(
      `asks ${as === "worker" ? "a worker" : "an orchestrator"} in bypass mode, once per call`,
      () =>
        Effect.gen(function* () {
          const { thread, session } = yield* setup;
          yield* castAs(thread.id, as, "bypassPermissions");
          for (const name of ["probe_outward", "probe_cross"]) {
            expect(yield* cardFor(thread.id, session(name), 1, "session")).toEqual({
              card: ["once"],
              result: { n: 1 },
            });
            expect((yield* cardFor(thread.id, session(name), 2)).card).toEqual(["once"]);
          }
        }).pipe(Effect.provide(RuntimeTestLayer)),
    );
  }

  for (const mode of ["auto", "default"] as const) {
    it.effect(`asks a plain thread in ${mode} mode`, () =>
      Effect.gen(function* () {
        const { thread, session } = yield* setup;
        yield* castAs(thread.id, "plain", mode);
        expect((yield* cardFor(thread.id, session("probe_outward"), 1)).card).toEqual(["once"]);
        expect((yield* cardFor(thread.id, session("probe_cross"), 1, "session")).card).toEqual([
          "once",
          "session",
        ]);
        // An allow for the session is remembered for a crossThread tool, never an outward one.
        expect((yield* cardFor(thread.id, session("probe_cross"), 2)).card).toBe("none");
        expect((yield* cardFor(thread.id, session("probe_outward"), 2)).card).toEqual(["once"]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
    );
  }

  it.effect("remembers a session allow only while that agent session lives", () =>
    Effect.gen(function* () {
      const { thread, runtimes, session, transport } = yield* setup;
      for (const tool of [session("probe_cross"), transport("probe_cross")]) {
        expect((yield* cardFor(thread.id, tool, 1, "session")).card).toEqual(["once", "session"]);
        expect((yield* cardFor(thread.id, tool, 2)).card).toBe("none");
        yield* runtimes.freshSession(thread.id);
        yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
        expect((yield* cardFor(thread.id, tool, 3, "session")).card).toEqual(["once", "session"]);
        expect((yield* cardFor(thread.id, tool, 4)).card).toBe("none");
        yield* runtimes.freshSession(thread.id);
        yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
      }
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "asks on every call, in every mode, when a tool says so itself, as the transport does",
    () =>
      Effect.gen(function* () {
        const { thread, session, transport } = yield* setup;
        for (const mode of ["default", "auto", "bypassPermissions"] as const) {
          yield* castAs(thread.id, "plain", mode);
          for (const bound of [session, transport]) {
            for (const n of [2, 3]) {
              expect((yield* cardFor(thread.id, bound("asking_cross"), n, "session")).card).toEqual(
                ["once"],
              );
              expect((yield* cardFor(thread.id, bound("asking_self"), n, "session")).card).toEqual([
                "once",
              ]);
            }
            // `false` from the tool: no card, whatever the class.
            expect((yield* cardFor(thread.id, bound("asking_cross"), 1)).card).toBe("none");
          }
        }
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("skips only the class's card for a plain thread in bypass, on both bindings", () =>
    Effect.gen(function* () {
      const { thread, session, transport } = yield* setup;
      yield* castAs(thread.id, "plain", "bypassPermissions");
      for (const bound of [session, transport]) {
        for (const name of ["probe_cross", "probe_outward", "asking_outward"]) {
          expect((yield* cardFor(thread.id, bound(name), 2)).card).toBe("none");
        }
        expect((yield* cardFor(thread.id, bound("asking_cross"), 2)).card).toEqual(["once"]);
      }
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps the delegation and the tools that raise their own card", () =>
    Effect.gen(function* () {
      const { thread, session, hosted } = yield* setup;
      yield* castAs(thread.id, "worker", "bypassPermissions");
      // The handler hears which it was: waived, approved on a card, or no gate at all.
      expect(yield* cardFor(thread.id, session("delegated_outward"), 1)).toEqual({
        card: "none",
        result: { n: 1, carded: false },
      });
      expect(yield* cardFor(thread.id, session("delegated_outward"), 2)).toEqual({
        card: ["once"],
        result: { n: 2, carded: true },
      });
      expect(yield* hosted("delegated_outward").run({ n: 2 })).toEqual({ n: 2 });
      expect((yield* cardFor(thread.id, session("probe_gated"), 1)).card).toBe("none");
      expect((yield* cardFor(thread.id, session("probe_read"), 1)).card).toBe("none");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

describe("session app tools", () => {
  it.effect(
    "connectors_status, reconnect_connector and set_connector_enabled drive the session",
    () =>
      Effect.gen(function* () {
        const { thread, hosted } = yield* setup;
        const fake = yield* FakeAgentControl;
        expect(yield* hosted("connectors_status").run({})).toEqual({
          connectors: [
            { name: "github", status: "connected", scope: "user" },
            {
              name: "linear",
              status: "needs-auth",
              scope: "claudeai",
              url: "https://mcp.linear.app/mcp",
              claudeAi: { id: "mcpsrv_linear" },
            },
          ],
        });
        expect(yield* hosted("connectors_status").run({ name: "linear" })).toMatchObject({
          connectors: [{ name: "linear" }],
        });
        yield* hosted("reconnect_connector").run({ name: "linear" });
        yield* hosted("set_connector_enabled").run({ name: "github", enabled: false });
        expect((yield* fake.latest(thread.id)).connectorCalls).toEqual([
          "reconnect:linear",
          "enable:github:false",
        ]);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("request_directory grants a folder only after the user allows it", () =>
    Effect.gen(function* () {
      const { thread, hosted } = yield* setup;
      const store = yield* ThreadStore;
      const fake = yield* FakeAgentControl;
      const folder = mkdtempSync(join(tmpdir(), "gram-grant-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(folder, { recursive: true })));

      const call = yield* Effect.forkScoped(
        hosted("request_directory").run({ path: folder, reason: "Read the shared config" }),
      );
      expect(yield* answer(thread.id, "allow", "once")).toMatchObject({
        displayName: "Grant folder access",
        input: { path: folder, reason: "Read the shared config" },
        scopes: ["once"],
      });
      expect(yield* Fiber.join(call)).toEqual({ granted: true, path: folder });
      expect((yield* store.getThread(thread.id)).additionalDirectories).toEqual([folder]);
      expect((yield* fake.latest(thread.id)).directories).toEqual([[folder]]);
      expect(yield* hosted("request_directory").run({ path: folder })).toEqual({
        granted: true,
        path: folder,
      });

      const other = join(folder, "nested");
      mkdirSync(other);
      const declined = yield* Effect.forkScoped(hosted("request_directory").run({ path: other }));
      yield* answer(thread.id, "deny", "once");
      expect(yield* Fiber.join(declined)).toEqual({ granted: false, path: other });

      const missing = join(folder, "gone");
      const error = yield* hosted("request_directory").run({ path: missing }).pipe(Effect.flip);
      expect(error.message).toBe(`Folder not found: ${missing}`);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

describe("show_panel", () => {
  it.effect("publishes ui.showPanel with a normalized target", () =>
    Effect.gen(function* () {
      const { thread, hosted } = yield* setup;
      const hub = yield* EventHub;
      const events = yield* Queue.unbounded<ServerEvent>();
      yield* hub.serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] })).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const seen: Array<ServerEvent> = [];
      const drain = Effect.gen(function* () {
        seen.push(...(yield* Queue.clear(events)));
        return seen;
      });
      yield* waitFor(
        "the subscription",
        drain.pipe(Effect.map((all) => all.some((e) => e.type === "threads.snapshot"))),
      );

      yield* hosted("show_panel").run({ panel: "preview", target: "3000" });
      yield* hosted("show_panel").run({ panel: "diff", target: "src/app.ts" });
      const shown = yield* waitFor(
        "two ui.showPanel events",
        drain.pipe(
          Effect.map((all) => {
            const panels = all.filter((e) => e.type === "ui.showPanel");
            return panels.length === 2 && panels;
          }),
        ),
      );
      expect(shown).toEqual([
        {
          type: "ui.showPanel",
          threadId: thread.id,
          panel: "preview",
          target: "http://127.0.0.1:3000/",
        },
        { type: "ui.showPanel", threadId: thread.id, panel: "diff", target: "src/app.ts" },
      ]);

      const error = yield* hosted("show_panel")
        .run({ panel: "preview", target: "https://organization.example.invalid" })
        .pipe(Effect.flip);
      expect(error.message).toMatch(/localhost/);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
