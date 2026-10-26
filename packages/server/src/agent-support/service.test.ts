import { describe, expect, it } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import {
  featurePreflight,
  type LaunchChecks,
  type ProfileId,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { LaunchChecksCache } from "../launch-checks/handler.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { RuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { agentSupportHandlers } from "./handler.ts";
import { makeAgentSupport } from "./service.ts";

const signedIn: LaunchChecks = {
  checkedAt: 7,
  tools: [
    { tool: "claude", found: true, version: "2.1.296" },
    { tool: "codex", found: true, version: "0.162.1" },
  ],
  claudeSignIn: "signedIn",
  codexSignIn: "signedIn",
  ghSignedIn: false,
};
const forbidden = () => Effect.die("passive preflight crossed a provider boundary");

describe("selected harness read-only service", () => {
  it.effect(
    "serves the real RPC handler without sessions, models, config reload or helper generation",
    () =>
      Effect.gen(function* () {
        const base = yield* (yield* AgentHosts).get("claude");
        const host: AgentHost = {
          ...base,
          kind: "codex",
          open: forbidden,
          listModels: forbidden,
          reloadConfig: forbidden,
          helper: { models: forbidden(), generate: forbidden },
        };
        const cacheReads: boolean[] = [];
        let currentChecks = signedIn;
        const handlers = yield* agentSupportHandlers.pipe(
          Effect.provide(Layer.succeed(AgentHosts, AgentHosts.fromHosts([host]))),
          Effect.provide(
            Layer.succeed(LaunchChecksCache, {
              get: (refresh) =>
                Effect.sync(() => {
                  cacheReads.push(refresh);
                  return currentChecks;
                }),
            }),
          ),
        );
        const store = yield* ThreadStore;
        const before = yield* store.listThreads;
        const result = yield* handlers["agents.support"]({
          model: { agent: "codex", model: "invented-model" },
        });
        expect(result.availability).toEqual({ state: "available" });
        expect(result.version).toBe("0.162.1");
        expect(result.support.dream?.state).toBe("supported");
        expect(result.support.dreamGuided?.state).toBe("supported");
        expect(result.support.dreamFiles?.state).toBe("unsupported");
        expect(result.dreamMode).toBe("guided");
        expect(result.dreamReason).toContain("normal Codex permissions");
        expect(result.dreamReason).toContain("workspace-write sandbox and on-request approvals");
        expect(result.support.imageInput?.state).toBe("unknown");
        expect(yield* store.listThreads).toEqual(before);
        expect(cacheReads).toEqual([false]);
        yield* handlers["agents.support"]({ model: result.model, refresh: true });
        expect(cacheReads).toEqual([false, true]);
        for (const version of [undefined, "0.160.0", "0.163.0"]) {
          currentChecks = {
            ...signedIn,
            tools: [{ tool: "codex", found: true, ...(version === undefined ? {} : { version }) }],
          };
          const unqualified = yield* handlers["agents.support"]({ model: result.model });
          expect(unqualified.support.dream?.state).toBe("unknown");
          expect(unqualified.support.dreamGuided?.state).toBe("unknown");
          expect(unqualified.dreamMode).toBeUndefined();
          expect(
            featurePreflight({
              feature: "session",
              support: unqualified.support,
              availability: unqualified.availability,
            }).blocked,
          ).toBe(false);
        }
        expect(yield* store.listThreads).toEqual(before);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("keeps gateway and subscription auth independent without fetching gateway models", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const id = "synthetic-profile" as ProfileId;
      yield* store.upsertProfile({
        id,
        name: "Synthetic",
        baseURL: "https://gateway.example.test/v1",
        keyRef: "synthetic-reference",
        models: [],
      });
      const base = yield* (yield* AgentHosts).get("claude");
      const service = makeAgentSupport({
        hosts: AgentHosts.fromHosts([{ ...base, kind: "codex" }]),
        store,
        checks: { get: () => Effect.succeed({ ...signedIn, codexSignIn: "notSignedIn" }) },
      });
      const local = yield* service.read({ model: { agent: "codex", model: "test" } });
      expect(local.availability.state).toBe("signedOut");
      const gateway = yield* service.read({
        model: { agent: "codex", model: "test", profileId: id },
      });
      expect(gateway.availability.state).toBe("unknown");
      expect(gateway.availability).not.toEqual(local.availability);
      yield* store.upsertProfile({
        id,
        name: "Synthetic",
        baseURL: "https://gateway.example.test/v1",
        keyRef: "",
        models: [],
      });
      expect((yield* service.read({ model: gateway.model })).availability.state).toBe("missing");
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "uses selected managed version evidence instead of another CLI on PATH or its auth",
    () =>
      Effect.gen(function* () {
        const hosts = yield* AgentHosts;
        const base = yield* hosts.get("claude");
        const service = makeAgentSupport({
          hosts: AgentHosts.fromHosts([{ ...base, kind: "codex" }]),
          store: yield* ThreadStore,
          checks: { get: () => Effect.succeed({ ...signedIn, codexSignIn: "notSignedIn" }) },
          managed: {
            source: () => Effect.succeed("managed"),
            active: () =>
              Effect.succeed({
                id: "synthetic",
                version: "0.160.0",
                channel: "stable",
                sha256: "synthetic",
                path: "/synthetic/codex",
                installedAt: 0,
              }),
          },
        });
        const result = yield* service.read({ model: { agent: "codex", model: "test" } });
        expect(result.version).toBe("0.160.0");
        expect(result.support.dream).toMatchObject({
          state: "unknown",
          reason: expect.stringContaining("installed CLI 0.160.0 has not been qualified"),
        });
        expect(result.availability.state).toBe("unknown");
        expect(
          featurePreflight({
            feature: "dream",
            support: result.support,
            availability: result.availability,
            requireVerified: true,
          }).blocked,
        ).toBe(true);
        expect(
          featurePreflight({
            feature: "session",
            support: result.support,
            availability: result.availability,
          }).blocked,
        ).toBe(false);
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("distinguishes missing, unusable and unknown status without creating a thread", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const hosts = yield* AgentHosts;
      for (const [checks, state] of [
        [{ ...signedIn, tools: [{ tool: "claude" as const, found: false }] }, "missing"],
        [
          {
            ...signedIn,
            tools: [
              {
                tool: "claude" as const,
                found: true,
                unusable: "Synthetic executable is temporarily unavailable",
              },
            ],
          },
          "temporarilyUnavailable",
        ],
        [{ ...signedIn, claudeSignIn: "unknown" as const }, "unknown"],
      ] as const) {
        const result = yield* makeAgentSupport({
          hosts,
          store,
          checks: { get: () => Effect.succeed(checks) },
        }).read({ model: { agent: "claude", model: "test" } });
        expect(result.availability.state).toBe(state);
      }
      expect(yield* store.listThreads).toEqual([]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect(
    "reports compaction from an actual started synthetic session, never another model",
    () =>
      Effect.gen(function* () {
        const runtimes = yield* ThreadRuntimes;
        const fake = yield* FakeAgentControl;
        const thread = yield* runtimes.create({
          projectRoot: "/synthetic/repo",
          checkout: { kind: "main", path: "/synthetic/repo" },
          model: { agent: "claude", model: "test" },
        });
        const session = yield* fake.latest(thread.id);
        expect(session.options.model?.model).toBe("test");
        yield* session.emit({
          type: "identity",
          agentSessionId: "synthetic-session",
          model: "test",
          tools: [],
          commands: [{ name: "compact", description: "Synthetic compact command" }],
        });
        yield* waitFor(
          "the real runtime's command listing",
          runtimes.snapshot.pipe(
            Effect.map((rows) =>
              rows
                .find((row) => row.thread.id === thread.id)
                ?.identity?.commands.some((command) => command.name === "compact"),
            ),
          ),
        );
        const handlers = yield* agentSupportHandlers.pipe(
          Effect.provide(Layer.succeed(LaunchChecksCache, { get: () => Effect.succeed(signedIn) })),
        );
        const result = yield* handlers["agents.support"]({
          model: thread.model,
          threadId: thread.id,
        });
        expect(result.support.compaction?.state).toBe("supported");
        const other = yield* handlers["agents.support"]({
          model: { agent: "claude", model: "other" },
          threadId: thread.id as ThreadId,
        });
        expect(other.support.compaction?.state).toBe("unknown");
      }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});
