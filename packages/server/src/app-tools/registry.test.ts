import { describe, expect, it } from "@effect/vitest";
import {
  AppToolError,
  type AppToolDescriptor,
  MAX_OPEN_WAITS,
  type TaskId,
  type WaitId,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { eventually } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadPlans } from "../plans/service.ts";
import { ThreadWaits } from "../waits/service.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import {
  allowedWithoutApproval,
  approvalFor,
  AppToolRegistry,
  bindAppTools,
  defineAppTool,
  makeApprovalGate,
  OWN_PR_REVIEW_TOOLS,
  REVIEW_BOT_THREAD_TOOLS,
  SPAWN_TASK_NEEDS_REASON,
} from "./registry.ts";
import { WAIT_DECISION_NEEDS_ASK_USER, waitAge } from "./wait-tools.ts";

/** Waits for the thread to rest after its turn. */
const waitStatusIdle = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    return yield* waitFor(
      "status idle",
      runtimes.status(threadId).pipe(Effect.map((status) => status === "idle")),
    );
  });

/** Later than the agent's own write just before, as a click is. */
const later = () => Date.now() + 1;

const createThread = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  return yield* runtimes.create({
    projectRoot: "/work/repo",
    checkout: { kind: "main", path: "/work/repo" },
  });
});

const runTool = (
  threadId: ThreadId,
  name: string,
  input: unknown,
  audience?: "plain" | "orchestrator" | "worker",
) =>
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const tool = registry.forThread(threadId, audience).find((t) => t.descriptor.name === name);
    if (tool === undefined) return yield* Effect.die(`no tool ${name}`);
    return yield* tool.run(input);
  });

/** A tool whose own answer is `n > 1`, whatever its class says. */
const asking = (toolClass: "self" | "crossThread" | "outward") =>
  defineAppTool({
    descriptor: { name: `${toolClass}_asking`, class: toolClass, description: "" },
    input: Schema.Struct({ n: Schema.Number }),
    handle: () => Effect.void,
    needsApproval: (_threadId, { n }) => Effect.succeed(n > 1),
  });

/** A tool bound for `audience`, or for every thread without one. */
const forAudience = (name: string, audience?: ReadonlyArray<"orchestrator" | "worker">) =>
  defineAppTool({
    descriptor: { name, class: "self", description: "" },
    input: Schema.Struct({ n: Schema.optionalKey(Schema.Number) }),
    handle: () => Effect.void,
    ...(audience === undefined ? {} : { audience }),
  });

/** The names of the `forAudience` tools among `tools`. */
const added = (tools: ReadonlyArray<{ descriptor: { name: string } }>) =>
  tools.map((t) => t.descriptor.name).filter((name) => name.startsWith("for_"));

/** A tool whose `resolve` defaults `n` to 7, and whose delegation holds for that target alone. */
const resolvingTool = (toolClass: "outward" | "crossThread") =>
  defineAppTool({
    descriptor: { name: toolClass, class: toolClass, description: "" },
    input: Schema.Struct({ n: Schema.optionalKey(Schema.Number) }),
    resolve: (_threadId, { n = 7 }) => Effect.succeed({ target: n }),
    handle: (_threadId, { target }: { readonly target: number }) => Effect.succeed(target),
    delegatedAtFullAutonomy: (_threadId, _input, { target }: { readonly target: number }) =>
      Effect.succeed(target === 7),
  });

