import { AgentUnavailable, isWindowsBatchFile } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { win32 } from "node:path";
import {
  probeScript,
  resolveBinary as resolveExecutable,
  type BinaryFs,
} from "../cli/discovery.ts";

// These names remain available to consumers of the Claude adapter.
export {
  classifyExecutable,
  parseCliVersion,
  parseProbeOutput,
  pathCandidates,
  type BinaryFs,
} from "../cli/discovery.ts";
export const PROBE_SCRIPT = probeScript("claude");

/** Preserves Claude's public startup-error contract at the adapter boundary. */
export const resolveBinary = (candidates: ReadonlyArray<string>, fs: BinaryFs) =>
  resolveExecutable(candidates, fs).pipe(
    Effect.mapError(
      (error) =>
        new AgentUnavailable({
          agent: "claude",
          reason: "claude-not-found",
          message: `No claude executable on the login-shell PATH${error.skipped.length === 0 ? "" : ` (skipped: ${error.skipped.map((s) => s.path).join(", ")})`}`,
        }),
    ),
  );

/**
 * The native executable a cmd-shim runs, from the line that invokes it: npm writes
 * `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*`, pnpm and yarn
 * `@"%~dp0\..\claude-code\bin\claude.exe"   %*`, both relative to the shim's folder. A shim that
 * runs a script through `node` has no such line, so it gives nothing.
 */
export const npmShimTarget = (shimPath: string, contents: string): string | undefined => {
  const relative = /^@?"%(?:dp0%|~dp0)\\([^"]+\.exe)"\s+%\*\s*$/im.exec(contents)?.[1];
  return relative === undefined ? undefined : win32.join(win32.dirname(shimPath), relative);
};

/**
 * The installed CLI as the SDK's `pathToClaudeCodeExecutable`. Agent SDK 0.3.272 spawns that path
 * directly and expects a native binary, so a Windows `.cmd` shim (npm's global install) is swapped
 * for the `claude.exe` it runs, read from `shimContents`. Without one the SDK falls back to the
 * native CLI it bundles (`claude-agent-sdk-win32-*`), which a packaged app leaves out. Commands we
 * run ourselves (`--version`, `auth status`) still use the shim, through `cmd.exe`.
 */
export const sdkExecutablePath = (
  binaryPath: string,
  platform: NodeJS.Platform,
  shimContents?: string,
): string | undefined => {
  if (platform !== "win32" || !isWindowsBatchFile(binaryPath)) return binaryPath;
  return shimContents === undefined ? undefined : npmShimTarget(binaryPath, shimContents);
};

/** Enough of a cmd-shim to reach its invocation line. */
const SHIM_HEAD_BYTES = 4096;

/**
 * `sdkExecutablePath` for a resolved binary, reading a Windows shim and checking the exe it names
 * exists. Undefined when the SDK has to fall back to the CLI it bundles.
 */
export const resolveSdkExecutable = (
  binaryPath: string,
  platform: NodeJS.Platform,
  fs: BinaryFs,
): Effect.Effect<string | undefined> => {
  const direct = sdkExecutablePath(binaryPath, platform);
  if (direct !== undefined) return Effect.succeed(direct);
  return fs.readHead(binaryPath, SHIM_HEAD_BYTES).pipe(
    Effect.map((head) => sdkExecutablePath(binaryPath, platform, new TextDecoder().decode(head))),
    Effect.flatMap((target) =>
      target === undefined ? Effect.succeed(undefined) : fs.realpath(target),
    ),
    // An unreadable shim, or one naming an exe that isn't there, leaves the SDK its bundled CLI.
    Effect.orElseSucceed(() => undefined),
  );
};

/**
 * `resolveSdkExecutable`, failing with `claude-not-found` when it leaves the SDK a bundled CLI that
 * `hasBundledCli` says isn't there: the CLI answers `--version`, but no thread can start from it.
 */
export const requireSdkExecutable = (
  binaryPath: string,
  platform: NodeJS.Platform,
  fs: BinaryFs,
  hasBundledCli: () => boolean,
): Effect.Effect<string | undefined, AgentUnavailable> =>
  resolveSdkExecutable(binaryPath, platform, fs).pipe(
    Effect.flatMap((executable) =>
      executable !== undefined || hasBundledCli()
        ? Effect.succeed(executable)
        : Effect.fail(
            new AgentUnavailable({
              agent: "claude",
              reason: "claude-not-found",
              message: `${binaryPath} doesn't run a native claude.exe, which Claude threads need. Reinstall Claude Code with its native installer, or with a current npm package.`,
            }),
          ),
    ),
  );

