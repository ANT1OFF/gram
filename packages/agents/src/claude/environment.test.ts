import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import {
  ClaudeEnvironment,
  ClaudeEnvironmentLive,
  OAUTH_TOKEN_VAR,
  type PreparedClaude,
  signedInAccount,
  withOAuthToken,
} from "./environment.ts";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawnEnvFor } from "./env.ts";
import { ClaudeSdk, type ClaudeSdkShape } from "./sdk.ts";

/** Synthetic: the shape `claude setup-token` prints, never a real token. */
const FAKE_TOKEN = `sk-ant-oat01-${"SYNTHETICfakeTokenForGramTests_".repeat(3)}AA`;

/** A probe shell and a `claude` that only says its version, under a folder of their own. */
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "gram-claude-env-"));
  const binary = join(root, "claude");
  writeFileSync(binary, `#!${process.execPath}\nconsole.log("2.1.311 (Claude Code)");\n`);
  chmodSync(binary, 0o755);
  const shell = join(root, "shell");
  // Answers the login-shell probe with a synthetic env only: never the developer's own.
  writeFileSync(
    shell,
    `#!${process.execPath}\nprocess.stdout.write("\\0__SB_PROBE__\\0${binary}\\n\\0__SB_ENV__\\0PATH=/usr/bin:/bin\\0HOME=${root}\\0");`,
  );
  chmodSync(shell, 0o755);
  return { root, binary, shell, done: () => rmSync(root, { recursive: true, force: true }) };
};

const sdk = Layer.succeed(ClaudeSdk)({ version: "0.3.311" } as unknown as ClaudeSdkShape);

describe("the Claude child env with a setup-token token", () => {
  it.effect("sets it only while the reader has one, read afresh at each prepare", () => {
    const { binary, shell, done } = fixture();
    let token: string | undefined;
    let throws = false;
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(done));
      const environment = yield* ClaudeEnvironment;
      expect((yield* environment.prepare).env).not.toHaveProperty(OAUTH_TOKEN_VAR);
      token = FAKE_TOKEN;
      expect((yield* environment.prepare).env[OAUTH_TOKEN_VAR]).toBe(FAKE_TOKEN);
      // A token file that can't be read leaves the machine on its own sign-in.
      throws = true;
      expect((yield* environment.prepare).env).not.toHaveProperty(OAUTH_TOKEN_VAR);
      throws = false;
      token = undefined;
      expect((yield* environment.prepare).env).not.toHaveProperty(OAUTH_TOKEN_VAR);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ClaudeEnvironmentLive({
          shell,
          binaryPath: binary,
          oauthToken: () => {
            if (throws) throw new Error("must be a private file");
            return token;
          },
        }).pipe(Layer.provide(sdk)),
      ),
    );
  });
});

describe("a Claude child that holds a setup-token token", () => {
  // Review finding 4 on #314: these reached the token-bearing child as the probe found them.
  it("gets no debugger, preload, request-logging or TLS-bypass settings", () => {
    const prepared: PreparedClaude = {
      binaryPath: "/synthetic/claude",
      warnings: [],
      env: {
        PATH: "/usr/bin:/bin",
        HTTPS_PROXY: "http://proxy.example.invalid:3128",
        NODE_OPTIONS: "--inspect=0.0.0.0:9229",
        NODE_INSPECT_RESUME_ON_START: "1",
        BUN_INSPECT: "ws://0.0.0.0:6499",
        BASH_ENV: "/synthetic/preload.sh",
        DYLD_INSERT_LIBRARIES: "/synthetic/hook.dylib",
        LD_PRELOAD: "/synthetic/hook.so",
        SSLKEYLOGFILE: "/synthetic/keys.log",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        NODE_DEBUG: "http",
        ANTHROPIC_LOG: "debug",
        DEBUG: "*",
      },
    };
    expect(withOAuthToken(prepared, FAKE_TOKEN).env).toEqual({
      PATH: "/usr/bin:/bin",
      HTTPS_PROXY: "http://proxy.example.invalid:3128",
      [OAUTH_TOKEN_VAR]: FAKE_TOKEN,
    });
    // Without a token, the machine's own sign-in keeps the env as it was.
    expect(withOAuthToken(prepared, undefined)).toBe(prepared);
  });
});

