import { describe, expect, it } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import {
  AgentUnavailable,
  HostId,
  HostStatus,
  LOCAL_HOST_ID,
  type TerminalId,
} from "@gram/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { onMachineUnavailable } from "../runtime/host-agent-sessions.ts";
import {
  claudeSignInOf,
  hostStatusOf,
  machineSignInTerminal,
  openSignInTerminal,
  probeTool,
  type ShellRun,
} from "./claude-sign-in.ts";

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

  it("opens the Sign in terminal on the machine, in its home, with the line typed not run", () => {
    expect(machineSignInTerminal(HostId.make("h1"))).toEqual({
      hostId: "h1",
      cwd: "~",
      typed: "claude /login",
    });
  });

  it("finds a tool on the login shell's PATH, with its version", async () => {
    const scripts: string[] = [];
    const run: ShellRun = async (script) => {
      scripts.push(script);
      return script.includes("git")
        ? { code: 127, stdout: "" }
        : { code: 0, stdout: "2.1.319 (Claude Code)\n" };
    };
    expect(await probeTool("claude", run)).toEqual({
      tool: "claude",
      found: true,
      version: "2.1.319",
    });
    expect(await probeTool("git", run)).toEqual({ tool: "git", found: false });
    // The name is the fixed one, never anything a caller sent.
    expect(scripts).toEqual([
      "command -v claude >/dev/null 2>&1 && claude --version",
      "command -v git >/dev/null 2>&1 && git --version",
    ]);
    // A version too long for the wire is cut, so the rest of the status still arrives.
    expect(
      (await probeTool("claude", async () => ({ code: 0, stdout: `1.2.3-${"a".repeat(80)}` })))
        .version,
    ).toHaveLength(64);
    // A shell that couldn't run reads as not found, not as a failure.
    expect(await probeTool("git", () => Promise.reject(new Error("no shell")))).toEqual({
      tool: "git",
      found: false,
    });
  });
});

const nothing: ShellRun = async () => ({ code: 1, stdout: "" });

describe("a machine's status", () => {
  it.effect("counts a Claude that answered about its sign-in as installed", () =>
    Effect.gen(function* () {
      expect(yield* hostStatusOf(Effect.succeed("notSignedIn"), nothing)).toEqual({
        claudeSignIn: "notSignedIn",
        tools: [
          { tool: "claude", found: true },
          { tool: "git", found: false },
        ],
      });
      const unknown = yield* hostStatusOf(Effect.succeed("unknown"), nothing);
      expect(unknown.tools[0]).toEqual({ tool: "claude", found: false });
    }),
  );
  it.effect("carries what its Claude Code lists, cut to what the wire takes", () =>
    Effect.gen(function* () {
      const opus = {
        id: "opus",
        displayName: "Opus",
        resolvedId: "claude-opus-5-5",
        supportsEffort: true,
        efforts: ["low", "medium", "high", "xhigh", "max"] as const,
        description: "Synthetic description the wire doesn't carry",
        isDefault: true,
      };
      const status = yield* hostStatusOf(
        Effect.succeed("signedIn"),
        nothing,
        Effect.succeed([opus, { ...opus, id: "x".repeat(300) }]),
      );
      expect(status.models).toEqual([
        {
          id: "opus",
          displayName: "Opus",
          resolvedId: "claude-opus-5-5",
          supportsEffort: true,
          efforts: ["low", "medium", "high", "xhigh", "max"],
        },
        expect.objectContaining({ id: "x".repeat(128) }),
      ]);
      expect(Schema.decodeUnknownSync(HostStatus)(status)).toEqual(status);
      const many = yield* hostStatusOf(
        Effect.succeed("signedIn"),
        nothing,
        Effect.succeed(Array.from({ length: 80 }, (_, i) => ({ ...opus, id: `m${i}` }))),
      );
      expect(many.models).toHaveLength(64);
      // Nothing listed, or couldn't list: no key, as an older host sends.
      expect(
        yield* hostStatusOf(Effect.succeed("signedIn"), nothing, Effect.succeed(undefined)),
      ).not.toHaveProperty("models");
    }),
  );

  it("decodes across the version skew both ways", () => {
    // An older host's status, with no models, decodes here.
    const old = { claudeSignIn: "signedIn", tools: [] };
    expect(Schema.decodeUnknownSync(HostStatus)(old)).toEqual(old);
    // A control plane before it reads the newer status as the struct it knew, ignoring models.
    const before = Schema.Struct({
      claudeSignIn: Schema.String,
      tools: Schema.Array(Schema.Unknown),
    });
    expect(
      Schema.decodeUnknownSync(before)({
        ...old,
        models: [{ id: "opus", displayName: "Opus", supportsEffort: false }],
      }),
    ).toEqual(old);
  });
});

/** Finds every id as its own joined machine, as a server with them does. */
const joined = (id: HostId) => Effect.succeed({ id });

/** A recording stand-in for the terminals the handler opens on. */
const fake = () => {
  const calls: Array<{ readonly call: string; readonly args: unknown }> = [];
  const terminals = {
    open: (request: unknown) =>
      Effect.sync(() => {
        calls.push({ call: "open", args: request });
        return { terminalId: "t1" as TerminalId, cwd: "~", shell: "/bin/zsh" };
      }),
    input: (terminalId: TerminalId, data: string) =>
      Effect.sync(() => void calls.push({ call: "input", args: { terminalId, data } })),
  };
  return { calls, terminals };
};

describe("the Sign in terminal", () => {
  it.effect("opens a shell on the machine and types the line without running it", () =>
    Effect.gen(function* () {
      const { calls, terminals } = fake();
      yield* openSignInTerminal(terminals, joined, HostId.make("h1"), { cols: 100, rows: 16 });
      expect(calls).toEqual([
        { call: "open", args: { hostId: "h1", cwd: "~", cols: 100, rows: 16 } },
        // No Return: the user runs it.
        { call: "input", args: { terminalId: "t1", data: "claude /login" } },
      ]);
    }),
  );

  it.effect("refuses anything else about where or what, and this machine", () =>
    Effect.gen(function* () {
      const { calls, terminals } = fake();
      for (const extra of [
        { threadId: "t" },
        { cwd: "/etc" },
        { shell: "/bin/sh" },
        { script: "dev" },
      ]) {
        const error = yield* openSignInTerminal(terminals, joined, HostId.make("h1"), {
          cols: 1,
          rows: 1,
          ...extra,
        }).pipe(Effect.flip);
        expect(error._tag).toBe("InvalidState");
      }
      yield* openSignInTerminal(terminals, joined, LOCAL_HOST_ID, { cols: 1, rows: 1 }).pipe(
        Effect.flip,
      );
      // Without the joined machines' routing, an id it can't find is refused, not opened here.
      const unrouted = yield* openSignInTerminal(
        terminals,
        () => Effect.fail("no machines"),
        HostId.make("h1"),
        { cols: 1, rows: 1 },
      ).pipe(Effect.flip);
      expect(unrouted._tag).toBe("InvalidState");
      // A lookup that answers with this machine for it is refused too.
      yield* openSignInTerminal(
        terminals,
        () => Effect.succeed({ id: LOCAL_HOST_ID }),
        HostId.make("h1"),
        {
          cols: 1,
          rows: 1,
        },
      ).pipe(Effect.flip);
      expect(calls).toEqual([]);
    }),
  );
});
