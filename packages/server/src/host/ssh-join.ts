import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";

/**
 * Adding a machine you can already SSH to, from the main Gram: it runs this Gram's installer there
 * over your own SSH (`ssh -o BatchMode=yes`, so only keys and the agent, never a password prompt),
 * with the join link inside the script on the session's stdin, so it reaches no command line or
 * shell history on either machine. The installer prints the new key's fingerprint into the session;
 * the caller compares it with the key that joined, which is the check a person would otherwise make
 * by eye, over a channel only the person's own SSH could open.
 */

/** `[user@]host` as `ssh` takes it, or a `Host` alias from the SSH config; never an option. */
export const SSH_TARGET = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** How long a join may take: the release download is the slow part. */
const SSH_JOIN_TIMEOUT_MS = 10 * 60_000;
/** How much of the session's output is kept for a failure's message. */
const OUTPUT_KEPT = 4_000;

/**
 * The command the remote side runs: the user's own login shell, so its PATH is the one their
 * terminal has (Homebrew, `~/.local/bin`), which the service then keeps; and `sh -s` reads the
 * installer from stdin. Quoted for any login shell, fish included.
 */
const REMOTE_COMMAND = `sh -c 'exec "\${SHELL:-/bin/sh}" -l -c "exec sh -s"'`;

export class SshJoinFailed extends Error {
  /** The end of what the session printed, for the person to read. */
  readonly output: string;
  constructor(message: string, output: string) {
    super(message);
    this.output = output;
  }
}

/** The session's output as text a person reads: no colour codes, progress bars or blank lines. */
export const readableOutput = (raw: string): string =>
  raw
    // eslint-disable-next-line no-control-regex
    .replaceAll(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => line.split("\r").at(-1)?.trimEnd() ?? "")
    .filter((line) => line !== "" && !/^#+\s*\d*(?:\.\d+)?%?$/.test(line))
    .join("\n")
    .slice(-OUTPUT_KEPT);

/** The fingerprint `gram-host join` printed, when it got that far. */
export const printedFingerprint = (output: string): string | undefined =>
  /^Fingerprint: ([0-9A-F]{4}(?:-[0-9A-F]{4}){4})$/m.exec(output)?.[1];

/** Runs `script` on `target` over SSH; its output, or why it failed. */
export const runOverSsh = (
  target: string,
  script: string,
  options: { readonly ssh?: string; readonly timeoutMs?: number } = {},
): Effect.Effect<string, SshJoinFailed> =>
  Effect.callback<string, SshJoinFailed>((answer) => {
    // A failed spawn emits both `error` and `close`: the first answer stands.
    let answered = false;
    const resume = (result: Effect.Effect<string, SshJoinFailed>) => {
      if (answered) return;
      answered = true;
      answer(result);
    };
    if (!SSH_TARGET.test(target)) {
      resume(Effect.fail(new SshJoinFailed("That isn't a host to SSH to.", "")));
      return;
    }
    const child = spawn(
      options.ssh ?? "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=30",
        "-T",
        "--",
        target,
        REMOTE_COMMAND,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4 * OUTPUT_KEPT);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    // ssh catches SIGTERM and exits 255 itself, so the timeout is remembered rather than read from
    // the exit; one that ignores it is killed a few seconds later.
    let timedOut = false;
    let kill: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, options.timeoutMs ?? SSH_JOIN_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resume(
        Effect.fail(
          new SshJoinFailed(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "ssh isn't installed on this computer."
              : `ssh didn't start: ${error.message}`,
            "",
          ),
        ),
      );
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(kill);
      const text = readableOutput(output);
      if (code === 0) resume(Effect.succeed(text));
      else
        resume(
          Effect.fail(
            new SshJoinFailed(
              timedOut
                ? "The install over SSH took too long and was stopped. It may still finish there: check Settings → Machines before you confirm a machine."
                : code === 255
                  ? `Couldn't connect to ${target} over SSH. Gram uses your SSH keys or agent, never a password: check that \`ssh ${target}\` works without one.`
                  : `The install on ${target} stopped (exit ${code ?? signal}).`,
              text,
            ),
          ),
        );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(script);
    return Effect.sync(() => {
      clearTimeout(timer);
      child.kill("SIGTERM");
    });
  });

/** The `Host` aliases in the user's SSH config, without patterns, for the picker. */
export const sshConfigHosts = (home = homedir()): ReadonlyArray<string> => {
  let text: string;
  try {
    text = readFileSync(join(home, ".ssh", "config"), "utf8");
  } catch {
    return [];
  }
  const hosts = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^\s*Host\s+(.+)$/i.exec(line);
    if (match === null) continue;
    for (const name of match[1]!.trim().split(/\s+/))
      if (!/[*?!]/.test(name) && SSH_TARGET.test(name)) hosts.add(name);
  }
  return [...hosts].slice(0, 100);
};
