import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { describe, expect, it } from "@effect/vitest";
import { GatewayKeyProvider } from "@gram/agents";
import { CodexHost, CodexHostLive } from "@gram/agents/codex";
import { AgentUnavailable, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { McpRoute } from "../app-tools/http-mcp.ts";
import { mcpConnectionFor, McpTokens } from "../app-tools/mcp-tokens.ts";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { HttpRouter } from "../platform/unstable.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { FakeAgentAdapter } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { ThreadArchive, ThreadArchiverLive } from "./archive.ts";
import { DreamFiles } from "./dream-files.ts";
import { Dreams, makeDreamsLive } from "./dreams.ts";
import { OrchestrationMemory } from "./memory.ts";
import { makeWorld, openOrchestrator, serverLayer, waitReal } from "./test-harness.ts";

// Production Codex transport + runtime + bounded registry over invented local child stdio.
// Its account/configuration live only in makeWorld's temporary directory; no provider calls.
describe.skipIf(!hasGit || process.platform === "win32")(
  "Codex Dream synthetic subscription protocol",
  () => {
    it.live("runs all six bounded operations with normal permissions and requires Adopt", () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const bin = join(world.dir, "bin");
        mkdirSync(bin);
        symlinkSync(process.execPath, join(bin, "node"));
        const binary = join(bin, "codex");
        const authPath = join(world.dir, "synthetic-subscription-login");
        writeFileSync(authPath, "Invented local subscription login marker.\n");
        const shell = join(world.dir, "shell-fixture");
        const logPath = join(world.dir, "codex-protocol.jsonl");
        const source = readFileSync(
          new URL("../../../agents/fixtures/subscriptions/codex-cli.cjs", import.meta.url),
          "utf8",
        );
        writeFileSync(binary, `#!${process.execPath}\n${source}`);
        chmodSync(binary, 0o755);
        writeFileSync(logPath, "");
        const env = {
          PATH: bin,
          HOME: world.dir,
          CODEX_HOME: world.dir,
          GRAM_FIXTURE_AUTH: authPath,
          GRAM_FIXTURE_SUBSCRIPTION_ONLY: "1",
          GRAM_FIXTURE_LOG: logPath,
          GRAM_FIXTURE_SIGNED_OUT: join(world.dir, "signed-out"),
          GRAM_FIXTURE_FAIL_START: join(world.dir, "fail-start"),
        };
        expect(readdirSync(bin).toSorted()).toEqual(["codex", "node"]);
        const probe = `\0__SB_PROBE__\0${binary}\n\0__SB_ENV__\0${Object.entries(env)
          .map(([key, value]) => `${key}=${value}\0`)
          .join("")}`;
        writeFileSync(
          shell,
          `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(probe)});`,
        );
        chmodSync(shell, 0o755);
        const keys = Layer.succeed(GatewayKeyProvider)({
          credentials: () =>
            Effect.fail(
              new AgentUnavailable({
                agent: "codex",
                message: "No gateway in this subscription fixture.",
              }),
            ),
        });
        const codex = CodexHostLive({
          servers: { binaryPath: binary, shell, startupTimeoutMs: 2000 },
        }).pipe(Layer.provide(keys));
        const agents = Layer.effect(
          AgentHosts,
          Effect.gen(function* () {
            const fallback = yield* AgentHosts;
            const host = yield* CodexHost;
            return AgentHosts.of({
              get: (kind) => (kind === "codex" ? Effect.succeed(host) : fallback.get(kind)),
            });
          }),
        ).pipe(Layer.provideMerge(FakeAgentAdapter), Layer.provide(codex), Layer.orDie);
        const transport = Layer.mergeAll(
          McpTokens.layer,
          NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
        );
        const memoryRoot = join(world.dir, "memory");
        const dreams = Layer.mergeAll(
          makeDreamsLive({ claudeConfigDirs: [] }),
          ThreadArchiverLive,
        ).pipe(
          Layer.provideMerge(
            Layer.mergeAll(DreamFiles.layerAt(memoryRoot), ThreadArchive.layerAt(memoryRoot)),
          ),
          Layer.provideMerge(serverLayer(world, {}, agents).pipe(Layer.provideMerge(transport))),
        );
        const server = HttpRouter.serve(McpRoute, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.provideMerge(dreams));
        yield* Effect.gen(function* () {
          const { workspaceId } = yield* openOrchestrator(world);
          const service = yield* Dreams;
          const memory = yield* OrchestrationMemory;
          const original = yield* memory.read(workspaceId, "MEMORY.md");
          const dream = yield* service.start({
            workspaceId,
            kind: "dream",
            model: { agent: "codex", model: "fixture-small", variant: "high" },
          });
          const store = yield* ThreadStore;
          const approval = yield* waitReal(
            "native Codex permission request",
            store
              .listRequests(dream.threadId as ThreadId)
              .pipe(
                Effect.map((requests) => requests.find((request) => request.kind === "approval")),
              ),
          );
          expect(approval.kind).toBe("approval");
          yield* (yield* ThreadRuntimes).respond(dream.threadId as ThreadId, approval.id, {
            kind: "approval",
            decision: "deny",
            scope: "once",
          });
          yield* waitReal(
            "synthetic Codex Dream completion",
            store.getDream(dream.id).pipe(Effect.map((row) => row.status !== "running" && row)),
          );
          const row = yield* store.getDream(dream.id);
          expect(row.status).toBe("completed");
          expect(row.filesClosedAt).toBeDefined();
          const review = yield* service.review(dream.id);
          expect(review.report).toContain("# New, with sources");
          expect(yield* memory.read(workspaceId, "MEMORY.md")).toBe(original);
          const log = readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { msg: Record<string, unknown> });
          expect(log.find(({ msg }) => msg["dreamToolNames"])?.msg["dreamToolNames"]).toEqual([
            "dream_delete",
            "dream_edit",
            "dream_list",
            "dream_read",
            "dream_search",
            "dream_write",
          ]);
          expect(log.some(({ msg }) => msg["dreamFailure"])).toBe(false);
          expect(
            log.some(
              ({ msg }) =>
                (msg["result"] as { decision?: string } | undefined)?.decision === "decline",
            ),
          ).toBe(true);
          const start = log.find(({ msg }) => msg["method"] === "thread/start")?.msg["params"];
          expect(start).toMatchObject({
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            developerInstructions: expect.stringContaining("normal Codex permissions"),
            config: {
              features: { plugins: false, apps: false },
              mcp_servers: { alpha: { enabled: false }, gram: { enabled: true } },
            },
          });
          expect(start).not.toHaveProperty("environments");
          const connection = yield* mcpConnectionFor(dream.threadId as ThreadId);
          const closed = yield* Effect.promise(() =>
            fetch(connection.url, {
              method: "POST",
              headers: {
                ...connection.headers,
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 50,
                method: "tools/call",
                params: { name: "dream_read", arguments: { path: "input/memory/MEMORY.md" } },
              }),
            }).then((response) => response.json()),
          );
          expect(closed).toMatchObject({ result: { isError: true } });
          yield* service.adopt(dream.id, {
            basedOn: review.memoryVersion,
            outputDigest: review.outputDigest,
          });
          expect(yield* memory.read(workspaceId, "MEMORY.md")).toContain(
            "candidate from synthetic session",
          );
          yield* (yield* ThreadRuntimes).close(dream.threadId as ThreadId);
        }).pipe(Effect.provide(server), Effect.scoped);
      }).pipe(Effect.scoped),
    );
  },
);
