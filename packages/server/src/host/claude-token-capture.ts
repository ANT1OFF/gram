// Running `claude setup-token` on this machine for the joined machines the user picked, with their
// consent, and sending each the token it prints. See docs/design/machine-setup-token.md.
//
// The token is the one credential Gram ever handles, and only here: it is read from the output of
// the `claude setup-token` process itself, held as `Redacted` until each machine has answered, and
// dropped. The command's output never leaves this module: the page sees only Claude's own sign-in
// link, whether a code is asked for, and each machine's result.

import { homedir } from "node:os";
import { resolveClaudeCli, tokenChildEnv } from "@gram/agents/claude";
import { type HostFailed, redactText } from "@gram/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
 * Starts `claude setup-token` itself in a pseudo-terminal: the `claude` a session would use, found
 * through the user's login shell, but launched directly, so nothing the shell prints at startup is
 * ever read as its output. Its env is the login shell's without anything that could attach a
 * debugger, preload code or log its requests, and without any OAuth token already set
 * (`tokenChildEnv`), so it signs in afresh.
 */
export const launchSetupToken: Effect.Effect<SetupTokenProcess, unknown> = Effect.gen(function* () {
  const cli = yield* resolveClaudeCli();
  return yield* Effect.try(() => {
    ensureSpawnHelperExecutable();
    const pty = spawn(cli.binaryPath, ["setup-token"], {
      name: "xterm-256color",
      cols: COLUMNS,
      rows: 40,
      cwd: homedir(),
      env: { ...tokenChildEnv(cli.env), TERM: "xterm-256color" },
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
    } satisfies SetupTokenProcess;
  });
});

/** How much of the command's output is kept to scan, at most. */
const OUTPUT_KEPT = 64 * 1024;

/** A token as `claude setup-token` prints it, ended by something that can't be part of it. */
const TOKEN_ENDED = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,1000}(?=[^A-Za-z0-9_-])/;
/** The same, at the very end of the output, once the command has exited. */
const TOKEN_AT_END = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,1000}$/;
/** Each https link in the output that is whole: followed by a space, a quote or an escape. */
// oxlint-disable-next-line no-control-regex -- the link ends at a terminal escape
const LINKS = /https:\/\/[^\s"'<>\u0007\u001b]+(?=[\s"'<>\u0007\u001b])/g;
/** Where Claude Code sends a sign-in: Claude's own authorization page, and nowhere else. */
const SIGN_IN_HOSTS = new Set(["claude.ai", "claude.com"]);
const SIGN_IN_PATHS = new Set(["/oauth/authorize", "/cai/oauth/authorize"]);
/** The query an OAuth authorization request carries, and nothing else. */
const SIGN_IN_QUERY = new Set([
  "code",
  "client_id",
  "response_type",
  "redirect_uri",
  "scope",
  "code_challenge",
  "code_challenge_method",
  "state",
]);

/**
 * `link` when it is Claude's own authorization page with an OAuth request's query and no token,
 * credentials or fragment in it; undefined for anything else, which the page is never shown.
 */
export const signInLinkOf = (link: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    !SIGN_IN_HOSTS.has(url.hostname) ||
    !SIGN_IN_PATHS.has(url.pathname) ||
    link.length > 4096 ||
    /sk-ant-/i.test(decodeURIComponent(link.replace(/%(?![0-9a-f]{2})/gi, "%25")))
  )
    return undefined;
  for (const [key, value] of url.searchParams) {
    if (
      !SIGN_IN_QUERY.has(key) ||
      value.length > 1024 ||
      [...value].some((char) => char.charCodeAt(0) < 0x20)
    )
      return undefined;
  }
  return url.href;
};

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
  const link = [...text.matchAll(LINKS)]
    .map((match) => signInLinkOf(match[0]))
    .find((valid) => valid !== undefined);
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
  /** A test's process; by default `launchSetupToken`. */
  readonly start?: StartSetupToken;
  /** Sends the token to one machine over its own connection; its failure never carries it. */
  readonly send: (id: string, token: Redacted.Redacted<string>) => Effect.Effect<void, HostFailed>;
  /**
   * Records, before anything is sent, that the machine may hold a token from now on, so Remove
   * deletes it even when the reply is lost. Throws when it can't, and then nothing is sent.
   */
  readonly mark: (id: string) => void;
  /**
   * Which join of the machine this is now (a machine that is removed and joins again with the same
   * key is a new join); undefined once it isn't joined. Consent is for the join it was given to.
   */
  readonly joinOf: (id: string) => string | undefined;
  /** How long a run waits for the token; ten minutes unless a test says otherwise. */
  readonly timeoutMs?: number;
}

export const CAPTURE_TIMEOUT_MS = 10 * 60_000;