describe("app tool policy", () => {
  const sideEffects: Array<string> = [];
  const tool = (toolClass: "read" | "self" | "crossThread" | "outward") =>
    defineAppTool({
      descriptor: { name: `${toolClass}_tool`, class: toolClass, description: "" },
      input: Schema.Struct({ n: Schema.Number }),
      handle: (_threadId, { n }) => Effect.sync(() => sideEffects.push(`${toolClass}:${n}`)),
    });
  const tools = bindAppTools(
    [tool("read"), tool("self"), tool("crossThread"), tool("outward")],
    "t1" as ThreadId,
  );

  it("classifies which tools may run without an approval card", () => {
    expect(
      (["read", "self", "crossThread", "outward"] as const).map(allowedWithoutApproval),
    ).toEqual([true, true, false, false]);
  });

  it("lets a tool's own answer win over its class, as that call's card, except for an outward call", () => {
    const classes = ["read", "self", "outwardGated", "crossThread", "outward"] as const;
    expect(classes.map((c) => approvalFor(c, undefined))).toEqual([
      "none",
      "none",
      "none",
      "class",
      "class",
    ]);
    expect(classes.map((c) => approvalFor(c, false))).toEqual([
      "none",
      "none",
      "none",
      "none",
      "class",
    ]);
    expect(classes.map((c) => approvalFor(c, true))).toEqual([
      "forced",
      "forced",
      "forced",
      "forced",
      "class",
    ]);
  });

  it.effect("binds a per-call answer for the host, but never for an outward tool", () =>
    Effect.gen(function* () {
      const [cross, outward, plain, self] = bindAppTools(
        [asking("self"), asking("crossThread"), asking("outward"), tool("read")],
        "t1" as ThreadId,
      );
      expect(yield* self!.needsApproval!({ n: 2 })).toBe(true);
      expect(yield* cross!.needsApproval!({ n: 1 })).toBe(false);
      expect(outward!.needsApproval).toBeUndefined();
      expect(plain!.needsApproval).toBeUndefined();
      // Input that doesn't decode falls back to what the class says.
      expect(yield* self!.needsApproval!({ n: "x" })).toBe(false);
      expect(yield* cross!.needsApproval!({ n: "x" })).toBe(true);
    }),
  );

  it("lifts an outward card for the named full-autonomy delegation alone, and nothing else with it", () => {
    const classes = ["read", "self", "outwardGated", "crossThread", "outward"] as const;
    for (const asked of [undefined, false, true]) {
      expect(approvalFor("outward", asked, true)).toBe("none");
      expect(approvalFor("outward", asked, false)).toBe("class");
      // On every other class the delegation is not read at all.
      for (const c of classes.filter((each) => each !== "outward")) {
        expect(approvalFor(c, asked, true)).toBe(approvalFor(c, asked));
      }
    }
  });

  it.effect("binds the delegation for an outward tool that names it, and gates by it", () =>
    Effect.gen(function* () {
      const ran: Array<number> = [];
      const delegable = (toolClass: "outward" | "crossThread", name: string) =>
        defineAppTool({
          descriptor: { name, class: toolClass, description: "" },
          input: Schema.Struct({ n: Schema.Number }),
          handle: (_threadId, { n }) => Effect.sync(() => void ran.push(n)),
          needsApproval: () => Effect.succeed(false),
          delegatedAtFullAutonomy: (_threadId, { n }) =>
            n === 0 ? Effect.die(new Error("boom")) : Effect.succeed(n > 1),
        });
      const definitions = [delegable("outward", "merge"), delegable("crossThread", "stop")];
      const [merge, stop] = bindAppTools(definitions, "t1" as ThreadId);
      expect(merge!.needsApproval).toBeUndefined();
      expect(yield* merge!.delegatedAtFullAutonomy!({ n: 2 })).toBe(true);
      expect(yield* merge!.delegatedAtFullAutonomy!({ n: 1 })).toBe(false);
      expect(yield* merge!.delegatedAtFullAutonomy!({ n: 0 })).toBe(false);
      expect(yield* merge!.delegatedAtFullAutonomy!({ n: "x" })).toBe(false);
      // Not an outward tool: the delegation isn't bound, and its `needsApproval` is, as ever.
      expect(stop!.delegatedAtFullAutonomy).toBeUndefined();
      expect(yield* stop!.needsApproval!({ n: 2 })).toBe(false);

      const asked: Array<unknown> = [];
      const [gatedMerge] = bindAppTools(definitions, "t1" as ThreadId, {
        approve: (_threadId, descriptor, input) =>
          Effect.sync(() => void asked.push([descriptor.name, input])),
      });
      yield* gatedMerge!.run({ n: 2 });
      expect(asked).toEqual([]);
      yield* gatedMerge!.run({ n: 1 });
      yield* gatedMerge!.run({ n: 0 });
      expect(asked).toEqual([
        ["merge", { n: 1 }],
        ["merge", { n: 0 }],
      ]);
      expect(ran).toEqual([2, 1, 0]);
    }),
  );

  it.effect(
    "asks the delegation about the resolved target, and refuses a key an outward tool doesn't take",
    () =>
      Effect.gen(function* () {
        const asked: Array<unknown> = [];
        const [cross, outward] = bindAppTools(
          [resolvingTool("outward"), resolvingTool("crossThread")],
          "t1" as ThreadId,
          { approve: (_threadId, _descriptor, input) => Effect.sync(() => void asked.push(input)) },
        );
        expect(yield* outward!.delegatedAtFullAutonomy!({})).toBe(true);
        expect(yield* outward!.delegatedAtFullAutonomy!({ n: 8 })).toBe(false);
        expect(yield* outward!.delegatedAtFullAutonomy!({ pr: 8 })).toBe(false);
        expect(yield* outward!.run({})).toBe(7);
        expect(yield* outward!.run({ n: 8 })).toBe(8);
        expect(asked).toEqual([{ n: 8 }]);
        const misnamed = yield* outward!.run({ pr: 8 }).pipe(Effect.flip);
        expect(misnamed.message).toMatch(/^Invalid input: /);
        expect(yield* cross!.run({ pr: 8 })).toBe(7);
      }),
  );

  it.effect("forces a card a tool asks for itself, whatever its class but outward", () =>
    Effect.gen(function* () {
      const definitions = [asking("self"), asking("crossThread"), asking("outward")];
      const asked: Array<[string, boolean | undefined]> = [];
      const gate = {
        approve: (_threadId: ThreadId, d: AppToolDescriptor, ...rest: Array<unknown>) =>
          Effect.sync(() => void asked.push([d.name, rest[2] as boolean | undefined])),
      };
      for (const t of bindAppTools(definitions, "t1" as ThreadId, gate)) {
        yield* t.run({ n: 1 });
        yield* t.run({ n: 2 });
      }
      // Any `true` is that call's card alone, which bypass can't skip. An outward card is one already.
      expect(asked).toEqual([
        ["crossThread_asking", true],
        ["outward_asking", false],
        ["outward_asking", false],
        ["self_asking", true],
      ]);
    }),
  );

  it.effect("runs every bound tool once the host has allowed it", () =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(tools, (t) => t.run({ n: 1 }).pipe(Effect.result));
      expect(results.map(Result.isSuccess)).toEqual([true, true, true, true]);
      expect(sideEffects).toEqual(["crossThread:1", "outward:1", "read:1", "self:1"]);
    }),
  );

  it.effect("rejects input that doesn't match the tool's schema", () =>
    Effect.gen(function* () {
      const error = yield* tools
        .find((t) => t.descriptor.name === "self_tool")!
        .run({ n: "one" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ tool: "self_tool" });
      expect(error.message).toMatch(/^Invalid input/);
    }),
  );

  it.effect("asks about the input as decoded and resolved, and runs what the card showed", () =>
    Effect.gen(function* () {
      const cards: Array<{ input: unknown; description: string | undefined }> = [];
      const ran: Array<unknown> = [];
      const asked: Array<unknown> = [];
      let resolutions = 0;
      const [stopIt] = bindAppTools(
        [
          defineAppTool({
            descriptor: { name: "stop_it", class: "crossThread", description: "" },
            input: Schema.Struct({ target: Schema.Trim }),
            resolve: (_threadId, { target }) =>
              target === "gone"
                ? Effect.fail(new AppToolError({ tool: "stop_it", message: "unknown thread gone" }))
                : Effect.sync(() => {
                    resolutions += 1;
                    return { target, title: `“${target}”` };
                  }),
            needsApproval: (_threadId, _input, target) =>
              Effect.sync(() => {
                asked.push(target);
                return true;
              }),
            describe: (_threadId, { title }) => Effect.succeed(`Stop ${title}`),
            handle: (_threadId, resolved) => Effect.sync(() => void ran.push(resolved)),
          }),
        ],
        "t1" as ThreadId,
        {
          approve: (_threadId, _descriptor, input, description) =>
            Effect.sync(() => void cards.push({ input, description })),
        },
      );
      // A key the schema drops and whitespace it trims are not shown as though they were sent.
      yield* stopIt!.run({ target: "  a  ", threadId: "b" });
      expect(cards).toEqual([{ input: { target: "a" }, description: "Stop “a”" }]);
      expect(ran).toEqual([{ target: "a", title: "“a”" }]);
      // The approval check reads the same resolution the card and the handler do: one per call.
      expect(asked).toEqual([{ target: "a", title: "“a”" }]);
      expect(resolutions).toBe(1);
      expect(yield* stopIt!.needsApproval!({ target: " b " })).toBe(true);
      expect(asked.at(-1)).toEqual({ target: "b", title: "“b”" });
      expect(yield* stopIt!.describe!({ target: " a " })).toBe("Stop “a”");

      // Input that doesn't decode, or a target that doesn't resolve, fails with no card.
      const invalid = yield* stopIt!.run({ target: 1 }).pipe(Effect.flip);
      expect(invalid.message).toMatch(/^Invalid input/);
      const unresolved = yield* stopIt!.run({ target: " gone " }).pipe(Effect.flip);
      expect(unresolved.message).toBe("unknown thread gone");
      expect(cards).toHaveLength(1);
      expect(ran).toHaveLength(1);
    }),
  );
});