/** Agent SDK 0.3.N bundles CLI 2.1.N. */
export const expectedCliVersion = (sdkVersion: string): string | undefined => {
  const match = /^0\.3\.(\d+)/.exec(sdkVersion);
  return match ? `2.1.${match[1]}` : undefined;
};

/** How far ahead of the SDK's matched CLI an installed CLI may be before we warn. */
const MAX_NEWER_PATCHES = 10;

const semver = (version: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : undefined;
};

/** Headless Fast settings require Claude Code 2.1.205; unknown versions fail closed. */
export const supportsFastControl = (cliVersion: string | undefined): boolean => {
  const cli = cliVersion === undefined ? undefined : semver(cliVersion);
  return (
    cli !== undefined &&
    (cli.major !== 2 ? cli.major > 2 : cli.minor !== 1 ? cli.minor > 1 : cli.patch >= 205)
  );
};

/**
 * Claude Code 2.1.277 and later carry a resumed or forked session's `total_cost_usd` on from the
 * total its transcript saved; earlier ones count from zero. An unreadable version is taken to be a
 * current CLI.
 */
export const restoresSessionCost = (cliVersion: string | undefined): boolean => {
  const cli = cliVersion === undefined ? undefined : semver(cliVersion);
  if (cli === undefined) return true;
  return cli.major !== 2 ? cli.major > 2 : cli.minor !== 1 ? cli.minor > 1 : cli.patch >= 277;
};

/**
 * A warning for skew likely to matter: a CLI older than the SDK's matched CLI, more than
 * `MAX_NEWER_PATCHES` newer, or on a different major/minor. Never a failure.
 */
export const versionWarning = (cliVersion: string, sdkVersion: string): string | undefined => {
  const expected = expectedCliVersion(sdkVersion);
  const cli = semver(cliVersion);
  const matched = expected === undefined ? undefined : semver(expected);
  if (cli === undefined || matched === undefined) return undefined;
  const sameLine = cli.major === matched.major && cli.minor === matched.minor;
  const ahead = cli.patch - matched.patch;
  if (sameLine && ahead >= 0 && ahead <= MAX_NEWER_PATCHES) return undefined;
  const relation = !sameLine
    ? "on a different release line than"
    : ahead < 0
      ? "older than"
      : "much newer than";
  return `Claude Code ${cliVersion} is ${relation} ${expected}, which Agent SDK ${sdkVersion} is built for; some features may misbehave.`;
};

export type AuthProblem = "not-logged-in" | "api-key-auth" | "third-party-provider" | "unparseable";

/**
 * The `authMethod` values that mean an OAuth subscription login. The field carries the CLI's auth
 * *source*, not a token type: `claude.ai` is the ordinary `claude /login`, the others are an OAuth
 * token handed over by the environment, a file descriptor, or a CCR host. The environment's token
 * reads `oauth_token` from Claude Code 2.1.28x (older ones named the variable). These sources
 * include `claude setup-token` users. Other values this adapter recognizes —
 * `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, `profile` (WIF), `none` — is a key or token Gram
 * doesn't accept.
 */
const OAUTH_METHODS: ReadonlySet<string> = new Set([
  "claude.ai",
  "oauth_token",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CCR_OAUTH_TOKEN_FILE",
]);

/** Checks `claude auth status --json`: subscription (OAuth) against Anthropic, nothing else. */
export const checkAuthStatus = (stdout: string): AuthProblem | undefined => {
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch {
    return "unparseable";
  }
  if (typeof status !== "object" || status === null) return "unparseable";
  const { loggedIn, authMethod, apiProvider } = status as Record<string, unknown>;
  if (loggedIn !== true) return "not-logged-in";
  if (apiProvider !== undefined && apiProvider !== "firstParty") return "third-party-provider";
  return typeof authMethod === "string" && OAUTH_METHODS.has(authMethod)
    ? undefined
    : "api-key-auth";
};

const AUTH_MESSAGES: Record<AuthProblem, string> = {
  "not-logged-in": "Claude Code isn't logged in. Run `claude /login`.",
  "api-key-auth": "Claude Code is using API-key auth; Gram requires your subscription login.",
  "third-party-provider": "Claude Code is configured for a third-party API provider.",
  unparseable: "Couldn't read `claude auth status --json`.",
};

export const authUnavailable = (problem: AuthProblem): AgentUnavailable =>
  new AgentUnavailable({
    agent: "claude",
    reason: problem === "unparseable" ? "auth-status-failed" : problem,
    message: AUTH_MESSAGES[problem],
  });
