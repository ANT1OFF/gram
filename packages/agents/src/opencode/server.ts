import { randomBytes } from "node:crypto";

import { spawnServe, stopChild } from "../child-process.ts";
import { makeOpenCodeClient, type OpenCodeClient } from "./client.ts";

/** How long `opencode serve` gets to say where it listens. */
const START_TIMEOUT_MS = 30_000;

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
  /** The server's whole environment; the password is added here. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

/** `server listening on http://127.0.0.1:<port>`, the line `opencode serve` prints first. */
export const listeningUrl = (line: string): string | undefined =>
  /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(line)?.[1];

/**
 * Starts `opencode serve` on a free loopback port. The password is random and goes only into the
 * child's environment and this process's client, so nothing else on the machine can drive it.
 * OpenCode doesn't update itself under Gram.
 */
export const startOpenCodeServer = ({
  binary,
  env,
  cwd,
}: StartOpenCodeServer): Promise<OpenCodeServer> =>
  new Promise((resolve, reject) => {
    const password = randomBytes(24).toString("base64url");
    const child = spawnServe(
      binary,
      ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      { ...env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: "1" },
      cwd === undefined ? {} : { cwd },
    );
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
    child.once("error", (error) => fail(error));
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