describe("a token-bearing Claude child as the Agent SDK spawns it", () => {
  // Re-review R2 on #314: the SDK turns DEBUG_CLAUDE_AGENT_SDK into DEBUG=1 after Gram's env.
  it("gets no DEBUG or other debug switch after the real SDK's own changes", async () => {
    const { binary, done } = fixture();
    try {
      const prepared: PreparedClaude = {
        binaryPath: binary,
        warnings: [],
        env: {
          PATH: "/usr/bin:/bin",
          DEBUG_CLAUDE_AGENT_SDK: "1",
          DEBUG_SDK: "1",
          CLAUDE_DEBUG: "1",
          CLAUDE_CODE_DEBUG_LOG_LEVEL: "verbose",
          CLAUDE_CODE_TERMINAL_RECORDING: "/synthetic/rec",
        },
      };
      let fromSdk: Record<string, string | undefined> | undefined;
      const run = query({
        prompt: "synthetic",
        options: {
          env: withOAuthToken(prepared, FAKE_TOKEN).env,
          pathToClaudeCodeExecutable: binary,
          // The fixture only prints a version and exits: no real Claude Code or provider runs.
          spawnClaudeCodeProcess: ({ env, signal }) => {
            fromSdk = { ...env };
            return spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], signal });
          },
        },
      });
      await (async () => {
        for await (const _ of run) {
          // The fixture says nothing the SDK reads.
        }
      })().catch(() => {});
      expect(fromSdk).toBeDefined();
      const spawned = spawnEnvFor(fromSdk!);
      for (const env of [fromSdk!, spawned]) {
        expect(env["DEBUG"]).toBeUndefined();
        expect(
          Object.keys(env).filter(
            (name) => /DEBUG|RECORDING/.test(name) && env[name] !== undefined,
          ),
        ).toEqual([]);
      }
      expect(spawned["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(FAKE_TOKEN);
      // And whatever the SDK adds, the spawn boundary takes off again.
      expect(
        spawnEnvFor({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, DEBUG: "1", NODE_OPTIONS: "--inspect" }),
      ).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN });
    } finally {
      done();
    }
  });
});

/** A `claude` that says it is signed in with a key, under a folder of its own. */
const keyFixture = () => {
  const base = fixture();
  writeFileSync(
    base.binary,
    `#!${process.execPath}\nif (process.argv[2] === "auth") console.log(JSON.stringify({ loggedIn: true, authMethod: "apiKey", apiProvider: "firstParty" }));\nelse console.log("2.1.311 (Claude Code)");\n`,
  );
  return base;
};

const check = (keyAuth: boolean | undefined) => {
  const { binary, shell, done } = keyFixture();
  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(done));
    const environment = yield* ClaudeEnvironment;
    const prepared = yield* environment.prepare;
    return {
      keyAuth: environment.keyAuth,
      result: yield* Effect.exit(environment.checkAuth(prepared)),
    };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ClaudeEnvironmentLive({
        shell,
        binaryPath: binary,
        ...(keyAuth === undefined ? {} : { keyAuth }),
      }).pipe(Layer.provide(sdk)),
    ),
  );
};

describe("Claude Code's own key auth", () => {
  it.effect("is refused unless the machine's operator allowed it", () =>
    Effect.gen(function* () {
      const refused = yield* check(undefined);
      expect(refused.keyAuth).toBe(false);
      expect(refused.result._tag).toBe("Failure");
      const allowed = yield* check(true);
      expect(allowed.keyAuth).toBe(true);
      expect(allowed.result._tag).toBe("Success");
    }),
  );
});

/**
 * A `claude` whose `auth status` says what `status` holds and counts its runs in `runs`, under a
 * folder of its own.
 */
const countingFixture = () => {
  const base = fixture();
  const runs = join(base.root, "runs");
  const status = join(base.root, "status");
  const held = join(base.root, "held");
  writeFileSync(runs, "");
  writeFileSync(
    status,
    JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.test" }),
  );
  writeFileSync(
    base.binary,
    `#!${process.execPath}\nconst fs = require("node:fs");\nif (process.argv[2] === "auth") {\n  fs.appendFileSync(${JSON.stringify(runs)}, "x");\n  const answer = fs.readFileSync(${JSON.stringify(status)}, "utf8");\n  const wait = setInterval(() => { if (!fs.existsSync(${JSON.stringify(held)})) { clearInterval(wait); console.log(answer); } }, 10);\n}\nelse console.log("2.1.311 (Claude Code)");\n`,
  );
  return {
    ...base,
    runs: () => readFileSync(runs, "utf8").length,
    status,
    /** From now, each `auth status` answers what it read as it started, once `release` is called. */
    hold: () => writeFileSync(held, ""),
    release: () => rmSync(held, { force: true }),
  };
};

