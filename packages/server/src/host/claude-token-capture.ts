// Running `claude setup-token` on this machine for the joined machines the user picked, with their
// consent, and sending each the token it prints. See docs/design/machine-setup-token.md.
//
// The token is the one credential Gram ever handles, and only here: it is read from the command's
// output, held as `Redacted` until each machine has answered, and dropped. The command's output
// never leaves this module: the page sees only the sign-in link, whether a code is asked for, and
// each machine's result.

import { homedir } from "node:os";
import type { HostFailed } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Redacted from "effect/Redacted";
import { spawn } from "node-pty";
import { ensureSpawnHelperExecutable } from "../terminal/spawn-helper.ts";

/** The `claude setup-token` process, as the capture drives it. */
export interface SetupTokenProcess {
  readonly onData: (listener: (data: string) => void) => void;
  readonly onExit: (listener: () => void) => void;
  readonly write: (data: string) => void;
  readonly kill: () => void;
}

export type StartSetupToken = () => SetupTokenProcess;

/** Wide enough that the token, and the sign-in link, print on one line each. */
const COLUMNS = 1000;

/**
 * Starts `claude setup-token` in a pseudo-terminal in the user's login shell, as a terminal they
 * opened would: their own `claude` on their own PATH. Any `CLAUDE_CODE_OAUTH_TOKEN` in Gram's
 * environment is left out, so the command signs in afresh.
 */
export const startSetupTokenPty: StartSetupToken = () => {
  ensureSpawnHelperExecutable();
  const shell = process.env["SHELL"] ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name === "CLAUDE_CODE_OAUTH_TOKEN" || name === "ELECTRON_RUN_AS_NODE") continue;
    env[name] = value;
  }
  env["TERM"] = "xterm-256color";
  const pty = spawn(shell, ["-ilc", "exec claude setup-token"], {
    name: "xterm-256color",
    cols: COLUMNS,
    rows: 40,
    cwd: homedir(),
    env,
  });
  return {
    onData: (listener) => {
      pty.onData(listener);
    },
    onExit: (listener) => {
      pty.onExit(() => listener());
    },
    write: (data) => pty.write(data),
    kill: () => {
      try {
        pty.kill();
      } catch {
        // Already gone.
      }
    },
  };
};

/** How much of the command's output is kept to scan, at most. */
const OUTPUT_KEPT = 64 * 1024;

