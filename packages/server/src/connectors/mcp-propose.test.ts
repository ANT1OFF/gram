import { describe, expect, it } from "@effect/vitest";
import type { ToolAudience } from "@gram/agents";
import {
  AppToolError,
  McpServerProposalCard,
  type ApprovalRequest,
  type ConfiguredServer,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { AppToolRegistry } from "../app-tools/registry.ts";
import {
  makeWorld,
  openOrchestrator,
  serverLayer,
  settle,
  spawn,
  waitReal,
  waitStatus,
  type Server,
  type World,
} from "../orchestration/test-harness.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ConnectorConfigs } from "../rpc/handlers/connectors.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { McpCli, type McpCliShape } from "./mcp-cli.ts";
import { mcpProposeAppToolsLayer } from "./mcp-propose.ts";

const TOOL = "mcp_server_propose";

/** A `claude mcp` stand-in: records each call; `configured` is what Claude Code's config holds. */
const fakeCli = () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const configured: Array<ConfiguredServer> = [];
  const cli: McpCliShape = {
    configured: () => Effect.sync(() => [...configured]),
    run: (args) =>
      Effect.sync(() => {
        calls.push([...args]);
        return { status: 0, stdout: "", stderr: "" };
      }),
  };
  return { calls, configured, cli };
};

/** The orchestration world with the connectors' handlers and `mcp_server_propose` over it. */
const inMcp = <A, E>(
  body: (
    world: World,
    cli: ReturnType<typeof fakeCli>,
  ) => Effect.Effect<A, E, Server | ConnectorConfigs | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    const cli = fakeCli();
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = serverLayer(world);
        const configs = ConnectorConfigs.layer.pipe(
          Layer.provide(server),
          Layer.provide(Layer.succeed(McpCli, cli.cli)),
        );
        const context = yield* Layer.build(
          mcpProposeAppToolsLayer().pipe(Layer.provideMerge(configs), Layer.provideMerge(server)),
        );
        return yield* body(world, cli).pipe(Effect.provide(context));
      }),
    );
  });

const call = (threadId: ThreadId, audience: ToolAudience, input: unknown) =>
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const tool = registry.forTransport(threadId, audience).find((t) => t.descriptor.name === TOOL);
    if (tool === undefined) return yield* Effect.die(new Error(`${TOOL} isn't bound`));
    return yield* tool.run(input);
  });

const cardIn = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const [card] = yield* waitReal(
      "the MCP server card",
      store.listRequests(threadId).pipe(Effect.map((all) => all.length === 1 && all)),
    );
    return card as ApprovalRequest;
  });

const answer = (threadId: ThreadId, card: ApprovalRequest, decision: "allow" | "deny") =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    yield* runtimes.respond(threadId, card.id, { kind: "approval", decision, scope: "once" });
  });

const noCard = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* settle;
    expect(yield* store.listRequests(threadId)).toEqual([]);
  });

const plainThread = (world: World) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: world.repo,
      checkout: { kind: "main", path: world.repo },
      title: "The user's own thread",
    });
    yield* waitStatus(thread.id, "idle");
    return thread;
  });

const LOCAL = {
  name: "docs-index",
  server: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@example/docs-index-mcp", "--root", "/work/docs"],
    env: { LOG_LEVEL: "info" },
  },
  targets: ["claude", "codex"],
  reason: "You asked for search over the local docs.",
} as const;

const REMOTE = {
  name: "tracker",
  server: { type: "http", url: "https://mcp.example.invalid/tracker" },
  targets: ["claude"],
  reason: "You asked to read the tracker from threads.",
} as const;

const decodeCard = Schema.decodeUnknownSync(McpServerProposalCard);

