import {
  InvalidState,
  type ConfiguredServer,
  type McpScope,
  type McpServerConfig,
} from "@gram/contracts";
import { claudeServerEntry } from "@gram/agents";
import { readClaudeConfiguredServers, readClaudeEverConnected } from "@gram/agents/claude";
import { homedir } from "node:os";
import { Proc } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { redactText } from "../logging/redact.ts";

export interface McpCliOutput {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface McpCliShape {
  /** Runs `claude <args>` in `cwd` to completion; a non-zero exit is a value. */
  readonly run: (
    args: ReadonlyArray<string>,
    cwd: string,
  ) => Effect.Effect<McpCliOutput, InvalidState>;
  /**
   * The servers Claude Code has configured, as seen from `cwd`, without their header and env
   * values. Read from its config files: `claude mcp list` would connect every one of them.
   */
  readonly configured: (
    cwd: string | undefined,
  ) => Effect.Effect<ReadonlyArray<ConfiguredServer>, InvalidState>;
  /**
   * `claude mcp login <name>` from `cwd`: Claude Code opens the browser itself, waits on its own
   * loopback port for the callback, and stores the token where every `claude` finds it. Resolves
   * once the user has finished or it gave up; a non-zero exit is a value. Absent where it can't
   * run unattended.
   */
  readonly login?: (name: string, cwd: string) => Effect.Effect<McpCliOutput, InvalidState>;
  /**
   * `claude mcp login --no-browser <name>` for a claude.ai connector, which prints claude.ai's
   * sign-in page for it and exits. Claude Code 2.1.293 fetches the account's connector list to find
   * it and connects nothing, and asks for no terminal. Absent where it can't run.
   */
  readonly connectorLogin?: (name: string) => Effect.Effect<McpCliOutput, InvalidState>;
  /**
   * The claude.ai connectors Claude Code has ever connected, by name (`claudeEverConnected`).
   * Absent where none can be known.
   */
  readonly everConnected?: Effect.Effect<ReadonlyArray<string>>;
}

/**
 * Claude Code's `claude mcp …`, which owns where each scope's config lives. The default runs and
 * reads nothing, so tests never touch a real config; `main.ts` provides `McpCliLive`.
 */
export const McpCli = Context.Reference<McpCliShape>("@gram/server/McpCli", {
  defaultValue: () => ({
    run: () => Effect.fail(new InvalidState({ message: "Claude Code's CLI isn't available here" })),
    configured: () => Effect.succeed([]),
  }),
});

const CLI_TIMEOUT_MS = 30_000;

/**
 * How long `claude mcp login` may run. It gives up by itself after five minutes ("Authentication
 * timeout"), so this only stops one that has wedged.
 */
const LOGIN_TIMEOUT_MS = 6 * 60_000;

/**
 * `claude mcp login` refuses to start unless stdin is a terminal, so it runs under macOS's
 * `script`, which gives it one. Its own stdin is closed: nothing is ever typed at the prompt for
 * a pasted redirect, and the browser's callback to Claude Code's loopback port completes it.
 */
export const loginInvocation = (name: string) => ({
  bin: "/usr/bin/script",
  args: ["-q", "/dev/null", "claude", "mcp", "login", name],
});

/** `claude mcp login` for a claude.ai connector, which only prints the page to open. */
export const connectorLoginArgs = (name: string) => ["mcp", "login", "--no-browser", name];

/** The installed `claude` through the probed login-shell PATH. */
export const McpCliLive: Layer.Layer<never, never, Proc> = Layer.effect(
  McpCli,
  Effect.gen(function* () {
    const proc = yield* Proc;
    const login = (name: string, cwd: string) => {
      const { bin, args } = loginInvocation(name);
      return proc.run(bin, args, { cwd, timeoutMs: LOGIN_TIMEOUT_MS }).pipe(
        Effect.mapError(
          (error) =>
            new InvalidState({
              message:
                error._tag === "ProcTimeout"
                  ? "The sign-in wasn't finished in time."
                  : "Couldn't run claude. Is Claude Code installed?",
            }),
        ),
      );
    };
    return {
      // Other platforms have no `script` to lend it a terminal; a running Claude thread signs in.
      ...(process.platform === "darwin" ? { login } : {}),
      // A fetch of the account's connector list, and nothing to wait for after it.
      connectorLogin: (name) =>
        proc.run("claude", connectorLoginArgs(name), { cwd: homedir(), tier: "network" }).pipe(
          Effect.mapError(
            (error) =>
              new InvalidState({
                message:
                  error._tag === "ProcTimeout"
                    ? "claude mcp login didn't answer in time."
                    : "Couldn't run claude. Is Claude Code installed?",
              }),
          ),
        ),
      everConnected: Effect.promise(() => readClaudeEverConnected(process.env)),
      run: (args, cwd) =>
        proc.run("claude", args, { cwd, timeoutMs: CLI_TIMEOUT_MS }).pipe(
          // The arguments carry the server's secrets, so the error names neither them nor the command.
          Effect.mapError(
            (error) =>
              new InvalidState({
                message:
                  error._tag === "ProcTimeout"
                    ? "claude mcp didn't finish in time"
                    : "Couldn't run claude. Is Claude Code installed?",
              }),
          ),
        ),
      configured: (cwd) =>
        Effect.tryPromise({
          try: () => readClaudeConfiguredServers(cwd),
          catch: () => new InvalidState({ message: "Couldn't read Claude Code's config." }),
        }),
    };
  }),
);

export const addJsonArgs = (name: string, scope: McpScope, config: McpServerConfig) => [
  "mcp",
  "add-json",
  "--scope",
  scope,
  name,
  JSON.stringify(claudeServerEntry(config)),
];

export const removeArgs = (name: string, scope: McpScope | undefined) => [
  "mcp",
  "remove",
  ...(scope === undefined ? [] : ["--scope", scope]),
  name,
];

/** Env and header values long enough to be secrets; short ones like `1` would mask ordinary text. */
export const secretsOf = (config: McpServerConfig): ReadonlyArray<string> =>
  Object.values((config.type === "stdio" ? config.env : config.headers) ?? {}).filter(
    (value) => value.length >= 4,
  );

export const redact = (text: string, secrets: ReadonlyArray<string>): string =>
  secrets.reduce((out, secret) => out.replaceAll(secret, "••••"), text);

/** Terminal escapes and other control characters, which `script`'s output is full of. */
const ESCAPES = new RegExp(
  [
    String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)`,
    String.raw`\u001b\[[0-?]*[ -/]*[@-~]`,
    String.raw`[\u0000-\u0008\u000b-\u001f]`,
  ].join("|"),
  "g",
);

/**
 * The claude.ai page `claude mcp login --no-browser` printed for a connector: the first web address
 * in its output, which it may wrap in a terminal hyperlink. `undefined` when there is none.
 */
export const connectorSignInPage = (out: McpCliOutput): string | undefined =>
  /https:\/\/\S+/.exec(out.stdout.replace(ESCAPES, " "))?.[0];

/**
 * Why `claude mcp login` gave up, from what it printed to its terminal: its own "Couldn't…" or
 * error line, never the authorization page it printed, which carries the sign-in's state.
 */
export const loginFailure = (out: McpCliOutput): string => {
  const lines = `${out.stdout}\n${out.stderr}`
    .replace(ESCAPES, "")
    .split(/\r?\n/)
    .map((line) => line.trim());
  const said = lines.find((line) => /^(?:couldn't|could not|error|failed)\b/i.test(line));
  return said === undefined
    ? `claude mcp login exited with code ${out.status}.`
    : redactText(said.replace(/https?:\/\/\S+/g, "…"));
};
