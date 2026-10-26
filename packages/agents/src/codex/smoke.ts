import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseCliVersion } from "../cli/discovery.ts";
import { runCommand } from "../cli/process.ts";
import { spawnServe, stopChild } from "../child-process.ts";
import { CODEX_CLI_VERSION } from "./version.ts";

export class CodexSmokeFailed extends Schema.TaggedError<CodexSmokeFailed>()("CodexSmokeFailed", {
  step: Schema.Literals(["version", "handshake"]),
  message: Schema.String,
}) {}

export interface CodexSmokeOptions {
  /** The version `codex --version` must print. */
  readonly expectedVersion: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/**
 * Proves `binary` is the Codex it claims to be and that its app-server answers `initialize`, in an
 * empty `CODEX_HOME` made for the purpose and deleted after, so the user's `~/.codex` (its login,
 * config and sessions) is never read and nothing billable runs.
 */
export const codexSmokeTest = (
  binary: string,
  options: CodexSmokeOptions,
): Effect.Effect<void, CodexSmokeFailed> => {
  const timeoutMs = options.timeoutMs ?? 20_000;
  return Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "gram-codex-smoke-"))),
    (home) =>
      Effect.gen(function* () {
        const env = { ...options.env, CODEX_HOME: home };
        const output = yield* runCommand(binary, ["--version"], { env, timeoutMs }).pipe(
          Effect.mapError(
            (error) => new CodexSmokeFailed({ step: "version", message: error.message }),
          ),
        );
        const version = parseCliVersion(output.stdout);
        if (output.exitCode !== 0 || version !== options.expectedVersion) {
          return yield* new CodexSmokeFailed({
            step: "version",
            message: `expected codex ${options.expectedVersion}, got ${version ?? `exit ${output.exitCode}`}`,
          });
        }
        yield* handshake(binary, env, timeoutMs);
      }),
    (home) => Effect.promise(() => rm(home, { recursive: true, force: true, maxRetries: 3 })),
  );
};

/** Starts `codex app-server`, waits for its answer to `initialize`, and stops it. */
const handshake = (binary: string, env: Record<string, string>, timeoutMs: number) =>
  Effect.callback<void, CodexSmokeFailed>((resume) => {
    const child = spawnServe(binary, ["app-server"], env, { stdin: "pipe" });
    let buffer = "";
    let stderr = "";
    let settled = false;
    const finish = (result: Effect.Effect<void, CodexSmokeFailed>) => {
      if (settled) return;
      settled = true;
      void stopChild(child, 1_000).then(() => resume(result));
    };
    const fail = (message: string) =>
      finish(Effect.fail(new CodexSmokeFailed({ step: "handshake", message })));
    child.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id !== 0) continue;
        if (message.result !== undefined) return finish(Effect.void);
        return fail(`initialize failed: ${String(message.error?.message ?? "no result")}`);
      }
      // A server that floods stdout without answering is as broken as a silent one.
      if (buffer.length > 1024 * 1024) fail("app-server wrote a megabyte without a newline");
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2_000);
    });
    child.once("error", (error) => fail(error.message));
    child.once("exit", (code) =>
      fail(`app-server exited (${code})${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`),
    );
    const timer = setTimeout(
      () => fail(`no answer to initialize within ${timeoutMs} ms`),
      timeoutMs,
    );
    child.once("exit", () => clearTimeout(timer));
    child.stdin?.write(
      `${JSON.stringify({
        id: 0,
        method: "initialize",
        params: {
          clientInfo: { name: "gram", title: "Gram", version: CODEX_CLI_VERSION },
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
      })}\n`,
    );
    return Effect.sync(() => {
      clearTimeout(timer);
      settled = true;
      void stopChild(child, 1_000);
    });
  });
