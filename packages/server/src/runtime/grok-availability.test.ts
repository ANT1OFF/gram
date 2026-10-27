import { describe, expect, it } from "@effect/vitest";
import { captureLogs } from "@gram/agents/testing/logs";
import { GrokHost, GrokHostLive, GROK_SUBSCRIPTION_BLOCKER } from "@gram/agents/grok";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "./agent-hosts.ts";
import { FakeAgentAdapter, FakeAgentControl } from "./fake-agent.ts";
import { makeRuntimeTestLayer, TEST_CONFIG, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

// Uses the public production host/layer and registry, not the unqualified test adapter.
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "gram-grok-unavailable-"));
  const home = join(root, "grok");
  const agents = Layer.effectContext(
    Effect.gen(function* () {
      const host = yield* GrokHost;
      const fake = yield* FakeAgentControl;
      return Context.make(AgentHosts, AgentHosts.fromHosts([host])).pipe(
        Context.add(FakeAgentControl, fake),
      );
    }),
  ).pipe(
    Layer.provide(
      Layer.merge(
        FakeAgentAdapter,
        GrokHostLive({ home, authPath: join(root, "synthetic-never-open.json") }),
      ),
    ),
  );
  return {
    root,
    home,
    layer: makeRuntimeTestLayer(undefined, undefined, { ...TEST_CONFIG, dataDir: root }, agents),
  };
};

describe("public Grok production registry never executes without route proof", () => {
  it.live.each(["default", "discovered", "resume", "restart"] as const)(
    "refuses %s with no auth, scoped config, child or provider fallback",
    (kind) =>
      Effect.acquireUseRelease(
        Effect.sync(fixture),
        (f) => {
          const logs = captureLogs();
          return Effect.gen(function* () {
            const hosts = yield* AgentHosts;
            const runtime = yield* ThreadRuntimes;
            const store = yield* ThreadStore;
            const fake = yield* FakeAgentControl;
            const host = yield* hosts.get("grok");
            expect((yield* host.listModels().pipe(Effect.flip)).message).toBe(
              GROK_SUBSCRIPTION_BLOCKER,
            );
            const model = { agent: "grok" as const, model: "synthetic-grok" };
            if (kind === "default") {
              yield* store.updateSettings((s) => ({
                ...s,
                agents: { ...s.agents, defaultModel: model },
              }));
            }
            const saved = kind === "resume" || kind === "restart";
            const thread = yield* runtime.create({
              projectRoot: f.root,
              checkout: { kind: "main", path: f.root },
              ...(kind === "default" ? {} : { model }),
              ...(saved ? { resumeSessionId: "11111111-1111-4111-8111-111111111111" } : {}),
              deferOpen: true,
            });
            if (kind === "restart") yield* runtime.restartSession(thread.id);
            else
              yield* runtime
                .send(thread.id, { text: "Synthetic forbidden public execution" })
                .pipe(Effect.result);
            yield* waitFor(
              "unavailable",
              runtime.status(thread.id).pipe(Effect.map((s) => s === "error")),
            );
            expect((yield* store.getThread(thread.id)).lastError?.text).toContain(
              "cannot enforce subscription-only inference routing",
            );
            if (saved)
              expect((yield* store.getThread(thread.id)).agentSessionId).toBe(
                "11111111-1111-4111-8111-111111111111",
              );
            expect(existsSync(f.home)).toBe(false);
            expect(fake.sessions).toEqual([]);
            // The refusal is logged once, with why, as any agent that can't start is.
            expect(logs.warnings()).toMatchObject([
              {
                message: "agent unavailable",
                annotations: {
                  threadId: thread.id,
                  agent: "grok",
                  unavailable: expect.stringContaining(
                    "cannot enforce subscription-only inference routing",
                  ),
                },
              },
            ]);
          }).pipe(Effect.provide(f.layer.pipe(Layer.provideMerge(logs.layer))));
        },
        (f) => Effect.sync(() => rmSync(f.root, { recursive: true, force: true })),
      ),
  );
});
