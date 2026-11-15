import { describe, expect, it } from "@effect/vitest";
import { AgentUnavailable, type Thread, type HostId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { makeAccountScopes } from "./account-scopes.ts";
import { accountOf, machineAccountScope } from "./limit-wait.ts";
import { AgentHosts } from "./agent-hosts.ts";

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
