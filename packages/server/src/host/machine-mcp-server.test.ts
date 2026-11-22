import { describe, expect, it } from "@effect/vitest";
import type { HostSessionOpen, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { machineMcpServerFrom } from "./machine-mcp-server.ts";
import { sessionsOnHost } from "./sessions.ts";
import { layer, scriptedAgent, THREAD } from "./sessions.testing.ts";

const named = (value: unknown) => machineMcpServerFrom(JSON.stringify(value));

describe("a machine's own MCP server, from its host's environment", () => {
  it("is a named https server, or plain http on loopback", () => {
    expect(named({ name: "tools", url: "https://mcp.example.test/mcp" }).server).toEqual({
      name: "tools",
      url: "https://mcp.example.test/mcp",
    });
    expect(named({ name: "tools", url: "http://127.0.0.1:3129/w/mcp" }).server?.url).toBe(
      "http://127.0.0.1:3129/w/mcp",
    );
  });

  it("is none, with no error, when unset", () => {
    expect(machineMcpServerFrom(undefined)).toEqual({ server: undefined });
    expect(machineMcpServerFrom("  ")).toEqual({ server: undefined });
  });

  it("is refused for plain http off loopback, a credential in the url, or a name a config can't take", () => {
    for (const value of [
      { name: "tools", url: "http://mcp.example.test/mcp" },
      { name: "tools", url: "https://user:secret@mcp.example.test/mcp" },
      { name: "tools", url: "file:///etc/passwd" },
      { name: 'a"b', url: "https://mcp.example.test/mcp" },
      { name: "", url: "https://mcp.example.test/mcp" },
      { url: "https://mcp.example.test/mcp" },
    ]) {
      const read = named(value);
      expect(read.server).toBeUndefined();
      expect(read.error).toBeDefined();
    }
    expect(machineMcpServerFrom("{not json").error).toBeDefined();
  });
});

describe("a machine's own MCP server", () => {
  const MACHINE_SERVER = { name: "machine", url: "http://127.0.0.1:3129/mcp" };

  it.live("is given to a session the control plane names none for, and never over its own", () =>
    Effect.gen(function* () {
      const agent = yield* scriptedAgent("codex", "host");
      const sessions = yield* sessionsOnHost(
        () => Effect.succeed(agent.host),
        undefined,
        {},
        { mcpServer: MACHINE_SERVER },
      );
      yield* sessions.open({ handle: "a", agent: "codex", threadId: THREAD, cwd: "/work" });
      const profiles = { name: "profile", url: "https://mcp.example.test/workspace" };
      yield* sessions.open({
        handle: "b",
        agent: "codex",
        threadId: "other" as ThreadId,
        cwd: "/work",
        mcpServer: profiles,
      });
      expect(agent.opened.map((o) => o.mcpServer)).toEqual([MACHINE_SERVER, profiles]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("is given only where the session's own lists keep it, and never to a confined one", () =>
    Effect.gen(function* () {
      const agent = yield* scriptedAgent("codex", "host");
      const sessions = yield* sessionsOnHost(
        () => Effect.succeed(agent.host),
        undefined,
        {},
        { mcpServer: MACHINE_SERVER },
      );
      const cases: ReadonlyArray<
        readonly [string, Partial<HostSessionOpen>, typeof MACHINE_SERVER | undefined]
      > = [
        ["allowed by name", { mcpAllowlist: ["machine"] }, MACHINE_SERVER],
        ["allowed by address", { mcpAllowlist: ["http://127.0.0.1:3129/*"] }, MACHINE_SERVER],
        ["held to other servers", { mcpAllowlist: ["github"] }, undefined],
        ["held to none", { mcpAllowlist: [] }, undefined],
        ["denied by name", { mcpDenylist: ["machine"] }, undefined],
        ["denied by address", { mcpDenylist: ["http://127.0.0.1:*"] }, undefined],
        [
          "denied though allowed",
          { mcpAllowlist: ["machine"], mcpDenylist: ["machine"] },
          undefined,
        ],
        ["confined", { confineWrites: true }, undefined],
      ];
      for (const [handle, lists] of cases)
        yield* sessions.open({
          handle,
          agent: "codex",
          threadId: handle as ThreadId,
          cwd: "/work",
          ...lists,
        });
      expect(agent.opened.map((o) => o.mcpServer)).toEqual(cases.map(([, , given]) => given));
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("is given to none when the machine has none", () =>
    Effect.gen(function* () {
      const agent = yield* scriptedAgent("claude", "host");
      const sessions = yield* sessionsOnHost(() => Effect.succeed(agent.host));
      yield* sessions.open({ handle: "a", agent: "claude", threadId: THREAD, cwd: "/work" });
      expect(agent.opened[0]!.mcpServer).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