const NO_TOKEN =
  "`claude setup-token` ended without printing a token, so nothing was sent. Is Claude Code installed and on your PATH, and did you approve it in the browser?";
const TIMED_OUT = "No token came within 10 minutes, so nothing was sent.";
const DIDNT_START =
  "Couldn't find or start `claude setup-token`, so nothing was sent. Is Claude Code installed and on your login shell's PATH?";
const NOT_THIS_JOIN = "It was removed or joined again after you agreed, so nothing was sent to it.";
const NOT_RECORDED = "Gram couldn't record that it would hold a token, so nothing was sent to it.";

/**
 * One `claude setup-token` run at a time, for the machines the user consented to. A run's id is
 * random and known only to the page that started it. Sends run in the scope's fibers, with its
 * services, so their logs go where the server's do; closing the scope stops a run.
 */
export const makeClaudeTokenCapture = Effect.fnUntraced(function* (deps: ClaudeTokenCaptureDeps) {
  const fork = yield* FiberSet.makeRuntime<never>();
  const start: Effect.Effect<SetupTokenProcess, unknown> =
    deps.start === undefined ? launchSetupToken : Effect.try(deps.start);
  const timeoutMs = deps.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  interface Run {
    readonly id: string;
    view: CaptureView;
    process: SetupTokenProcess | undefined;
    timer: ReturnType<typeof setTimeout> | undefined;
    /** Machines removed since consent: nothing more is sent to them in this run. */
    readonly dropped: Set<string>;
    /** Sends not yet answered, by machine. */
    readonly inFlight: Map<string, Deferred.Deferred<void>>;
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
          dropped: new Set(),
          inFlight: new Map(),
        };
        run = r;
        // Consent is for these joins: one removed and joined again since gets nothing.
        const targets = machineIds.map((id) => ({ id, join: deps.joinOf(id) }));
        let output = "";
        const finish = (view: CaptureView) => {
          if (!live(r)) return;
          r.view = view;
          output = "";
          stop(r);
        };
        const sendOne = (
          target: (typeof targets)[number],
          token: Redacted.Redacted<string>,
        ): Effect.Effect<TokenSent> =>
          Effect.suspend(() => {
            const { id } = target;
            if (target.join === undefined || r.dropped.has(id) || deps.joinOf(id) !== target.join)
              return Effect.succeed({ id, ok: false, message: NOT_THIS_JOIN });
            try {
              deps.mark(id);
            } catch {
              return Effect.succeed({ id, ok: false, message: NOT_RECORDED });
            }
            const answered = Deferred.makeUnsafe<void>();
            r.inFlight.set(id, answered);
            return deps.send(id, token).pipe(
              Effect.map((): TokenSent => ({ id, ok: true })),
              Effect.catch((error) =>
                Effect.succeed<TokenSent>({ id, ok: false, message: redactText(error.message) }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  r.inFlight.delete(id);
                  Deferred.doneUnsafe(answered, Exit.void);
                }),
              ),
            );
          });
        const send = (token: Redacted.Redacted<string>) => {
          r.view = { state: "sending" };
          output = "";
          stop(r);
          fork(
            Effect.forEach(targets, (target) => sendOne(target, token), {
              concurrency: "unbounded",
            }).pipe(
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
        const attach = (process: SetupTokenProcess) => {
          // Cancelled or timed out while it was starting.
          if (r.view.state !== "waiting") return process.kill();
          r.process = process;
          process.onData((data) => {
            if (r.view.state !== "waiting") return;
            output = (output + data).slice(-OUTPUT_KEPT);
            scan(false);
          });
          process.onExit(() => {
            r.process = undefined;
            scan(true);
          });
        };
        r.timer = setTimeout(() => finish({ state: "failed", message: TIMED_OUT }), timeoutMs);
        fork(
          start.pipe(
            Effect.matchEffect({
              onSuccess: (process) => Effect.sync(() => attach(process)),
              onFailure: () =>
                Effect.sync(() => finish({ state: "failed", message: DIDNT_START })).pipe(
                  Effect.andThen(Effect.logWarning("machines: claude setup-token didn't start")),
                ),
            }),
          ),
        );
        yield* Effect.logInfo("machines: started claude setup-token").pipe(
          Effect.annotateLogs({ machines: machineIds.length }),
        );
        return { captureId: r.id };
      }),
    /**
     * Waits for a send to `id` in flight to be answered, so a delete that follows lands after it.
     * With `drop`, for a machine being removed, nothing more is sent to it in this run.
     */
    settle: (id: string, options: { readonly drop: boolean }): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (run === undefined) return Effect.void;
        if (options.drop) run.dropped.add(id);
        const answered = run.inFlight.get(id);
        return answered === undefined ? Effect.void : Deferred.await(answered);
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
