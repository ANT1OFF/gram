import { checkAuthStatus, type AuthProblem } from "@gram/agents/claude";
import { CODEX_CLI_VERSION } from "@gram/agents/codex";
import type {
  ClaudeSignIn,
  CodexSignIn,
  AgentKind,
  GatewayAgentTool,
  LaunchChecks,
  LaunchTool,
  ModelRef,
  Settings,
  ShadowedInstall,
  Thread,
  ToolCheck,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { installerOf } from "../agent-runtime/policy.ts";

/** The machine, as the launch checks see it; tests inject their own. */
export interface LaunchProbe {
  /** The login-shell PATH. */
  readonly path: Effect.Effect<string>;
  /** Where `bin` resolves on `pathValue`, if anywhere. */
  readonly which: (bin: string, pathValue: string) => string | undefined;
  /**
   * The executable an agent session would start for `agent` on `pathValue`: the first that isn't a
   * shell wrapper (cmux's `claude`), as the adapters choose it. Absent: `which`.
   */
  readonly agentBinary?: (
    agent: "claude" | "codex",
    pathValue: string,
  ) => Effect.Effect<string | undefined>;
  /** Every place `bin` is on `pathValue`, in PATH order. */
  readonly whichAll: (bin: string, pathValue: string) => ReadonlyArray<string>;
  /** `path` with its symlinks resolved; `path` itself when that fails. */
  readonly realpath: (path: string) => string;
  /**
   * Why no Claude thread can start from the CLI at `path`, as a session's `prepare` decides it
   * (`claudeSdkExecutable`); undefined when one can.
   */
  readonly claudeUnusable: (path: string) => Effect.Effect<string | undefined>;
  /** Runs `file` to completion; spawn failures and timeouts are errors, a non-zero exit is not. */
  readonly run: (
    file: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<
    { readonly status: number; readonly stdout: string; readonly stderr?: string },
    unknown
  >;
  readonly now: () => number;
}

const TOOLS: ReadonlyArray<LaunchTool> = ["claude", "git", "gh", "codex"];

/** The version of each gateway agent's CLI that Gram's adapter is tested with. */
export const TESTED_VERSIONS: Readonly<Record<GatewayAgentTool, string>> = {
  codex: CODEX_CLI_VERSION,
};

const isGatewayAgentTool = (tool: LaunchTool): tool is GatewayAgentTool => tool in TESTED_VERSIONS;

/**
 * `git version 2.47.1`, `gh version 2.63.0 (2024-11-27)`, `2.1.273 (Claude Code)`: the first
 * `x.y.z`, keeping a prerelease suffix (`codex-cli 0.160.0-alpha.3`) so a preview CLI isn't judged
 * as the stable release it precedes.
 */
export const parseToolVersion = (output: string): string | undefined =>
  /(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)/.exec(output)?.[1];

/**
 * The command that brings `tool` to `version`, matching how the binary at `resolved` (symlinks
 * resolved) was installed: Homebrew, npm, or Codex's native updater. npm
 * when it isn't installed at all.
 */
export const upgradeCommand = (
  tool: GatewayAgentTool,
  resolved: string | undefined,
  version: string,
): string | undefined => {
  const path = resolved?.replaceAll("\\", "/") ?? "";
  const owner = installerOf(tool, path, path, false);
  // There is no safe command that pins the tested version over these installations.
  if (owner === "nix" || owner === "bundled" || (owner === "native" && tool === "codex"))
    return undefined;
  // npm under a Homebrew Node lives in `/opt/homebrew/lib/node_modules`: that's npm's to upgrade.
  if (!path.includes("/node_modules/") && /\/(Cellar|homebrew|linuxbrew)\//.test(path))
    return `brew upgrade ${tool}`;
  return `npm i -g @openai/codex@${version}`;
};

/**
 * The agent a new thread starts on while no default model is saved, read off the installed CLIs as
 * discovery picks it: one that's signed in, Claude Code first, else one that's at least installed.
 * Undefined with neither installed.
 */
export const inferredAgentOf = (checks: LaunchChecks): AgentKind | undefined => {
  const found = (tool: LaunchTool) => checks.tools.find((t) => t.tool === tool)?.found === true;
  if (claudeReady(checks)) return "claude";
  if (found("codex") && checks.codexSignIn === "signedIn") return "codex";
  if (found("claude")) return "claude";
  if (found("codex")) return "codex";
  return undefined;
};

/** The saved default model's agent, else the one `inferredAgentOf` reads off the CLIs. */
const defaultAgentOf = (settings: Settings, checks: LaunchChecks): AgentKind | undefined =>
  settings.agents.defaultModel?.agent ?? inferredAgentOf(checks);

/**
 * CLI problems are worth raising for agents the user selected as a default or used in threads,
 * and, with no default saved, for the one new threads would start on.
 */
export const agentsInUseOf = (
  settings: Settings,
  threads: ReadonlyArray<Thread>,
  checks: LaunchChecks,
): Array<GatewayAgentTool> => {
  const picked = new Set<string>(threads.map((thread) => thread.model.agent));
  const defaultAgent = defaultAgentOf(settings, checks);
  if (defaultAgent !== undefined) picked.add(defaultAgent);
  return (["codex"] as const).filter((agent) => picked.has(agent));
};

/**
 * Local account warnings apply only to selected local workflows, never to a saved gateway key. With
 * no default saved, a Codex-only user isn't told about Claude Code, nor a Claude-only one about Codex.
 */
export const localAgentsInUseOf = (
  settings: Settings,
  threads: ReadonlyArray<Thread>,
  checks: LaunchChecks,
): AgentKind[] => {
  const models: ModelRef[] = threads.map((thread) => thread.model);
  const saved = settings.agents.defaultModel;
  const inferred = saved === undefined ? inferredAgentOf(checks) : undefined;
  if (saved !== undefined) models.push(saved);
  else if (inferred !== undefined) models.push({ agent: inferred, model: "default" });
  return [
    ...new Set(models.filter((model) => model.profileId === undefined).map((model) => model.agent)),
  ];
};

/** Codex prints status on stderr, including a masked key. Return only a classification, never text. */
export const codexSignInOf = (output: {
  readonly status: number;
  readonly stdout: string;
  readonly stderr?: string;
}): CodexSignIn => {
  const lines = `${output.stdout}\n${output.stderr ?? ""}`
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (output.status === 0 && lines.includes("Logged in using ChatGPT")) return "signedIn";
  if (
    output.status === 0 &&
    lines.some((line) => /^Logged in using an API key(?: - .*)?$/.test(line))
  )
    return "apiKey";
  if (output.status === 1 && lines.includes("Not logged in")) return "notSignedIn";
  return "unknown";
};

const SIGN_IN: Readonly<Record<AuthProblem, ClaudeSignIn>> = {
  "not-logged-in": "notSignedIn",
  "api-key-auth": "apiKey",
  "third-party-provider": "thirdParty",
  unparseable: "unknown",
};

/** The sign-in state from `claude auth status --json` output, which it prints even when signed out. */
export const claudeSignInOf = (stdout: string): ClaudeSignIn => {
  const problem = checkAuthStatus(stdout);
  return problem === undefined ? "signedIn" : SIGN_IN[problem];
};

/** Whether a Claude thread could start now: the CLI found is usable, and it's signed in. */
export const claudeReady = (checks: LaunchChecks): boolean => {
  const claude = checks.tools.find((t) => t.tool === "claude");
  return (
    claude?.found === true && claude.unusable === undefined && checks.claudeSignIn === "signedIn"
  );
};

/** A gateway agent's tested version and the command that gets it over the install at `resolved`. */
const testedFields = (tool: GatewayAgentTool, resolved: string | undefined) => {
  const command = upgradeCommand(tool, resolved, TESTED_VERSIONS[tool]);
  return {
    testedVersion: TESTED_VERSIONS[tool],
    ...(command === undefined ? {} : { upgradeCommand: command }),
  };
};

/**
 * Looks up `claude`, `git`, `gh` and `codex` on the login-shell PATH with their versions,
 * asks whether a Claude thread could start from the CLI found, and asks Claude and gh whether
 * they're signed in. For Codex it also names the tested version, the command to get
 * it, and any other installs further down the PATH. Every step degrades to "not found" /
 * "unknown"; nothing fails.
 */
export const runLaunchChecks = (probe: LaunchProbe): Effect.Effect<LaunchChecks> =>
  Effect.gen(function* () {
    const pathValue = yield* probe.path;
    const versionOf = (path: string) =>
      probe.run(path, ["--version"]).pipe(
        Effect.map((out) => parseToolVersion(out.stdout)),
        Effect.orElseSucceed(() => undefined),
      );
    const checkTool = (tool: LaunchTool): Effect.Effect<ToolCheck> =>
      Effect.gen(function* () {
        const path =
          probe.agentBinary !== undefined && (tool === "claude" || tool === "codex")
            ? yield* probe.agentBinary(tool, pathValue)
            : probe.which(tool, pathValue);
        if (path === undefined) {
          return {
            tool,
            found: false,
            ...(isGatewayAgentTool(tool) ? testedFields(tool, undefined) : {}),
          };
        }
        const [version, unusable] = yield* Effect.all(
          [versionOf(path), tool === "claude" ? probe.claudeUnusable(path) : Effect.undefined],
          { concurrency: "unbounded" },
        );
        const found: ToolCheck = {
          tool,
          found: true,
          path,
          ...(version === undefined ? {} : { version }),
          ...(unusable === undefined ? {} : { unusable }),
        };
        if (!isGatewayAgentTool(tool)) return found;
        const resolved = probe.realpath(path);
        // Other installs further down the PATH explain a version the user didn't expect.
        const seen = new Set([resolved]);
        const others = probe.whichAll(tool, pathValue).filter((other) => {
          const real = probe.realpath(other);
          if (seen.has(real)) return false;
          seen.add(real);
          return true;
        });
        const shadowed = yield* Effect.forEach(
          others,
          (other): Effect.Effect<ShadowedInstall> =>
            versionOf(other).pipe(
              Effect.map((otherVersion) => ({
                path: other,
                ...(otherVersion === undefined ? {} : { version: otherVersion }),
              })),
            ),
          { concurrency: "unbounded" },
        );
        return {
          ...found,
          ...testedFields(tool, resolved),
          ...(shadowed.length === 0 ? {} : { shadowed }),
        };
      });
    const tools = yield* Effect.all(TOOLS.map(checkTool), { concurrency: "unbounded" });
    const claude = tools.find((t) => t.tool === "claude");
    const claudePath = claude?.path;
    const codexPath = tools.find((t) => t.tool === "codex")?.path;
    const ghPath = tools.find((t) => t.tool === "gh")?.path;

    const [claudeSignIn, codexSignIn, ghSignedIn] = yield* Effect.all(
      [
        claudePath === undefined
          ? Effect.succeed<ClaudeSignIn>("unknown")
          : probe.run(claudePath, ["auth", "status", "--json"]).pipe(
              Effect.map((out) => claudeSignInOf(out.stdout)),
              Effect.orElseSucceed((): ClaudeSignIn => "unknown"),
            ),
        codexPath === undefined
          ? Effect.succeed<CodexSignIn>("unknown")
          : probe.run(codexPath, ["login", "status"]).pipe(
              Effect.map(codexSignInOf),
              Effect.orElseSucceed((): CodexSignIn => "unknown"),
            ),
        ghPath === undefined
          ? Effect.succeed(false)
          : probe.run(ghPath, ["auth", "status"]).pipe(
              Effect.map((out) => out.status === 0),
              Effect.orElseSucceed(() => false),
            ),
      ],
      { concurrency: "unbounded" },
    );
    // The verdict behind the launch banner, which is otherwise only ever on screen.
    yield* Effect.logInfo("launch checks").pipe(
      Effect.annotateLogs({
        claudeUsable: claude?.found === true && claude.unusable === undefined,
        claudeSignIn,
        codexSignIn,
        ghSignedIn,
        tools: tools.map((t) => `${t.tool}=${t.path ?? "missing"}@${t.version ?? "?"}`).join(" "),
      }),
    );
    return { checkedAt: probe.now(), tools, claudeSignIn, codexSignIn, ghSignedIn };
  });

/**
 * The checks run once, on first request, and callers share that run and its result; `refresh`
 * starts a new run.
 */
export const makeLaunchChecksCache = (
  probe: LaunchProbe,
): Effect.Effect<(refresh: boolean) => Effect.Effect<LaunchChecks>> =>
  Effect.sync(() => {
    let current: Effect.Effect<LaunchChecks> | undefined;
    const start = Effect.cached(runLaunchChecks(probe)).pipe(
      Effect.tap((run) =>
        Effect.sync(() => {
          current = run;
        }),
      ),
    );
    return (refresh) =>
      Effect.gen(function* () {
        const run = refresh || current === undefined ? yield* start : current;
        return yield* run;
      });
  });