const descriptor = (name: string, toolClass: AppToolDescriptor["class"]): AppToolDescriptor => ({
  name,
  class: toolClass,
  description: "",
});
const reply = descriptor("pr_reply_to_thread", "outward");
const resolve = descriptor("pr_resolve_thread", "outward");
const rereview = descriptor("pr_request_rereview", "outward");
const spawn = descriptor("spawn_worker", "crossThread");
const send = descriptor("send_message", "crossThread");

/** A thread in `mode`, made a worker, an orchestrator or left plain. */
const threadAs = (as: "plain" | "worker" | "orchestrator", mode: Thread["mode"]) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* createThread;
    return yield* runtimes.updateThread(thread.id, (t) => ({
      ...t,
      mode,
      ...(as === "worker"
        ? { spawnedBy: { threadId: "orch" as ThreadId, feature: "f" } }
        : as === "orchestrator"
          ? { role: "orchestrator" as const }
          : {}),
    }));
  });

/** Whether `approve` raised a card; it is declined, so an asked call fails. */
const asks = (
  thread: Thread,
  what: AppToolDescriptor,
  options: {
    readonly forced?: boolean;
    readonly workerOwnPr?: boolean;
    readonly reviewBotThread?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const gate = makeApprovalGate(runtimes, store);
    const call = yield* Effect.forkScoped(
      gate.approve(thread.id, what, {}, undefined, options.forced, options),
    );
    const card = yield* eventually(
      "the call to end or ask",
      Effect.gen(function* () {
        const [request] = yield* store.listRequests(thread.id);
        if (request !== undefined) return request;
        return call.pollUnsafe() === undefined ? undefined : ("done" as const);
      }),
    );
    if (card === "done") {
      yield* Fiber.join(call);
      return false;
    }
    expect(card).toMatchObject({ kind: "approval", scopes: ["once"] });
    yield* runtimes.respond(thread.id, card.id, {
      kind: "approval",
      decision: "deny",
      scope: "once",
    });
    expect(yield* Fiber.join(call).pipe(Effect.flip)).toMatchObject({ approvalRequired: true });
    yield* eventually(
      "the card to clear",
      store.listRequests(thread.id).pipe(Effect.map((requests) => requests.length === 0)),
    );
    return true;
  });

