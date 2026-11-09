import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ClaudeEnvironment,
  ClaudeEnvironmentLive,
  OAUTH_TOKEN_VAR,
  type PreparedClaude,
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