const signedOutStatus = JSON.stringify({ loggedIn: false });

const environmentOf = (held: ReturnType<typeof countingFixture>) =>
  ClaudeEnvironmentLive({ shell: held.shell, binaryPath: held.binary }).pipe(Layer.provide(sdk));

/** Waits until the fake `claude` has started `count` auth checks. */
const startedChecks = (held: ReturnType<typeof countingFixture>, count: number) =>
  Effect.gen(function* () {
    while (held.runs() < count) yield* Effect.sleep("10 millis");
  }).pipe(Effect.timeout("5 seconds"));

describe("claude auth status", () => {
  it.effect(
    "runs once for a launch's sign-in and account, and afresh for every check, so a sign-out counts at once",
    () => {
      const { binary, shell, done, runs, status } = countingFixture();
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(done));
        const environment = yield* ClaudeEnvironment;
        const prepared = yield* environment.prepare;
        expect(yield* signedInAccount(environment, prepared)).toBeTypeOf("string");
        expect(runs()).toBe(1);
        writeFileSync(status, JSON.stringify({ loggedIn: false }));
        expect((yield* Effect.exit(signedInAccount(environment, prepared)))._tag).toBe("Failure");
        expect((yield* Effect.exit(environment.checkAuth(prepared)))._tag).toBe("Failure");
        writeFileSync(status, JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
        expect((yield* Effect.exit(environment.checkAuth(prepared)))._tag).toBe("Success");
        expect(runs()).toBe(4);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ClaudeEnvironmentLive({ shell, binaryPath: binary }).pipe(Layer.provide(sdk)),
        ),
      );
    },
  );

  // Review cases for #955: two launches, or a launch and a readiness check, at once on one machine.
  it.live(
    "a launch started after a sign-out fails, though a check from before it is still running",
    () => {
      const held = countingFixture();
      return Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(held.done));
        const environment = yield* ClaudeEnvironment;
        const prepared = yield* environment.prepare;
        held.hold();
        const before = yield* Effect.forkScoped(signedInAccount(environment, prepared));
        yield* startedChecks(held, 1);
        writeFileSync(held.status, signedOutStatus);
        const launch = yield* Effect.forkScoped(
          Effect.exit(signedInAccount(environment, prepared)),
        );
        const readiness = yield* Effect.forkScoped(Effect.exit(environment.checkAuth(prepared)));
        yield* startedChecks(held, 3);
        held.release();
        expect(yield* Fiber.join(before)).toBeTypeOf("string");
        expect((yield* Fiber.join(launch))._tag).toBe("Failure");
        expect((yield* Fiber.join(readiness))._tag).toBe("Failure");
      }).pipe(Effect.scoped, Effect.provide(environmentOf(held)));
    },
  );

  it.live("a launch cancelled while its check runs leaves another launch's check alone", () => {
    const held = countingFixture();
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(held.done));
      const environment = yield* ClaudeEnvironment;
      const prepared = yield* environment.prepare;
      held.hold();
      const cancelled = yield* Effect.forkScoped(signedInAccount(environment, prepared));
      const other = yield* Effect.forkScoped(Effect.exit(signedInAccount(environment, prepared)));
      yield* startedChecks(held, 2);
      yield* Fiber.interrupt(cancelled);
      held.release();
      expect((yield* Fiber.join(other))._tag).toBe("Success");
    }).pipe(Effect.scoped, Effect.provide(environmentOf(held)));
  });

  it.live("a check interrupted as it starts leaves no later check waiting on it", () => {
    const held = countingFixture();
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(held.done));
      const environment = yield* ClaudeEnvironment;
      const prepared = yield* environment.prepare;
      held.hold();
      const interrupted = yield* Effect.forkScoped(environment.checkAuth(prepared));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(interrupted);
      held.release();
      const later = yield* Effect.exit(
        signedInAccount(environment, prepared).pipe(Effect.timeout("5 seconds")),
      );
      expect(later._tag).toBe("Success");
    }).pipe(Effect.scoped, Effect.provide(environmentOf(held)));
  });
});
