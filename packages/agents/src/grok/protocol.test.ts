import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ProfileId, RequestId, ThreadId, type AgentEvent } from "@gram/contracts";
import type { AgentSession } from "../host.ts";
import { makeUnqualifiedGrokProtocolFixture } from "./protocol.test-support.ts";
import { grokEnvironment, GROK_REQUIREMENTS } from "./environment.ts";

const peer = fileURLToPath(new URL("../../fixtures/grok/cli.cjs", import.meta.url));
function fixture(scenario = "normal") {
  const root = mkdtempSync(join(tmpdir(), "gram-grok-"));
  const log = join(root, "protocol.jsonl");
  mkdirSync(join(root, "user"));
  const host = makeUnqualifiedGrokProtocolFixture({
    home: join(root, "owned-grok"),
    authPath: join(root, "user", "synthetic-auth-do-not-open.json"),
    binary: process.execPath,
    args: [peer, scenario, log],
    // Explicit invented auth state; never inherit real host provider/account environment.
    env: {
      HOME: join(root, "user"),
      PATH: "",
      XAI_API_KEY: "synthetic-api",
      X_AI_API_KEY: "synthetic-alternate",
      OPENAI_API_KEY: "synthetic-other",
      GROK_AUTH: "synthetic-injected",
      GROK_CONFIG: "synthetic-unsafe",
    },
  });
  const read = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            method?: string;
            params?: Record<string, unknown>;
            result?: unknown;
            error?: unknown;
            pid: number;
          },
      );
  return { root, host, read, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const options = {
  threadId: ThreadId.make("synthetic-grok-thread"),
  cwd: tmpdir(),
  model: { agent: "grok", model: "synthetic-grok" } as const,
  permissionMode: "default" as const,
};
const turn = (session: AgentSession, events: AgentEvent[]) =>
  session.events.pipe(
    Stream.takeUntil((event) => event.type === "turnEnd"),
    Stream.runForEach((event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    ),
  );

describe("unqualified Grok ACP fixture adapter (isolated invented peer only)", () => {
  it("discovers CLI models, streams only its session and resumes the saved identity", async () => {
    const f = fixture();
    try {
      expect(await Effect.runPromise(f.host.listModels())).toEqual([
        {
          id: "synthetic-grok",
          displayName: "Synthetic Grok",
          supportsEffort: false,
          isDefault: true,
        },
        {
          id: "synthetic-other",
          displayName: "Synthetic other",
          supportsEffort: false,
          isDefault: false,
        },
      ]);
      const events: AgentEvent[] = [];
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* f.host.open(options);
            const observer = yield* Effect.forkScoped(turn(session, events));
            yield* session.send({ text: "Invented prompt" });
            yield* Fiber.join(observer);
          }),
        ),
      );
      const identity = events.find((event) => event.type === "identity");
      expect(identity?.agentSessionId).toBe("11111111-1111-4111-8111-111111111111");
      expect(
        events
          .filter((event) => event.type === "chunk" && event.chunk.type === "text-delta")
          .map((event) =>
            event.type === "chunk" && event.chunk.type === "text-delta" ? event.chunk.delta : "",
          )
          .join(""),
      ).toBe("Hello world");
      expect(events.filter((event) => event.type === "usage")).toEqual([]);
      await Effect.runPromise(
        Effect.scoped(f.host.open({ ...options, resumeId: identity!.agentSessionId })),
      );
      expect(f.read().some((row) => row.method === "session/load")).toBe(true);
      expect(
        f
          .read()
          .filter((row) => row.method === "authenticate")
          .every((row) => row.params?.methodId === "cached_token"),
      ).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("records CLI-reported selected and served model changes without inventing usage", async () => {
    const f = fixture("served-model");
    const events: AgentEvent[] = [];
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* f.host.open(options);
            const observer = yield* Effect.forkScoped(turn(session, events));
            yield* session.send({ text: "Synthetic model routing" });
            yield* Fiber.join(observer);
          }),
        ),
      );
      expect(
        events.some((event) => event.type === "model" && event.model === "synthetic-other"),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "chunk" &&
            event.chunk.type === "message-metadata" &&
            JSON.stringify(event.chunk.messageMetadata) ===
              JSON.stringify({ model: "Synthetic served two", modelConflict: true }),
        ),
      ).toBe(true);
      expect(events.some((event) => event.type === "usage")).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it.each(["signed-out", "api-key", "expired", "unknown-version"])(
    "refuses %s before session or inference",
    async (scenario) => {
      const f = fixture(scenario);
      try {
        const result = await Effect.runPromise(
          Effect.scoped(f.host.open(options)).pipe(Effect.result),
        );
        expect(result._tag).toBe("Failure");
        expect(JSON.stringify(result)).not.toContain("synthetic-secret-never-expose");
        expect(
          f.read().some((row) => row.method === "session/new" || row.method === "session/prompt"),
        ).toBe(false);
      } finally {
        f.cleanup();
      }
    },
  );

  it.each(["allow", "deny"] as const)(
    "round-trips a native tool approval (%s) with once scope only",
    async (decision) => {
      const f = fixture("tool");
      const events: AgentEvent[] = [];
      try {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const session = yield* f.host.open(options);
              const observe = session.events.pipe(
                Stream.takeUntil((event) => event.type === "turnEnd"),
                Stream.runForEach((event) =>
                  Effect.gen(function* () {
                    events.push(event);
                    if (event.type === "request") {
                      expect(event.request.kind).toBe("approval");
                      yield* session.respond(event.request.id, {
                        kind: "approval",
                        decision,
                        scope: "once",
                      });
                    }
                  }),
                ),
              );
              const observer = yield* Effect.forkScoped(observe);
              yield* session.send({ text: "Synthetic tool" });
              yield* Fiber.join(observer);
            }),
          ),
        );
        expect(events.some((event) => event.type === "requestResolved")).toBe(true);
        expect(
          events.some(
            (event) =>
              event.type === "chunk" &&
              event.chunk.type === "tool-output-available" &&
              event.chunk.output === (decision === "allow" ? "synthetic output" : "denied"),
          ),
        ).toBe(true);
      } finally {
        f.cleanup();
      }
    },
  );

  it("cancels the owning turn and drops late text", async () => {
    const f = fixture("cancel");
    const events: AgentEvent[] = [];
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* f.host.open(options);
            const observer = yield* Effect.forkScoped(
              session.events.pipe(
                Stream.takeUntil((event) => event.type === "turnEnd"),
                Stream.runForEach((event) =>
                  Effect.gen(function* () {
                    events.push(event);
                    if (event.type === "chunk" && event.chunk.type === "text-delta")
                      yield* session.interrupt;
                  }),
                ),
              ),
            );
            yield* session.send({ text: "Cancel synthetic turn" });
            yield* Fiber.join(observer);
          }),
        ),
      );
      expect(events.find((event) => event.type === "turnEnd")).toMatchObject({
        reason: "interrupted",
      });
      expect(JSON.stringify(events)).not.toContain("LATE");
      expect(f.read().some((row) => row.method === "session/cancel")).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it.each(["error", "exit"])("settles %s as an explicit turn failure", async (scenario) => {
    const f = fixture(scenario);
    const events: AgentEvent[] = [];
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* f.host.open(options);
            const observer = yield* Effect.forkScoped(turn(session, events));
            yield* session.send({ text: "Synthetic failure" });
            yield* Fiber.join(observer);
          }),
        ),
      );
      expect(events.find((event) => event.type === "turnEnd")).toMatchObject({ reason: "error" });
      expect(JSON.stringify(events)).not.toContain("synthetic-secret-never-expose");
    } finally {
      f.cleanup();
    }
  });

  it("refuses filesystem reverse APIs without advertising filesystem authority", async () => {
    const f = fixture("reverse");
    const events: AgentEvent[] = [];
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* f.host.open(options);
            const observer = yield* Effect.forkScoped(turn(session, events));
            yield* session.send({ text: "Synthetic reverse request" });
            yield* Fiber.join(observer);
          }),
        ),
      );
      expect(
        f.read().find((row) => row.method === "initialize")?.params?.clientCapabilities,
      ).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
      expect(f.read().some((row) => row.error !== undefined)).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("does not turn persistent-only permission options into a once grant", async () => {
    const f = fixture("persistent-only");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* f.host.open(options);
            const observer = yield* Effect.forkScoped(
              session.events.pipe(
                Stream.takeUntil((event) => event.type === "turnEnd"),
                Stream.runForEach((event) =>
                  Effect.gen(function* () {
                    if (event.type !== "request") return;
                    const grant = yield* session
                      .respond(event.request.id, {
                        kind: "approval",
                        decision: "allow",
                        scope: "once",
                      })
                      .pipe(Effect.result);
                    expect(grant._tag).toBe("Failure");
                    yield* session.respond(event.request.id, {
                      kind: "approval",
                      decision: "deny",
                      scope: "once",
                    });
                  }),
                ),
              ),
            );
            yield* session.send({ text: "Synthetic unsupported grant" });
            yield* Fiber.join(observer);
          }),
        ),
      );
      expect(JSON.stringify(f.read())).not.toContain('"optionId":"always"');
    } finally {
      f.cleanup();
    }
  });

  it("requires advertised load support and changes only to discovered local models", async () => {
    const missing = fixture("no-resume");
    try {
      const result = await Effect.runPromise(
        Effect.scoped(missing.host.open({ ...options, resumeId: "synthetic-saved" })).pipe(
          Effect.result,
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(
        missing.read().some((row) => row.method === "session/load" || row.method === "session/new"),
      ).toBe(false);
    } finally {
      missing.cleanup();
    }
    const f = fixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* f.host.open(options);
            yield* session.setModel({ agent: "grok", model: "synthetic-other" });
            const denied = yield* session.setMode("auto").pipe(Effect.result);
            expect(denied._tag).toBe("Failure");
            yield* session.setMode("default");
          }),
        ),
      );
      expect(
        f
          .read()
          .filter((row) => row.method === "session/set_model")
          .map((row) => row.params?.modelId),
      ).toEqual(["synthetic-grok", "synthetic-other"]);
    } finally {
      f.cleanup();
    }
  });

  it("requires HTTP MCP capability and preserves the bound endpoint only for its own session", async () => {
    const mcp = {
      url: "https://gram.example.invalid/synthetic-mcp",
      headers: { Authorization: "Bearer synthetic-thread-only" },
    };
    const missing = fixture("no-mcp");
    try {
      expect(
        (
          await Effect.runPromise(
            Effect.scoped(missing.host.open({ ...options, mcp })).pipe(Effect.result),
          )
        )._tag,
      ).toBe("Failure");
      expect(missing.read().some((row) => row.method === "session/new")).toBe(false);
    } finally {
      missing.cleanup();
    }
    const f = fixture();
    try {
      await Effect.runPromise(Effect.scoped(f.host.open({ ...options, mcp })));
      expect(f.read().find((row) => row.method === "session/new")?.params?.mcpServers).toEqual([
        {
          type: "http",
          name: "gram",
          url: mcp.url,
          headers: [{ name: "Authorization", value: "Bearer synthetic-thread-only" }],
        },
      ]);
      await Effect.runPromise(
        Effect.scoped(
          f.host.open({ ...options, threadId: ThreadId.make("other-synthetic-thread") }),
        ),
      );
      expect(
        readFileSync(
          join(f.root, "owned-grok", "sessions", options.threadId, "requirements.toml"),
          "utf8",
        ),
      ).toBe(GROK_REQUIREMENTS);
      expect(
        readFileSync(
          join(f.root, "owned-grok", "sessions", "other-synthetic-thread", "requirements.toml"),
          "utf8",
        ),
      ).toBe(GROK_REQUIREMENTS);
    } finally {
      f.cleanup();
    }
  });

  it("refuses another profile and unsupported restrictions before spawning", async () => {
    const f = fixture();
    try {
      for (const extra of [
        { model: { ...options.model, profileId: ProfileId.make("another-provider") } },
        { permissionMode: "bypassPermissions" as const },
        { dreamFilesOnly: true },
        { audience: "worker" as const },
        { confineWrites: true },
        { fork: true },
        { mcpAllowlist: [] },
      ]) {
        expect(
          (
            await Effect.runPromise(
              Effect.scoped(f.host.open({ ...options, ...extra })).pipe(Effect.result),
            )
          )._tag,
        ).toBe("Failure");
      }
      expect(() => f.read()).toThrow();
      expect(
        (
          await Effect.runPromise(
            f.host.listModels({ profileId: ProfileId.make("api") }).pipe(Effect.result),
          )
        )._tag,
      ).toBe("Failure");
    } finally {
      f.cleanup();
    }
  });

  it("keeps duplicate session ownership until actual child exit", async () => {
    const f = fixture();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* f.host.open(options);
            expect(session).toBeDefined();
            const duplicate = yield* f.host
              .open({ ...options, resumeId: "11111111-1111-4111-8111-111111111111" })
              .pipe(Effect.result);
            expect(duplicate._tag).toBe("Failure");
            expect(f.read().filter((row) => row.method === "initialize")).toHaveLength(1);
            const wrong = yield* session
              .respond(RequestId.make("missing"), {
                kind: "approval",
                decision: "allow",
                scope: "once",
              })
              .pipe(Effect.result);
            expect(wrong._tag).toBe("Failure");
          }),
        ),
      );
    } finally {
      f.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")(
    "releases a never-spawned saved claim and recovers the same identity without weakening live ownership",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "gram-grok-missing-"));
      const binary = join(root, "missing-then-node");
      const log = join(root, "protocol.jsonl");
      const host = makeUnqualifiedGrokProtocolFixture({
        home: join(root, "owned-grok"),
        authPath: join(root, "synthetic-auth-never-open.json"),
        binary,
        args: [peer, "normal", log],
        env: { HOME: root, PATH: "" },
      });
      const saved = { ...options, resumeId: "11111111-1111-4111-8111-111111111111" };
      try {
        const missing = await Effect.runPromise(
          Effect.scoped(host.open(saved)).pipe(Effect.result),
        );
        expect(missing._tag).toBe("Failure");
        symlinkSync(process.execPath, binary);
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const recovered = yield* host.open(saved);
              expect(recovered).toBeDefined();
              const duplicate = yield* host.open(saved).pipe(Effect.flip);
              expect(duplicate.message).toContain("previous Grok Build child still owns");
            }),
          ),
        );
        // The completed scope observed the real child's EXIT; the saved ID is usable again.
        await Effect.runPromise(Effect.scoped(host.open(saved)));
        expect(
          readFileSync(log, "utf8")
            .split("\n")
            .filter((line) => line.includes('"method":"session/load"')),
        ).toHaveLength(2);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("strips inherited billed auth and endpoint overrides; pins requirements outside ignored overlay", () => {
    const env = grokEnvironment(
      {
        HOME: "/synthetic/home",
        PATH: "/synthetic/bin",
        XAI_API_KEY: "synthetic",
        X_AI_API_KEY: "synthetic",
        GROK_AUTH: "synthetic",
        GROK_CONFIG: "unsafe",
        GROK_CONFIG_PATH: "/synthetic/config",
        GROK_CLI_CHAT_PROXY_BASE_URL: "https://example.invalid",
        ANTHROPIC_API_KEY: "synthetic",
      },
      "/synthetic/gram/grok",
      "/synthetic/login/auth.json",
    );
    expect(Object.keys(env).toSorted()).toEqual([
      "GROK_AUTH_PATH",
      "GROK_DISABLE_API_KEY_AUTH",
      "GROK_DISABLE_AUTOUPDATER",
      "GROK_HOME",
      "GROK_MANAGED_CONFIG",
      "GROK_MANAGED_CONFIG_FAIL_CLOSED",
      "HOME",
      "PATH",
    ]);
    expect(env.GROK_AUTH_PATH).toBe("/synthetic/login/auth.json");
    expect(GROK_REQUIREMENTS).toContain('preferred_method = "oidc"');
    expect(GROK_REQUIREMENTS).toContain('rules = [{ action = "ask", tool = "any" }]');
  });
});
