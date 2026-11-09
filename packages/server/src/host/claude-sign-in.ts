import { execFile } from "node:child_process";
import type { AgentHost } from "@gram/agents";
import {
  type AgentUnavailable,
  type AgentUnavailableReason,
  type ClaudeSignIn,
  type HostId,
  type HostStatus,
  type HostTool,
  InvalidState,
  LOCAL_HOST_ID,
  type TerminalOpened,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { parseToolVersion } from "../launch-checks/checks.ts";
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
      const version = parseToolVersion(stdout);
      return { tool, found: true, ...(version === undefined ? {} : { version }) };
    },
    () => ({ tool, found: false }),
  );

/**
 * What this machine can run: its Claude sign-in and whether `claude` and `git` are there. A Claude
 * that answered about its sign-in is installed, whatever the login shell's PATH says.
 */
export const hostStatusOf = (
  signIn: Effect.Effect<ClaudeSignIn>,
  run: ShellRun = loginShell,
): Effect.Effect<HostStatus> =>
  Effect.gen(function* () {
    const [claudeSignIn, claude, git] = yield* Effect.all(
      [
        signIn,
        Effect.promise(() => probeTool("claude", run)),
        Effect.promise(() => probeTool("git", run)),
      ],
      { concurrency: "unbounded" },
    );
    const claudeTool = claudeSignIn === "unknown" ? claude : { ...claude, found: true };
    return { claudeSignIn, tools: [claudeTool, git] };
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
 * request could have said about where or what. The line is typed for the user, who runs it.
 */
export const openSignInTerminal = (
  terminals: Pick<Terminals, "open" | "input">,
  hostId: HostId,
  request: {
    readonly cols: number;
    readonly rows: number;
    readonly threadId?: unknown;
    readonly cwd?: unknown;
    readonly shell?: unknown;
    readonly script?: unknown;
  },
): Effect.Effect<TerminalOpened, InvalidState | Effect.Error<ReturnType<Terminals["open"]>>> =>
  request.threadId !== undefined ||
  request.cwd !== undefined ||
  request.shell !== undefined ||
  request.script !== undefined ||
  hostId === LOCAL_HOST_ID
    ? Effect.fail(
        new InvalidState({ message: "A sign-in terminal opens on a joined machine alone." }),
      )
    : Effect.gen(function* () {
        const { typed, ...where } = machineSignInTerminal(hostId);
        const opened = yield* terminals.open({ ...where, cols: request.cols, rows: request.rows });
        // Typed, not run: the user reads the line and runs it with Return. The pty holds it
        // until the shell reads its first line.
        yield* terminals.input(opened.terminalId, typed).pipe(Effect.ignore);
        return opened;
      });
