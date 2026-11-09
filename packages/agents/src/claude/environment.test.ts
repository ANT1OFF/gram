import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ClaudeEnvironment, ClaudeEnvironmentLive, OAUTH_TOKEN_VAR } from "./environment.ts";
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
