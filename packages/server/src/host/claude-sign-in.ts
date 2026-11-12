import { execFile } from "node:child_process";
import type { AgentHost } from "@gram/agents";
import {
  type AgentUnavailable,
  type AgentUnavailableReason,
  type ClaudeSignIn,
  type HostId,
  type AgentModel,
  type HostModel,
  type HostStatus,
  type HostTool,
  InvalidState,
  LOCAL_HOST_ID,
  type TerminalOpened,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { parseToolVersion } from "../launch-checks/checks.ts";
import { NOT_YOUR_MACHINE } from "./ownership.ts";
import type { Terminals } from "../terminal/terminals.ts";

const BY_REASON: Partial<Record<AgentUnavailableReason, ClaudeSignIn>> = {
  "not-logged-in": "notSignedIn",
  "api-key-auth": "apiKey",
  "third-party-provider": "thirdParty",
};

/** What a failed readiness check says about the sign-in; anything but an auth answer is unknown. */
export const signInOfUnavailable = (error: AgentUnavailable): ClaudeSignIn =>
  (error.reason === undefined ? undefined : BY_REASON[error.reason]) ?? "unknown";

/**
 * This machine's Claude Code sign-in, from the agent's own fresh readiness check (its
 * `claude auth status --json`). Only the classification leaves: never the command's output, and
 * nothing here reads a credential.
 */
export const claudeSignInOf = (claude: AgentHost): Effect.Effect<ClaudeSignIn> =>
  claude.checkWorkspaceSwitch === undefined
    ? Effect.succeed("unknown")
    : claude.checkWorkspaceSwitch.pipe(
        Effect.as("signedIn" as const),
        Effect.catch((error) => Effect.succeed(signInOfUnavailable(error))),
      );

/** How long one tool's lookup gets in the login shell. */
const PROBE_TIMEOUT_MS = 10_000;

/** Runs `script` in a non-interactive login shell: its exit code and what it printed. */
export type ShellRun = (
  script: string,
) => Promise<{ readonly code: number; readonly stdout: string }>;

/** The user's own shell, as a login shell that reads no rc meant for a terminal. */
export const loginShell: ShellRun = (script) =>
  new Promise((resolve) => {
    execFile(
      process.env["SHELL"] ?? "/bin/sh",
      ["-lc", script],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024, env: process.env },
      (error, stdout) =>
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout: String(stdout),
        }),
    );
  });

/**
 * Whether `tool` is on the machine's login-shell PATH, and its version. The name comes from a
 * fixed list, never from the caller, so nothing is spliced into the script.
 */
export const probeTool = (tool: HostTool["tool"], run: ShellRun = loginShell): Promise<HostTool> =>
  run(`command -v ${tool} >/dev/null 2>&1 && ${tool} --version`).then(
    ({ code, stdout }) => {
      if (code !== 0) return { tool, found: false };
      // Within what the wire takes: one odd `--version` mustn't lose the whole status.
      const version = parseToolVersion(stdout)?.slice(0, 64);
      return { tool, found: true, ...(version === undefined ? {} : { version }) };
    },
    () => ({ tool, found: false }),
  );

/** How many listed models a status carries, and how long each string may be, as the wire takes. */
const MODELS_SENT = 64;
const MODEL_TEXT = 128;

/** A listed model as `HostStatus.models` carries it: identity, name and efforts, cut to the wire. */
export const hostModelOf = (model: AgentModel): HostModel => ({
  id: model.id.slice(0, MODEL_TEXT),
  displayName: model.displayName.slice(0, MODEL_TEXT),
  ...(model.resolvedId === undefined ? {} : { resolvedId: model.resolvedId.slice(0, MODEL_TEXT) }),
  supportsEffort: model.supportsEffort,
  ...(model.efforts === undefined ? {} : { efforts: model.efforts.slice(0, 8) }),
});

/**
 * What this machine can run: its Claude sign-in, whether `claude` and `git` are there, and what
 * its Claude Code lists (`models`, when it could list). A Claude that answered about its sign-in
 * is installed, whatever the login shell's PATH says.
 */
export const hostStatusOf = (
  signIn: Effect.Effect<ClaudeSignIn>,
  run: ShellRun = loginShell,
  models: Effect.Effect<ReadonlyArray<AgentModel> | undefined> = Effect.succeed(undefined),
): Effect.Effect<HostStatus> =>
  Effect.gen(function* () {
    const [claudeSignIn, claude, git, listed] = yield* Effect.all(
      [
        signIn,
        Effect.promise(() => probeTool("claude", run)),
        Effect.promise(() => probeTool("git", run)),
        models,
      ],
      { concurrency: "unbounded" },
    );
    const claudeTool = claudeSignIn === "unknown" ? claude : { ...claude, found: true };
    return {
      claudeSignIn,
      tools: [claudeTool, git],
      // An empty list is a fact (nothing runs here); only a listing that failed sends no key.
      ...(listed === undefined ? {} : { models: listed.slice(0, MODELS_SENT).map(hostModelOf) }),
    };
  });

/** The line the Sign in terminal types for the user, who runs it with Return. */
export const CLAUDE_SIGN_IN_COMMAND = "claude /login";

/**
 * The Sign in terminal: a shell on `hostId`, in that machine's home folder, with
 * `CLAUDE_SIGN_IN_COMMAND` typed but not run, so the user sees what runs before it does.
 */
export const machineSignInTerminal = (hostId: HostId) => ({
  hostId,
  // Expanded by the machine's own host, to its own home.
  cwd: "~",
  typed: CLAUDE_SIGN_IN_COMMAND,
});

/**
 * `terminal.open`'s `signIn`: the Sign in terminal on that joined machine, with nothing else the
 * request could have said about where or what. `machine` must find it as a joined machine's own
 * host, so a server without their routing refuses rather than opening the shell here. The line is
 * typed for the user, who runs it.
 */
export const openSignInTerminal = (
  terminals: Pick<Terminals, "open" | "input">,
  machine: (id: HostId) => Effect.Effect<{ readonly id: HostId }, unknown>,
  hostId: HostId,
  request: {
    readonly cols: number;
    readonly rows: number;
    readonly threadId?: unknown;
    readonly cwd?: unknown;
    readonly shell?: unknown;
    readonly script?: unknown;
  },
): Effect.Effect<TerminalOpened, InvalidState | Effect.Error<ReturnType<Terminals["open"]>>> => {
  const refused = new InvalidState({
    message: "A sign-in terminal opens on a joined machine alone.",
  });
  if (
    request.threadId !== undefined ||
    request.cwd !== undefined ||
    request.shell !== undefined ||
    request.script !== undefined ||
    hostId === LOCAL_HOST_ID
  )
    return Effect.fail(refused);
  return Effect.gen(function* () {
    const host = yield* machine(hostId).pipe(
      Effect.mapError(
        (error) =>
          new InvalidState({
            // Another person's machine says so (`ownership.ts`), whether or not it is online.
            message:
              (error as { readonly message?: unknown } | undefined)?.message === NOT_YOUR_MACHINE
                ? NOT_YOUR_MACHINE
                : "That machine isn't joined and online, so it can't sign in now.",
          }),
      ),
    );
    if (host.id !== hostId || host.id === LOCAL_HOST_ID) return yield* refused;
    const { typed, ...where } = machineSignInTerminal(hostId);
    const opened = yield* terminals.open({ ...where, cols: request.cols, rows: request.rows });
    // Typed, not run: the user reads the line and runs it with Return. The pty holds it until
    // the shell reads its first line.
    yield* terminals.input(opened.terminalId, typed).pipe(Effect.ignore);
    return opened;
  });
};