/** A token as `claude setup-token` prints it, ended by something that can't be part of it. */
const TOKEN_ENDED = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,1000}(?=[^A-Za-z0-9_-])/;
/** The same, at the very end of the output, once the command has exited. */
const TOKEN_AT_END = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,1000}$/;
/** The browser sign-in link it prints for when the browser didn't open. */
// oxlint-disable-next-line no-control-regex -- the link ends at a terminal escape
const SIGN_IN_LINK = /https:\/\/[^\s"'<>\u0007\u001b]*(?:oauth|authorize)[^\s"'<>\u0007\u001b]*/i;
/** Its prompt for the code a browser shows when it can't redirect back. */
const CODE_PROMPT = /paste\s+(?:the\s+)?code/i;

/** Cursor moves stand for space between words; every other escape is dropped. */
// oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
const MOVES = /\u001b\[[0-9;?]*[ABCDGHJKf]/g;
const ESCAPES =
  // oxlint-disable-next-line no-control-regex -- matching escape sequences is the point
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** `output` as text: its terminal escapes gone, cursor moves read as spaces. */
export const plainOutput = (output: string): string =>
  output.replace(MOVES, " ").replace(ESCAPES, "");

/** What the output so far says: the sign-in link, a code asked for, and the token once whole. */
export const scanSetupTokenOutput = (
  output: string,
  exited = false,
): {
  readonly token?: string;
  readonly signInLink?: string;
  readonly asksForCode: boolean;
} => {
  const text = plainOutput(output);
  const token = (TOKEN_ENDED.exec(text) ?? (exited ? TOKEN_AT_END.exec(text) : null))?.[0];
  const link = SIGN_IN_LINK.exec(text)?.[0];
  return {
    ...(token === undefined ? {} : { token }),
    ...(link === undefined ? {} : { signInLink: link }),
    asksForCode: CODE_PROMPT.test(text),
  };
};

/** One machine's answer once the token was sent. */
export interface TokenSent {
  readonly id: string;
  readonly ok: boolean;
  /** Why it didn't take it; never the token. */
  readonly message?: string;
}

/** A run as the page sees it. */
export type CaptureView =
  | {
      readonly state: "waiting";
      readonly signInLink?: string;
      readonly asksForCode: boolean;
    }
  | { readonly state: "sending" }
  | { readonly state: "done"; readonly results: ReadonlyArray<TokenSent> }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "cancelled" };

export interface ClaudeTokenCaptureDeps {
  readonly start?: StartSetupToken;
  /** Sends the token to one machine over its own connection; its failure never carries it. */
  readonly send: (id: string, token: Redacted.Redacted<string>) => Effect.Effect<void, HostFailed>;
  /** Records that the machine took a token. */
  readonly sent: (id: string) => void;
  /** How long a run waits for the token; ten minutes unless a test says otherwise. */
  readonly timeoutMs?: number;
}

export const CAPTURE_TIMEOUT_MS = 10 * 60_000;

const NO_TOKEN =
  "`claude setup-token` ended without printing a token, so nothing was sent. Is Claude Code installed and on your PATH, and did you approve it in the browser?";
const TIMED_OUT = "No token came within 10 minutes, so nothing was sent.";
const DIDNT_START = "Couldn't start `claude setup-token` in your login shell, so nothing was sent.";

/**
 * One `claude setup-token` run at a time, for the machines the user consented to. A run's id is
 * random and known only to the page that started it. Sends run in the scope's fibers, with its
 * services, so their logs go where the server's do; closing the scope stops a run.
 */
export const makeClaudeTokenCapture = Effect.fnUntraced(function* (deps: ClaudeTokenCaptureDeps) {
  const fork = yield* FiberSet.makeRuntime<never>();
  const start = deps.start ?? startSetupTokenPty;
  const timeoutMs = deps.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  interface Run {
    readonly id: string;
    view: CaptureView;
    process: SetupTokenProcess | undefined;
    timer: ReturnType<typeof setTimeout> | undefined;
  }
  let run: Run | undefined;
  const live = (r: Run) => r.view.state === "waiting" || r.view.state === "sending";
  const stop = (r: Run) => {
    if (r.timer !== undefined) clearTimeout(r.timer);
    r.timer = undefined;
    const process = r.process;
    r.process = undefined;
    process?.kill();
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (run !== undefined) stop(run);
    }),
  );
  return {
    /** Whether a run is waiting for its token or sending it. */
    busy: () => run !== undefined && live(run),
    /**
     * Starts a run for `machineIds`, which the caller checked are confirmed, online and consented
     * to. Effects run with the caller's services, so their logs go where the server's do.
     */
    begin: (machineIds: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const r: Run = {
          id: crypto.randomUUID(),
          view: { state: "waiting", asksForCode: false },
          process: undefined,
          timer: undefined,
        };
        run = r;
        let output = "";
        const finish = (view: CaptureView) => {
          if (!live(r)) return;
          r.view = view;
          output = "";
          stop(r);
        };
        const send = (token: Redacted.Redacted<string>) => {
          r.view = { state: "sending" };
          output = "";
          stop(r);
          fork(
            Effect.forEach(
              machineIds,
              (id) =>
                deps.send(id, token).pipe(
                  Effect.map((): TokenSent => {
                    try {
                      deps.sent(id);
                    } catch {
                      // The record is for Settings' warning; the machine has the token either way.
                    }
                    return { id, ok: true };
                  }),
                  Effect.catch((error) =>
                    Effect.succeed<TokenSent>({ id, ok: false, message: error.message }),
                  ),
                ),
              { concurrency: "unbounded" },
            ).pipe(
              Effect.tap((results) =>
                Effect.sync(() => {
                  if (r.view.state === "sending") r.view = { state: "done", results };
                }),
              ),
              Effect.tap((results) =>
                Effect.logInfo("machines: sent a Claude token").pipe(
                  Effect.annotateLogs({
                    machines: results.length,
                    took: results.filter((result) => result.ok).length,
                  }),
                ),
              ),
            ),
          );
        };
        const scan = (exited: boolean) => {
          if (r.view.state !== "waiting") return;
          const found = scanSetupTokenOutput(output, exited);
          if (found.token !== undefined) return send(Redacted.make(found.token));
          if (exited) return finish({ state: "failed", message: NO_TOKEN });
          r.view = {
            state: "waiting",
            ...(found.signInLink === undefined ? {} : { signInLink: found.signInLink }),
            asksForCode: found.asksForCode,
          };
        };
        try {
          r.process = start();
        } catch {
          r.view = { state: "failed", message: DIDNT_START };
          return { captureId: r.id };
        }
        r.process.onData((data) => {
          if (r.view.state !== "waiting") return;
          output = (output + data).slice(-OUTPUT_KEPT);
          scan(false);
        });
        r.process.onExit(() => {
          r.process = undefined;
          scan(true);
        });
        r.timer = setTimeout(() => finish({ state: "failed", message: TIMED_OUT }), timeoutMs);
        yield* Effect.logInfo("machines: started claude setup-token").pipe(
          Effect.annotateLogs({ machines: machineIds.length }),
        );
        return { captureId: r.id };
      }),
    /** The run's state, or undefined for a run that isn't the current one. */
    view: (captureId: string): CaptureView | undefined =>
      run !== undefined && run.id === captureId ? run.view : undefined,
    /** Types the code the browser showed into the command; false when it isn't waiting. */
    answer: (captureId: string, code: string): boolean => {
      if (run === undefined || run.id !== captureId || run.view.state !== "waiting") return false;
      if (run.process === undefined) return false;
      run.process.write(`${code}\r`);
      return true;
    },
    /** Stops a run still waiting for its token; one already sending finishes. */
    cancel: (captureId: string): boolean => {
      if (run === undefined || run.id !== captureId || run.view.state !== "waiting") return false;
      run.view = { state: "cancelled" };
      stop(run);
      return true;
    },
  };
});

export type ClaudeTokenCapture = Effect.Success<ReturnType<typeof makeClaudeTokenCapture>>;
