import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnServe, stopChild } from "../child-process.ts";
import { isTokenChildStripped } from "../claude/env.ts";
import { makeOpenCodeClient, type OpenCodeClient } from "./client.ts";

/** How long `opencode serve` gets to say where it listens. */
const START_TIMEOUT_MS = 30_000;

/**
 * What the server holds that its tools must not see: its password, the config (which can name a
 * gateway), and the gateway key. `GATEWAY_KEY_ENV` in session.ts is the last.
 */
export const SERVER_SECRETS = [
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_PASSWORD",
  "OPENCODE_CONFIG_CONTENT",
  "GRAM_OPENCODE_GATEWAY_KEY",
] as const;

/** A running `opencode serve`, on loopback, behind a password only this process knows. */
export interface OpenCodeServer {
  readonly url: string;
  readonly client: OpenCodeClient;
  readonly pid: number | undefined;
  /** Whether it is still running. */
  readonly alive: () => boolean;
  readonly stop: () => Promise<void>;
}

export interface StartOpenCodeServer {
  readonly binary: string;
  /** The server's environment before `openCodeEnv`; the password is added here. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

/** `server listening on http://127.0.0.1:<port>`, the line `opencode serve` prints first. */
export const listeningUrl = (line: string): string | undefined =>
  /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(line)?.[1];

const STRIPPED_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_OAUTH_TOKEN"];

/**
 * The env `opencode serve` runs in: the user's, without what could attach a debugger, preload code
 * or log requests and their keys (the policy a token-holding child gets, `isTokenChildStripped`),
 * without an Anthropic key or login (OpenCode isn't offered Anthropic's models), and without any
 * password or config a parent left, which the caller sets itself. Project config stays off, so a
 * repository's `opencode.json` can't redefine the agents, rules or plugins a thread runs with.
 */
export const openCodeEnv = (
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || isTokenChildStripped(name)) continue;
    const key = name.toUpperCase();
    if (STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if ((SERVER_SECRETS as ReadonlyArray<string>).includes(key)) continue;
    out[name] = value;
  }
  return {
    ...out,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };
};

/**
 * The shell OpenCode runs its `shell` tool in: the system's, started without the server's
 * secrets, so a command the agent runs (or its `env` output, sent on to the model) doesn't carry
 * them. A bound on what the agent is handed, not on a same-user process that goes looking for
 * them in the server's own environment.
 */
export const wrapperScript = (shell: string): string =>
  `#!/bin/sh\nunset ${SERVER_SECRETS.join(" ")}\nexec ${shell} "$@"\n`;

/** `config` (OpenCode's inline config, as JSON) with its shell set to `shell`. */
export const withShell = (config: string | undefined, shell: string): string => {
  let parsed: Record<string, unknown> = {};
  if (config !== undefined && config !== "") {
    const value: unknown = JSON.parse(config);
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      parsed = value as Record<string, unknown>;
  }
  return JSON.stringify({ ...parsed, shell });
};

/** Writes the wrapper in a folder only this user can open; Windows runs OpenCode's own shell. */
const writeWrapper = (): { readonly path: string; readonly remove: () => void } | undefined => {
  if (process.platform === "win32") return undefined;
  const dir = mkdtempSync(join(tmpdir(), "gram-opencode-"));
  const path = join(dir, "shell");
  writeFileSync(path, wrapperScript("/bin/bash"), { mode: 0o700 });
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
};

/**
 * Starts `opencode serve` on a free loopback port. The password is random and goes only into the
 * child's environment and this process's client, so nothing else on the machine can drive it
 * without reading that environment; the tools' shell starts without it (`wrapperScript`).
 * OpenCode doesn't update itself under Gram.
 */
export const startOpenCodeServer = ({
  binary,
  env,
  cwd,
}: StartOpenCodeServer): Promise<OpenCodeServer> =>
  new Promise((resolve, reject) => {
    const password = randomBytes(24).toString("base64url");
    const wrapper = writeWrapper();
    const base = openCodeEnv(env);
    const config = env["OPENCODE_CONFIG_CONTENT"];
    const child = spawnServe(
      binary,
      ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      {
        ...base,
        ...(wrapper === undefined
          ? config === undefined
            ? {}
            : { OPENCODE_CONFIG_CONTENT: config }
          : { OPENCODE_CONFIG_CONTENT: withShell(config, wrapper.path) }),
        ...(env["GRAM_OPENCODE_GATEWAY_KEY"] === undefined
          ? {}
          : { GRAM_OPENCODE_GATEWAY_KEY: env["GRAM_OPENCODE_GATEWAY_KEY"] }),
        OPENCODE_SERVER_PASSWORD: password,
      },
      cwd === undefined ? {} : { cwd },
    );
    child.once("exit", () => wrapper?.remove());
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      fail(new Error("OpenCode didn't start within 30 s"));
    }, START_TIMEOUT_MS);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void stopChild(child);
      reject(error);
    };
    const read = (bytes: Buffer) => {
      if (settled) return;
      output = (output + bytes.toString("utf8")).slice(-4096);
      const url = listeningUrl(output);
      if (url === undefined) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        url,
        client: makeOpenCodeClient({ baseUrl: url, password }),
        pid: child.pid,
        alive: () => child.exitCode === null && child.signalCode === null,
        stop: () => stopChild(child),
      });
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("error", (error) => {
      wrapper?.remove();
      fail(error);
    });
    child.once("exit", (code) => {
      // The last lines, never the environment: they say why it didn't start.
      const tail = output.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      fail(
        new Error(
          `OpenCode exited (${code ?? "signal"}) before it started${tail ? `: ${tail}` : ""}`,
        ),
      );
    });
  });