describe("the approval gate", () => {
  it.live("a full-autonomy delegation skips the worker role gate", () =>
    Effect.gen(function* () {
      const worker = yield* threadAs("worker", "default");
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const [tool] = bindAppTools(
        [resolvingTool("outward")],
        worker.id,
        makeApprovalGate(runtimes, store),
      );
      expect(yield* tool!.run({})).toBe(7);
      expect(yield* store.listRequests(worker.id)).toEqual([]);
      const call = yield* Effect.forkScoped(tool!.run({ n: 8 }).pipe(Effect.flip));
      const card = yield* eventually(
        "the non-delegated card",
        store.listRequests(worker.id).pipe(Effect.map(([request]) => request)),
      );
      expect(card).toMatchObject({ scopes: ["once"] });
      yield* runtimes.respond(worker.id, card.id, {
        kind: "approval",
        decision: "deny",
        scope: "once",
      });
      expect(yield* Fiber.join(call)).toMatchObject({ approvalRequired: true });
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );

  it("names the review tools that write to the calling thread's own PR, and nothing else", () => {
    expect([...OWN_PR_REVIEW_TOOLS]).toEqual([
      "pr_reply_to_thread",
      "pr_resolve_thread",
      "pr_request_rereview",
    ]);
  });

  it("lets only replies and resolves answer the review bot unasked", () => {
    expect([...REVIEW_BOT_THREAD_TOOLS]).toEqual(["pr_reply_to_thread", "pr_resolve_thread"]);
  });

  it.live("never asks a plain thread or worker answering the review bot, except in Ask mode", () =>
    Effect.gen(function* () {
      const bot = { reviewBotThread: true };
      const auto = yield* threadAs("plain", "auto");
      expect(yield* asks(auto, reply, bot)).toBe(false);
      expect(yield* asks(auto, resolve, bot)).toBe(false);
      expect(yield* asks(auto, reply)).toBe(true);
      expect(yield* asks(auto, reply, { ...bot, forced: true })).toBe(true);
      // The claim covers the answer, not a request for another round nor any other tool.
      expect(yield* asks(auto, rereview, bot)).toBe(true);
      expect(yield* asks(auto, descriptor("set_auto_merge", "outward"), bot)).toBe(true);
      const worker = yield* threadAs("worker", "auto");
      expect(yield* asks(worker, reply, bot)).toBe(false);
      expect(yield* asks(worker, send, bot)).toBe(true);
      for (const as of ["plain", "worker"] as const) {
        expect(yield* asks(yield* threadAs(as, "default"), reply, bot)).toBe(true);
      }
      const orchestrator = yield* threadAs("orchestrator", "bypassPermissions");
      expect(yield* asks(orchestrator, reply, bot)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );

  it.live("lets a worker's own-PR review write follow its mode, and nothing else it does", () =>
    Effect.gen(function* () {
      const bypass = yield* threadAs("worker", "bypassPermissions");
      expect(yield* asks(bypass, reply, { workerOwnPr: true })).toBe(false);
      // Without the tool's word that the PR is the worker's own, the role decides.
      expect(yield* asks(bypass, reply)).toBe(true);
      expect(yield* asks(bypass, reply, { workerOwnPr: true, forced: true })).toBe(true);
      // Another tool's claim to it counts for nothing: a message to somebody else's thread asks.
      expect(yield* asks(bypass, send, { workerOwnPr: true })).toBe(true);
      const byDefault = yield* threadAs("worker", "default");
      expect(yield* asks(byDefault, reply, { workerOwnPr: true })).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );

  it.live("asks an orchestrator on every call in bypass, whatever the call claims", () =>
    Effect.gen(function* () {
      const orchestrator = yield* threadAs("orchestrator", "bypassPermissions");
      expect(yield* asks(orchestrator, spawn, { workerOwnPr: true })).toBe(true);
      expect(yield* asks(orchestrator, send)).toBe(true);
      expect(yield* asks(orchestrator, reply, { workerOwnPr: true })).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );

  it.live("writes a card's text plain, so agent-authored text can't reorder or hide it", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const thread = yield* threadAs("plain", "default");
      const gate = makeApprovalGate(runtimes, store);
      const call = yield* Effect.forkScoped(
        gate.approve(thread.id, send, {}, "Send to “\u202egnp.exe”:\nhi\u200b there"),
      );
      const card = yield* eventually(
        "the card",
        store.listRequests(thread.id).pipe(Effect.map(([request]) => request)),
      );
      expect(card).toMatchObject({ description: "Send to “gnp.exe”: hi there" });
      yield* runtimes.respond(thread.id, card.id, {
        kind: "approval",
        decision: "deny",
        scope: "once",
      });
      yield* Fiber.join(call).pipe(Effect.flip);
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );

  it.live("asks a plain thread by its mode, as before", () =>
    Effect.gen(function* () {
      const bypass = yield* threadAs("plain", "bypassPermissions");
      expect(yield* asks(bypass, reply)).toBe(false);
      expect(yield* asks(bypass, send)).toBe(false);
      expect(yield* asks(bypass, reply, { forced: true })).toBe(true);
      const byDefault = yield* threadAs("plain", "default");
      expect(yield* asks(byDefault, reply, { workerOwnPr: true })).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(RuntimeTestLayer)),
  );
});

describe("tool audiences", () => {
  it.effect("binds a tool only for the threads it names, on both bindings", () =>
    Effect.gen(function* () {
      const registry = yield* AppToolRegistry;
      yield* registry.register([
        forAudience("for_everyone"),
        forAudience("for_orchestrator", ["orchestrator"]),
        forAudience("for_worker", ["worker"]),
        forAudience("for_both", ["orchestrator", "worker"]),
      ]);
      const threadId = "t1" as ThreadId;
      for (const bind of [registry.forThread, registry.forTransport, registry.forSession]) {
        expect(added(bind(threadId))).toEqual(["for_everyone"]);
        expect(added(bind(threadId, "plain"))).toEqual(["for_everyone"]);
        expect(added(bind(threadId, "orchestrator"))).toEqual([
          "for_both",
          "for_everyone",
          "for_orchestrator",
        ]);
        expect(added(bind(threadId, "worker"))).toEqual(["for_both", "for_everyone", "for_worker"]);
      }
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("asks the session policy who a thread is, for the HTTP transport", () =>
    Effect.gen(function* () {
      const registry = yield* AppToolRegistry;
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* createThread;
      expect(yield* registry.audienceOf(thread.id)).toBe("plain");
      yield* runtimes.setSessionPolicy({
        forThread: (t) =>
          Effect.succeed({
            audience: t.id === thread.id ? ("worker" as const) : ("plain" as const),
            outwardGate: undefined,
          }),
      });
      expect(yield* registry.audienceOf(thread.id)).toBe("worker");
      expect(yield* registry.audienceOf("nobody" as ThreadId)).toBe("plain");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

describe("M1 core app tools", () => {
  it.effect("registers the core tools with ThreadRuntimes", () =>
    Effect.gen(function* () {
      const registry = yield* AppToolRegistry;
      const tools = registry.forThread("t1" as ThreadId);
      expect(tools.map((t) => [t.descriptor.name, t.descriptor.class])).toEqual([
        ["connectors_status", "read"],
        ["dismiss_task", "self"],
        ["list_waits", "read"],
        ["mark_chapter", "self"],
        ["mark_completed", "self"],
        ["move_to_worktree", "crossThread"],
        ["notify_user", "self"],
        ["reconnect_connector", "self"],
        ["request_directory", "self"],
        ["resolve_wait", "self"],
        ["send_file", "self"],
        ["set_connector_enabled", "self"],
        ["set_plan", "self"],
        ["set_title", "self"],
        ["set_unread", "self"],
        ["show_mock", "self"],
        ["show_panel", "self"],
        ["show_widget", "self"],
        ["spawn_task", "self"],
        ["wait_on_user", "self"],
      ]);
      const error = yield* registry.register(registry.definitions.slice(0, 1)).pipe(Effect.exit);
      expect(error._tag).toBe("Failure");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("set_title names the thread unless the user already did", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const thread = yield* createThread;
      yield* runTool(thread.id, "set_title", { title: "Agent title" });
      expect(yield* store.getThread(thread.id)).toMatchObject({
        title: "Agent title",
        agentNamed: true,
      });

      yield* runtimes.updateThread(thread.id, (t) => ({ ...t, title: "Mine", userNamed: true }));
      expect(yield* runTool(thread.id, "set_title", { title: "Agent again" })).toEqual({
        title: "Mine",
        applied: false,
      });
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("set_plan keeps the agent's plan, and the steps the user edited, across reloads", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const plans = yield* ThreadPlans;
      const thread = yield* createThread;
      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/api", number: 235, monitor: false },
      }));
      expect(
        yield* runTool(thread.id, "set_plan", {
          goal: "Codex effort on the gateway",
          steps: [
            { text: "Drop none effort on gpt-6.1-sol", status: "done" },
            { text: "No hosted web search", status: "doing", pr: 235 },
            { text: "Merge #235", status: "todo" },
          ],
        }),
      ).toEqual({
        goal: "Codex effort on the gateway",
        steps: [
          { text: "Drop none effort on gpt-6.1-sol", status: "done" },
          { text: "No hosted web search", status: "doing" },
          { text: "Merge #235", status: "todo" },
        ],
        progress: "1 of 3",
      });
      const saved = (yield* plans.get(thread.id))!;
      expect(saved).toMatchObject({
        updatedBy: "agent",
        goalBy: "agent",
        steps: [
          { source: "agent", locked: true },
          { pr: { number: 235, repo: "acme/api" } },
          { status: "todo" },
        ],
      });

      // The user ticks off the second step and rewords the last; the agent's next plan repeats the
      // one and leaves out the other, and both stay the user's.
      const [first, second, third] = saved.steps;
      yield* plans.edit(thread.id, {
        goal: saved.goal,
        steps: [
          { id: first!.id, text: first!.text, status: first!.status },
          { id: second!.id, text: second!.text, status: "done" },
          { id: third!.id, text: "Merge #235 after jordan's review", status: "todo" },
        ],
      });
      yield* runTool(thread.id, "set_plan", {
        steps: [
          { text: "Drop none effort on gpt-6.1-sol", status: "done" },
          { text: "No hosted web search", status: "done" },
        ],
      });
      const [summary] = (yield* runtimes.snapshot).filter((t) => t.thread.id === thread.id);
      expect(summary?.plan?.steps.map((step) => [step.id, step.text, step.source])).toEqual([
        [first!.id, "Drop none effort on gpt-6.1-sol", "agent"],
        [second!.id, "No hosted web search", "user"],
        [third!.id, "Merge #235 after jordan's review", "user"],
      ]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("spawn_task persists a task chip that dismiss_task withdraws", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* createThread;
      const { taskId } = (yield* runTool(thread.id, "spawn_task", {
        title: "Update docs",
        prompt: "Update the README",
      })) as { taskId: TaskId };

      expect((yield* store.getTask(thread.id, taskId)).task.status).toBe("offered");
      const { messages } = yield* runtimes.replay(thread.id);
      expect(messages.flatMap((m) => m.parts)).toMatchObject([
        { type: "data-task-chip", id: taskId, data: { title: "Update docs", status: "offered" } },
      ]);

      yield* runTool(thread.id, "dismiss_task", { taskId });
      expect((yield* store.getTask(thread.id, taskId)).task.status).toBe("dismissed");
      const error = yield* runTool(thread.id, "dismiss_task", { taskId: "nope" }).pipe(Effect.flip);
      expect(error.message).toBe("unknown task nope");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("spawn_task asks an orchestrator for a reason, and puts it on the chip", () =>
    Effect.gen(function* () {
      const registry = yield* AppToolRegistry;
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const thread = yield* createThread;
      let audience: "plain" | "orchestrator" | "worker" = "orchestrator";
      yield* runtimes.setSessionPolicy({
        forThread: () => Effect.succeed({ audience, outwardGate: undefined }),
      });
      const offer = { title: "Tidy the notes", prompt: "Tidy my notes repo" };
      // Whichever binding the session still holds, the caller's audience now decides.
      for (const bound of ["orchestrator", "plain"] as const) {
        for (const reason of [undefined, "  "]) {
          const refused = yield* runTool(
            thread.id,
            "spawn_task",
            reason === undefined ? offer : { ...offer, reason },
            bound,
          ).pipe(Effect.flip);
          expect(refused.message).toBe(SPAWN_TASK_NEEDS_REASON);
        }
      }

      const { taskId } = (yield* runTool(
        thread.id,
        "spawn_task",
        { ...offer, reason: " Unrelated to the workspace " },
        "orchestrator",
      )) as { taskId: TaskId };
      expect((yield* store.getTask(thread.id, taskId)).task).toMatchObject({
        status: "offered",
        reason: "Unrelated to the workspace",
      });
      // A plain thread or a worker offers one as before, with nothing to say.
      for (const now of ["plain", "worker"] as const) {
        audience = now;
        yield* runTool(thread.id, "spawn_task", offer, now);
        yield* runTool(thread.id, "spawn_task", offer, "orchestrator");
      }

      const described = (bound: "plain" | "orchestrator" | "worker") =>
        registry
          .forThread(thread.id, bound)
          .filter((t) => t.descriptor.name === "spawn_task")
          .map((t) => t.descriptor.description);
      expect(described("orchestrator")).toEqual([
        expect.stringContaining("`spawn_worker` instead"),
      ]);
      for (const bound of ["plain", "worker"] as const) {
        expect(described(bound)).toEqual([expect.not.stringContaining("spawn_worker")]);
      }
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "wait_on_user anchors an item to the reply, updates it in place, and caps the open",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const store = yield* ThreadStore;
        const thread = yield* createThread;
        const waitsOf = Effect.map(
          runtimes.snapshot,
          (all) => all.find((s) => s.thread.id === thread.id)?.waits ?? [],
        );
        const { id, open } = (yield* runTool(thread.id, "wait_on_user", {
          kind: "draft",
          title: "Teams message to Kari\u202e: rollout",
          copy: "Hi Kari,\n\nThe headers ship on Thursday.",
        })) as { id: WaitId; open: number };
        expect(open).toBe(1);
        const [item] = yield* waitsOf;
        expect(item).toMatchObject({ id, kind: "draft", title: "Teams message to Kari: rollout" });
        const { messages } = yield* runtimes.replay(thread.id);
        expect(messages.find((m) => m.id === item?.messageId)?.parts).toMatchObject([
          {
            type: "data-wait",
            id,
            data: { title: "Teams message to Kari: rollout", state: "open" },
          },
        ]);

        // An update keeps the item, its age and its place in the count.
        const updated = (yield* runTool(thread.id, "wait_on_user", {
          kind: "draft",
          title: "Teams message to Kari, revised",
          id,
        })) as { id: WaitId; open: number };
        expect(updated).toEqual({ id, open: 1 });
        expect(yield* waitsOf).toMatchObject([
          { id, title: "Teams message to Kari, revised", createdAt: item?.createdAt },
        ]);
        const unknown = yield* runTool(thread.id, "wait_on_user", {
          kind: "draft",
          title: "x",
          id: "w-nope",
        }).pipe(Effect.flip);
        expect(unknown.message).toContain("no open item w-nope");

        const link = yield* runTool(thread.id, "wait_on_user", {
          kind: "review",
          title: "Look",
          link: "javascript:alert(1)",
        }).pipe(Effect.flip);
        expect(link.message).toBe("link must be an http(s) URL");

        for (let n = 1; n < MAX_OPEN_WAITS; n++) {
          yield* runTool(thread.id, "wait_on_user", { kind: "action", title: `Step ${n}` });
        }
        const full = yield* runTool(thread.id, "wait_on_user", {
          kind: "action",
          title: "One too many",
        }).pipe(Effect.flip);
        expect(full.message).toContain("resolve_wait");
        expect(yield* store.listWaits(thread.id)).toHaveLength(MAX_OPEN_WAITS);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("resolve_wait closes an item, and says when the user got there first", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const waits = yield* ThreadWaits;
      const thread = yield* createThread;
      const add = (title: string) =>
        runTool(thread.id, "wait_on_user", { kind: "action", title }).pipe(
          Effect.map((r) => (r as { id: WaitId }).id),
        );
      const first = yield* add("Run assume example-prod");
      const second = yield* add("Approve in the portal");

      expect(yield* runTool(thread.id, "resolve_wait", { id: first, note: "done" })).toEqual({
        id: first,
        resolvedBy: "agent",
      });
      yield* waits.resolve(thread.id, second, { by: "user", at: Date.now() });
      expect(yield* runTool(thread.id, "resolve_wait", { id: second })).toEqual({
        id: second,
        resolvedBy: "user",
      });
      const missing = yield* runTool(thread.id, "resolve_wait", { id: "w-nope" }).pipe(Effect.flip);
      expect(missing.message).toBe("unknown item w-nope");

      expect(yield* store.listWaits(thread.id)).toEqual([]);
      expect(yield* store.listWaits(thread.id, "all")).toMatchObject([
        { id: first, resolvedBy: "agent", note: "done" },
        { id: second, resolvedBy: "user" },
      ]);
      const { messages } = yield* runtimes.replay(thread.id);
      expect(messages.flatMap((m) => m.parts).filter((p) => p.type === "data-wait")).toMatchObject([
        { id: first, data: { state: "done", resolvedBy: "agent" } },
        { id: second, data: { state: "done", resolvedBy: "user" } },
      ]);

      // Undo reopens it as it was.
      const { item, changed } = yield* waits.resolve(thread.id, second, undefined);
      expect(changed).toBe(true);
      expect(item.resolvedAt).toBeUndefined();
      expect((yield* store.listWaits(thread.id)).map((w) => w.id)).toEqual([second]);

      // Undo can't take a thread past the cap that adding keeps.
      for (let n = 1; n < MAX_OPEN_WAITS; n++) yield* add(`Step ${n}`);
      const refused = yield* waits.resolve(thread.id, first, undefined).pipe(Effect.flip);
      expect(refused._tag).toBe("WaitsFull");
      expect(yield* store.listWaits(thread.id)).toHaveLength(MAX_OPEN_WAITS);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("the user's next message tells the agent what they changed there, once", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const store = yield* ThreadStore;
      const waits = yield* ThreadWaits;
      const fake = yield* FakeAgentControl;
      const thread = yield* createThread;
      const add = (title: string) =>
        runTool(thread.id, "wait_on_user", { kind: "draft", title }).pipe(
          Effect.map((r) => (r as { id: WaitId }).id),
        );
      const sent = yield* add("Teams message to Kari");
      const review = yield* add("example/api#431");
      yield* waits.resolve(thread.id, sent, { by: "user", at: later() });
      const anchor = (yield* store.getWait(thread.id, review)).messageId!;
      const { item: mine } = yield* waits.put(
        thread.id,
        { kind: "action", title: "Run assume", anchor },
        "user",
      );
      expect(mine).toMatchObject({ source: "user", messageId: anchor });
      // Its chip lands in the message it was added from.
      const anchored = (yield* store.getMessage(thread.id, anchor))!.parts;
      expect(anchored.filter((p) => p.type === "data-wait").map((p) => p.id)).toContain(mine.id);

      yield* runtimes.send(thread.id, { text: "hi", waitNote: "forged" });
      const session = yield* waitFor(
        "the first send",
        fake.latest(thread.id).pipe(Effect.map((s) => s.sent.length === 1 && s)),
      );
      const note =
        "<gram-note>" +
        `The user marked done: "Teams message to Kari" (${sent}). ` +
        `The user added to Waiting on you, to act on themselves: "Run assume" (${mine.id}). ` +
        `Still waiting: "example/api#431" (${review}).` +
        "</gram-note>";
      expect(session.sent[0]).toEqual({ text: `hi\n\n${note}`, waitNote: note });
      const { messages } = yield* runtimes.replay(thread.id);
      expect(messages.find((m) => m.role === "user")?.parts).toEqual([
        { type: "text", text: "hi" },
        { type: "data-wait-note", id: expect.any(String), data: { text: note } },
      ]);

      // A turn the agent rejects took nothing: the next message tells it again.
      yield* session.emit(
        { type: "turnEnd", reason: "error", error: "overloaded" },
        { type: "status", status: "idle" },
      );
      yield* waitFor(
        "the rejected turn's end",
        runtimes.status(thread.id).pipe(Effect.map((status) => status !== "running")),
      );
      yield* runtimes.send(thread.id, { text: "retry" });
      yield* waitFor(
        "the retry",
        Effect.sync(() => session.sent.length === 2),
      );
      expect(session.sent[1]).toEqual({ text: `retry\n\n${note}`, waitNote: note });
      // A steer into that turn adds only what is newer, and is heard with it; one the agent
      // rejects told nothing, so the next carries it again.
      const { item: steered } = yield* waits.put(
        thread.id,
        { kind: "action", title: "Approve it", anchor },
        "user",
      );
      yield* fake.setSteerFails(true);
      yield* runtimes.steer(thread.id, { text: "lost" }).pipe(Effect.exit);
      yield* fake.setSteerFails(false);
      yield* runtimes.steer(thread.id, { text: "and this" });
      expect(session.steered.at(-1)?.waitNote).toBe(
        "<gram-note>" +
          `The user added to Waiting on you, to act on themselves: "Approve it" (${steered.id}). ` +
          `Still waiting: "example/api#431" (${review}), "Run assume" (${mine.id}).` +
          "</gram-note>",
      );

      // Heard once; a Done the user takes back before the agent heard of it is no news either.
      yield* session.completeTurn();
      yield* waits.resolve(thread.id, review, { by: "user", at: later() });
      yield* waits.resolve(thread.id, review, undefined);
      yield* runtimes.send(thread.id, { text: "again" });
      yield* waitFor(
        "the second send",
        Effect.sync(() => session.sent.length === 3),
      );
      expect(session.sent[2]).toEqual({ text: "again" });

      // A slash command goes as typed, and the note waits for the next message.
      yield* session.completeTurn();
      yield* waits.resolve(thread.id, review, { by: "user", at: later() });
      yield* runtimes.send(thread.id, { text: "/compact" });
      yield* waitFor(
        "the third send",
        Effect.sync(() => session.sent.length === 4),
      );
      expect(session.sent[3]).toEqual({ text: "/compact" });
      // Reopening what the agent heard was done is news, and listing tells it.
      yield* session.completeTurn();
      yield* waits.resolve(thread.id, sent, undefined);
      expect((yield* store.listWaitNews(thread.id)).map((w) => w.id)).toEqual([sent, review]);
      const listed = (yield* runTool(thread.id, "list_waits", { state: "all" })) as {
        waits: ReadonlyArray<unknown>;
      };
      expect(listed.waits).toEqual([
        expect.objectContaining({ id: sent, state: "open", source: "agent", age: "0m" }),
        expect.objectContaining({ id: review, state: "done", resolvedBy: "user" }),
        expect.objectContaining({ id: mine.id, state: "open", source: "user" }),
        expect.objectContaining({ id: steered.id, state: "open", source: "user" }),
      ]);
      expect(yield* store.listWaitNews(thread.id)).toEqual([]);
      expect([
        waitAge(0, 59 * 60_000),
        waitAge(0, 3 * 3_600_000),
        waitAge(0, 50 * 3_600_000),
      ]).toEqual(["59m", "3h", "2d"]);

      // A Done the user takes back after the agent was sent it, but before it took the message,
      // is news again: it heard of a Done that no longer holds.
      yield* waits.resolve(thread.id, sent, { by: "user", at: later() });
      yield* runtimes.send(thread.id, { text: "done it" });
      yield* waitFor(
        "the fifth send",
        Effect.sync(() => session.sent.length === 5),
      );
      expect(session.sent[4]?.waitNote).toContain(`The user marked done: "Teams message to Kari"`);
      yield* waits.resolve(thread.id, sent, undefined);
      yield* session.completeTurn();
      yield* waitStatusIdle(thread.id);
      expect((yield* store.listWaitNews(thread.id)).map((w) => w.id)).toEqual([sent]);
      yield* runtimes.send(thread.id, { text: "next" });
      yield* waitFor(
        "the sixth send",
        Effect.sync(() => session.sent.length === 6),
      );
      expect(session.sent[5]?.waitNote).toContain(`The user reopened: "Teams message to Kari"`);

      // A helper's suggestion stays out of the note until the user keeps it, and lists nowhere.
      yield* session.completeTurn();
      yield* waitStatusIdle(thread.id);
      yield* waits.heard(thread.id, yield* store.listWaitNews(thread.id));
      expect(
        yield* waits.suggest(thread.id, { kind: "draft", title: "Suggested reply" }, anchor),
      ).toBe(true);
      const suggestion = (yield* store.listWaits(thread.id)).find((w) => w.suggested === true)!;
      expect(yield* waits.draftNote(thread.id, [])).toBeUndefined();
      expect(
        (
          (yield* runTool(thread.id, "list_waits", {})) as { waits: ReadonlyArray<{ id: string }> }
        ).waits.map((w) => w.id),
      ).not.toContain(suggestion.id);
      yield* waits.keep(thread.id, suggestion.id);
      expect((yield* waits.draftNote(thread.id, []))?.note).toContain(
        `The user added to Waiting on you, to act on themselves: "Suggested reply"`,
      );
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("wait_on_user sends an orchestrator's decision to ask_user", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* createThread;
      yield* runtimes.setSessionPolicy({
        forThread: () => Effect.succeed({ audience: "orchestrator", outwardGate: undefined }),
      });
      const decision = { kind: "decision", title: "Merge api first?" };
      const refused = yield* runTool(thread.id, "wait_on_user", decision, "orchestrator").pipe(
        Effect.flip,
      );
      expect(refused.message).toBe(WAIT_DECISION_NEEDS_ASK_USER);
      yield* runTool(thread.id, "wait_on_user", { ...decision, kind: "draft" }, "orchestrator");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("mark_completed and set_unread update the thread flags", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const thread = yield* createThread;
      yield* runTool(thread.id, "mark_completed", { summary: "ready for review" });
      yield* runTool(thread.id, "set_unread", {});
      const updated = yield* store.getThread(thread.id);
      expect(updated.completedAt).toBeTypeOf("number");
      expect(updated.unread).toBe(true);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
