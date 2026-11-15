import { describe, expect, it } from "@effect/vitest";
import { AgentUnavailable, type Thread, type HostId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { makeAccountScopes } from "./account-scopes.ts";
import { accountOf, machineAccountScope } from "./limit-wait.ts";
import { AgentHosts } from "./agent-hosts.ts";
import type { AgentHost } from "@gram/agents";

const thread = (id: string, machine = "local", wait?: string) =>
  ({
    id,
    model: { agent: "claude", model: "opus" },
    checkout: {
      kind: "main",
      path: "/work/repo",
      ...(machine === "local" ? {} : { hostId: machine as HostId }),
    },
    ...(wait === undefined ? {} : { limitWait: { account: wait, kind: "limit", since: 1 } }),
  }) as Thread;
const unavailable = AgentHosts.of({
  get: () =>
    Effect.fail(
      new AgentUnavailable({
        agent: "claude",
        reason: "auth-status-failed",
        message: "synthetic probe failure",
      }),
    ),
});

describe("last known account scopes", () => {
  it.effect.each(["host-failed", "unsupported", "probe-failed", "unknown"] as const)(
    "isolates unidentified joined scopes from other machines and local legacy recovery: %s",
    (state) =>
      Effect.gen(function* () {
        const error = new AgentUnavailable({
          agent: "claude",
          reason: "auth-status-failed",
          message: "synthetic probe failure",
        });
        const host: AgentHost = {
          kind: "claude",
          capabilities: {
            fork: false,
            rewind: "none",
            steer: false,
            planMode: false,
            approvalScopes: [],
            userQuestions: false,
            costReporting: false,
            perTurnModel: false,
            reasoningEffort: false,
            listSessions: false,
            subagentStreams: false,
            stopTasks: false,
          },
          open: () => Effect.die(new Error("The account probe must not open a session.")),
          listModels: () => Effect.succeed([]),
          ...(state === "unsupported"
            ? {}
            : {
                readAccountScope:
                  state === "unknown" ? Effect.succeed(undefined) : Effect.fail(error),
              }),
        };
        const hosts = AgentHosts.of({
          get: () => (state === "host-failed" ? Effect.fail(error) : Effect.succeed(host)),
        });
        const scopes = makeAccountScopes(
          hosts,
          [thread("legacy", "local", "claude/")],
          machineAccountScope,
          () => Effect.succeed(hosts),
        );
        const x = yield* scopes.quotaFor(thread("x", "joined-x"));
        const y = yield* scopes.quotaFor(thread("y", "joined-y"));
        const local = yield* scopes.quotaFor(thread("local"));
        expect(x).toBe(
          accountOf({ agent: "claude", accountScope: machineAccountScope("joined-x", "unknown") }),
        );
        expect(y).toBe(
          accountOf({ agent: "claude", accountScope: machineAccountScope("joined-y", "unknown") }),
        );
        expect(x).not.toBe(y);
        expect(x).not.toBe(local);
        expect(local).toBe("claude/");
        expect(yield* scopes.changed(thread("x", "joined-x"), x)).toBe(false);
      }),
  );
  it.effect(
    "retains a persisted login during a failed probe, including for a newly spawned sibling",
    () =>
      Effect.gen(function* () {
        const scope = machineAccountScope("local", "known-login");
        const account = accountOf({ agent: "claude", accountScope: scope });
        const old = thread("old", "local", account);
        const scopes = makeAccountScopes(unavailable, [old], machineAccountScope);
        expect(yield* scopes.quotaFor(old)).toBe(account);
        expect(yield* scopes.quotaFor(thread("new"))).toBe(account);
        expect(yield* scopes.changed(old, account)).toBe(false);
      }),
  );

  it.effect(
    "shares a joined login once identity metadata is available, without inheriting local or legacy limits",
    () =>
      Effect.gen(function* () {
        const remote = thread("remote", "joined");
        const sibling = thread("sibling", "joined");
        const scopes = makeAccountScopes(
          unavailable,
          [thread("legacy", "joined", "claude/")],
          machineAccountScope,
        );
        expect(yield* scopes.quotaFor(remote)).not.toBe("claude/");
        const scope = scopes.remember(remote, "login-a", undefined);
        const account = accountOf({ agent: "claude", accountScope: scope });
        expect(yield* scopes.quotaFor(sibling)).toBe(account);
        expect(yield* scopes.quotaFor(thread("local"))).not.toBe(account);
        const next = scopes.remember(sibling, "login-b", scope);
        // Repeated identity metadata from the old process must not undo a newer session's login.
        scopes.remember(remote, "login-a", scope);
        expect(yield* scopes.scopeFor(thread("third", "joined"))).toBe(next);
      }),
  );
});
