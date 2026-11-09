import { describe, expect, it } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import { AgentUnavailable, HostId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { onMachineUnavailable } from "../runtime/host-agent-sessions.ts";
import { claudeSignInOf, machineSignInTerminal } from "./claude-sign-in.ts";

const failing = (reason: AgentUnavailable["reason"]) =>
  ({
    kind: "claude",
    checkWorkspaceSwitch: Effect.fail(
      new AgentUnavailable({
        agent: "claude",
        ...(reason === undefined ? {} : { reason }),
        message: "x",
      }),
    ),
  }) as unknown as AgentHost;

const named = (reason: AgentUnavailable["reason"], message = "Claude Code isn't logged in.") =>
  onMachineUnavailable(
    new AgentUnavailable({
      agent: "claude",
      ...(reason === undefined ? {} : { reason }),
      message,
    }),
    "cachyos",
  );

describe("a machine's Claude sign-in", () => {
  it.effect("classifies the agent's own readiness check, and nothing else", () =>
    Effect.gen(function* () {
      expect(
        yield* claudeSignInOf({ kind: "claude", checkWorkspaceSwitch: Effect.void } as never),
      ).toBe("signedIn");
      expect(yield* claudeSignInOf(failing("not-logged-in"))).toBe("notSignedIn");
      expect(yield* claudeSignInOf(failing("api-key-auth"))).toBe("apiKey");
      expect(yield* claudeSignInOf(failing("third-party-provider"))).toBe("thirdParty");
      // Not an answer about the sign-in: Claude missing, or its status unreadable.
      expect(yield* claudeSignInOf(failing("claude-not-found"))).toBe("unknown");
      expect(yield* claudeSignInOf(failing("auth-status-failed"))).toBe("unknown");
      expect(yield* claudeSignInOf({ kind: "claude" } as never)).toBe("unknown");
    }),
  );

  it("names the machine in a start that failed there, with the fix to make there", () => {
    expect(named("not-logged-in")).toMatchObject({
      reason: "not-logged-in",
      message:
        "Claude Code isn't logged in on cachyos. Run `claude /login` there, or choose Sign in under Settings → Machines.",
    });
    expect(named("api-key-auth").message).toContain("on cachyos is using API-key auth");
    expect(named("startup-failed", "The CLI crashed.").message).toBe(
      "On cachyos: The CLI crashed.",
    );
    // Already said of the machine: left as it is.
    expect(named("startup-failed", "cachyos is offline.").message).toBe("cachyos is offline.");
  });

  it("opens the Sign in terminal on the machine, in its home, on a fixed command", () => {
    expect(machineSignInTerminal(HostId.make("h1"))).toEqual({
      hostId: "h1",
      cwd: "~",
      command: "claude auth login --claudeai",
      script: "Sign in to Claude",
    });
  });
});