describe("mcp_server_propose", () => {
  it.effect("is bound for orchestrators, workers and plain threads, never memory updates", () =>
    inMcp(() =>
      Effect.gen(function* () {
        const registry = yield* AppToolRegistry;
        const bound = (audience: ToolAudience) =>
          registry
            .forTransport("t" as ThreadId, audience)
            .some((tool) => tool.descriptor.name === TOOL);
        expect([bound("orchestrator"), bound("worker"), bound("plain"), bound("dream")]).toEqual([
          true,
          true,
          true,
          false,
        ]);
      }),
    ),
  );

  it.effect("writes nothing when the user declines", () =>
    inMcp((world, cli) =>
      Effect.gen(function* () {
        const fake = yield* FakeAgentControl;
        const thread = yield* plainThread(world);
        const asked = yield* call(thread.id, "plain", LOCAL).pipe(Effect.flip, Effect.forkScoped);
        const card = yield* cardIn(thread.id);
        expect(card.scopes).toEqual(["once"]);
        expect(card.suggestions).toEqual([]);
        yield* answer(thread.id, card, "deny");
        const error = yield* Fiber.join(asked);
        expect(error).toBeInstanceOf(AppToolError);
        expect(error.message).toBe("The user declined the MCP server change; nothing changed.");
        expect(cli.calls).toEqual([]);
        expect(fake.mcpConfigCalls).toEqual([]);
      }),
    ),
  );

  it.effect("shows a local server whole, and on approval adds it through each CLI", () =>
    inMcp((world, cli) =>
      Effect.gen(function* () {
        const fake = yield* FakeAgentControl;
        const thread = yield* plainThread(world);
        const asked = yield* call(thread.id, "plain", LOCAL).pipe(Effect.forkScoped);
        const request = yield* cardIn(thread.id);
        const card = decodeCard(request.input);
        expect(card).toMatchObject({
          name: "docs-index",
          action: "add",
          transport: "stdio",
          commandLine: "npx -y @example/docs-index-mcp --root /work/docs",
          env: [{ name: "LOG_LEVEL", value: "info" }],
          scope: "user",
        });
        expect(card.targets.map((t) => t.label)).toEqual(["Claude Code", "Codex"]);
        expect(request.description).toBe(
          "Add the MCP server “docs-index”, a program run on this machine, in Claude Code and Codex.",
        );
        // Nothing is written while the card waits.
        expect(cli.calls).toEqual([]);
        yield* answer(thread.id, request, "allow");
        expect(yield* Fiber.join(asked)).toMatchObject({ applied: true, action: "add" });
        expect(cli.calls).toEqual([
          [
            "mcp",
            "add-json",
            "--scope",
            "user",
            "docs-index",
            JSON.stringify({
              type: "stdio",
              command: "npx",
              args: ["-y", "@example/docs-index-mcp", "--root", "/work/docs"],
              env: { LOG_LEVEL: "info" },
            }),
          ],
        ]);
        expect(fake.mcpConfigCalls).toEqual(["codex:add:user:docs-index"]);
      }),
    ),
  );

  it.effect("writes a project server to the caller's checkout, with sign-in steps", () =>
    inMcp((world, cli) =>
      Effect.gen(function* () {
        const thread = yield* plainThread(world);
        const asked = yield* call(thread.id, "plain", { ...REMOTE, scope: "project" }).pipe(
          Effect.forkScoped,
        );
        const request = yield* cardIn(thread.id);
        const card = decodeCard(request.input);
        expect(card).toMatchObject({
          transport: "http",
          url: "https://mcp.example.invalid/tracker",
          host: "mcp.example.invalid",
          scope: "project",
        });
        expect(card.targets[0]?.where).toContain(`${world.repo}/.mcp.json`);
        expect(card.notes?.[0]).toContain("/mcp and choose Authenticate");
        yield* answer(thread.id, request, "allow");
        const result = (yield* Fiber.join(asked)) as { readonly notes: ReadonlyArray<string> };
        expect(result.notes[0]).toContain("/mcp");
        expect(cli.calls).toEqual([
          [
            "mcp",
            "add-json",
            "--scope",
            "project",
            "tracker",
            JSON.stringify({ type: "http", url: "https://mcp.example.invalid/tracker" }),
          ],
        ]);
      }),
    ),
  );

  it.effect("refuses a taken name unless asked to replace it, then shows and replaces both", () =>
    inMcp((world, cli) =>
      Effect.gen(function* () {
        const fake = yield* FakeAgentControl;
        cli.configured.push({
          name: "docs-index",
          transport: "http",
          url: "https://old.example.invalid/mcp",
          scope: "user",
          carriesValues: true,
        });
        const thread = yield* plainThread(world);
        const refused = yield* call(thread.id, "plain", LOCAL).pipe(Effect.flip);
        expect(refused.message).toContain("Claude Code already has an MCP server named docs-index");
        expect(refused.message).toContain("replace: true");
        yield* noCard(thread.id);

        const asked = yield* call(thread.id, "plain", { ...LOCAL, replace: true }).pipe(
          Effect.forkScoped,
        );
        const request = yield* cardIn(thread.id);
        const card = decodeCard(request.input);
        expect(card.action).toBe("replace");
        expect(card.targets[0]?.replaces).toEqual({
          transport: "http",
          scope: "user",
          url: "https://old.example.invalid/mcp",
          carriesValues: true,
        });
        expect(card.targets[1]?.replaces).toBeUndefined();
        yield* answer(thread.id, request, "allow");
        expect(yield* Fiber.join(asked)).toMatchObject({ applied: true, action: "replace" });
        // Claude Code's add refuses a taken name, so the old one goes first.
        expect(cli.calls.map((args) => args.slice(0, 5))).toEqual([
          ["mcp", "remove", "--scope", "user", "docs-index"],
          ["mcp", "add-json", "--scope", "user", "docs-index"],
        ]);
        expect(fake.mcpConfigCalls).toEqual(["codex:add:user:docs-index"]);
      }),
    ),
  );

  it.effect("writes nothing when a server of the name appears while the card waits", () =>
    inMcp((world, cli) =>
      Effect.gen(function* () {
        const thread = yield* plainThread(world);
        const asked = yield* call(thread.id, "plain", LOCAL).pipe(Effect.flip, Effect.forkScoped);
        const request = yield* cardIn(thread.id);
        cli.configured.push({
          name: "docs-index",
          transport: "stdio",
          command: "other",
          scope: "user",
          carriesValues: false,
        });
        yield* answer(thread.id, request, "allow");
        const error = yield* Fiber.join(asked);
        expect(error.message).toContain("changed while it waited");
        expect(cli.calls).toEqual([]);
      }),
    ),
  );

  it.effect("withdraws the card when it expires and writes nothing", () =>
    inMcp((world, cli) =>
      Effect.gen(function* () {
        const thread = yield* plainThread(world);
        const asked = yield* call(thread.id, "plain", REMOTE).pipe(Effect.flip, Effect.forkScoped);
        yield* cardIn(thread.id);
        yield* TestClock.adjust("16 minutes");
        const error = yield* Fiber.join(asked);
        expect(error.message).toContain("The MCP server proposal expired");
        yield* noCard(thread.id);
        expect(cli.calls).toEqual([]);
      }),
    ),
  );

  it.effect("refuses credentials and Gram's own name before any card", () =>
    inMcp((world, cli) =>
      Effect.gen(function* () {
        const thread = yield* plainThread(world);
        for (const [input, said] of [
          [{ ...REMOTE, name: "gram" }, "Gram's own server"],
          [
            { ...REMOTE, server: { ...REMOTE.server, headers: { Authorization: "Bearer abc" } } },
            "Header Authorization looks like a credential",
          ],
          [
            { ...LOCAL, server: { ...LOCAL.server, env: { SERVICE_TOKEN: "x" } } },
            "Env var SERVICE_TOKEN looks like a credential",
          ],
          [{ ...LOCAL, targets: ["codex"], scope: "project" }, "Codex keeps MCP servers"],
        ] as const) {
          const refused = yield* call(thread.id, "plain", input).pipe(Effect.flip);
          expect(refused.message).toContain("Nothing was proposed.");
          expect(refused.message).toContain(said);
        }
        yield* noCard(thread.id);
        expect(cli.calls).toEqual([]);
      }),
    ),
  );

  it.effect("lets a worker propose, on a card in its own thread", () =>
    inMcp((world, cli) =>
      Effect.gen(function* () {
        const { session } = yield* openOrchestrator(world);
        const { thread: worker } = yield* spawn(session, { feature: "docs" });
        const asked = yield* call(worker.id, "worker", REMOTE).pipe(Effect.forkScoped);
        const request = yield* cardIn(worker.id);
        yield* answer(worker.id, request, "allow");
        expect(yield* Fiber.join(asked)).toMatchObject({ applied: true });
        expect(cli.calls).toHaveLength(1);
      }),
    ),
  );
});
