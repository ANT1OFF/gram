import { CLAUDE_AGENT_SDK_VERSION } from "@gram/agents/claude";
import { CODEX_CLI_VERSION } from "@gram/agents/codex";
import type {
  BindingBaseline,
  CompatibilityVerdict,
  Installer,
  InstallStep,
  RuntimeAgent,
} from "@gram/contracts";

/**
 * The binding-policy manifest: what this build ships for each agent, and how a CLI version is
 * judged against it. Pure, so the Settings rows, the resolver and its tests share one answer.
 */

/**
 * The bindings this build ships, per agent: the adapter's binding and the CLI version it was built
 * and tested with. Claude's CLI baseline is the SDK's own pairing: SDK 0.3.N ships beside CLI
 * 2.1.N (`claude/environment.ts`).
 */
export const BASELINES: Readonly<Record<RuntimeAgent, BindingBaseline>> = {
  claude: {
    cliVersion: `2.1.${CLAUDE_AGENT_SDK_VERSION.split(".")[2] ?? "0"}`,
    binding: "claude-agent-sdk",
    bindingVersion: CLAUDE_AGENT_SDK_VERSION,
  },
  codex: {
    cliVersion: CODEX_CLI_VERSION,
    binding: "codex-protocol",
    bindingVersion: CODEX_CLI_VERSION,
  },
};

/** The npm package each CLI is published as; the newer-version signal reads its registry entry. */
export const NPM_PACKAGES: Readonly<Record<RuntimeAgent, string>> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

/** Claude Code may run this many patches ahead of the SDK's matched CLI, as its session check allows. */
const CLAUDE_NEWER_PATCHES = 10;

interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string | undefined;
}

export const parseSemver = (version: string): Semver | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  return match
    ? {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4],
      }
    : undefined;
};

/** Semver precedence, with prereleases compared as whole strings; NaN when either won't parse. */
export const compareVersions = (a: string, b: string): number => {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (x === undefined || y === undefined) return Number.NaN;
  const core = x.major - y.major || x.minor - y.minor || x.patch - y.patch;
  if (core !== 0) return Math.sign(core);
  if (x.prerelease === y.prerelease) return 0;
  if (x.prerelease === undefined) return 1;
  if (y.prerelease === undefined) return -1;
  return x.prerelease < y.prerelease ? -1 : 1;
};

export interface Judgement {
  readonly verdict: CompatibilityVerdict;
  /** Why, when the verdict isn't `supported`. */
  readonly reason?: string;
}

const NAMES: Readonly<Record<RuntimeAgent, string>> = {
  claude: "Claude Code",
  codex: "Codex",
};

/**
 * `version` against the shipped baseline. Supported: the baseline's own release line, at or past
 * its patch (Claude: no more than ten patches past, as its SDK pairs a CLI line). Graceful: the
 * same line, an older patch. Unsupported: an older line, which lacks what the adapter calls.
 * Unknown: a newer line, or past Claude's window, which nothing has qualified yet; and prereleases.
 */
export const judgeAgainstBaseline = (agent: RuntimeAgent, version: string): Judgement => {
  const { cliVersion } = BASELINES[agent];
  const name = NAMES[agent];
  const cli = parseSemver(version);
  const base = parseSemver(cliVersion);
  if (cli === undefined || base === undefined)
    return { verdict: "unknown", reason: `${name}'s version couldn't be read.` };
  if (cli.prerelease !== undefined)
    return {
      verdict: "unknown",
      reason: `${name} ${version} is a prerelease; nothing qualifies those yet.`,
    };
  const sameLine = cli.major === base.major && cli.minor === base.minor;
  const ahead = cli.patch - base.patch;
  if (sameLine && ahead >= 0 && (agent !== "claude" || ahead <= CLAUDE_NEWER_PATCHES))
    return { verdict: "supported" };
  if (sameLine && ahead < 0)
    return {
      verdict: "graceful",
      reason: `${name} ${version} is older than the ${cliVersion} Gram is built for; some features may not work.`,
    };
  if (compareVersions(version, cliVersion) < 0)
    return {
      verdict: "unsupported",
      reason: `${name} ${version} is older than the ${cliVersion} release line Gram is built for.`,
    };
  return {
    verdict: "unknown",
    reason: `${name} ${version} is newer than the ${cliVersion} Gram is built for, and its compatibility hasn't been checked yet.`,
  };
};

/** Forward slashes and lower case, so one set of patterns reads macOS and Windows paths alike. */
const normal = (path: string) => path.replaceAll("\\", "/").toLowerCase();

/**
 * How the install at `path` was put there, read from where it lives with symlinks resolved
 * (`resolved`). A package manager's `node_modules` wins over Homebrew, since npm under a Homebrew
 * Node lives in `/opt/homebrew/lib/node_modules`. `npmPackageBeside` says whether a Windows shim's
 * folder holds the package's `node_modules/<package>/package.json`, which is how npm and pnpm
 * shims look on Windows, where there are no symlinks to follow.
 */
export const installerOf = (
  agent: RuntimeAgent,
  path: string,
  resolved: string,
  npmPackageBeside: boolean,
): Installer => {
  const both = `${normal(path)}\n${normal(resolved)}`;
  // Immutable/bundled destinations win even when the launcher looks like a mutable install.
  if (/(?:^|\n)\/nix\/store\//.test(both)) return "nix";
  if (/\.app\/contents\//.test(both) || both.includes("/.codex/packages/app-server-daemon/"))
    return "bundled";
  if (/\/\.bun\/(install\/global|bin)\//.test(both)) return "bun";
  if (/\/(pnpm|\.pnpm-global|pnpm-global)\//.test(both)) return "pnpm";
  if (both.includes("/node_modules/") || npmPackageBeside) return "npm";
  if (/\/(cellar|caskroom|homebrew|linuxbrew)\//.test(both)) return "brew";
  if (
    agent === "claude" &&
    /\/(\.local\/share\/claude|\.claude\/local|\.local\/bin\/claude)/.test(both)
  )
    return "native";
  if (agent === "codex" && /\/\.codex\/packages\/standalone\/(current|releases)\//.test(both))
    return "native";
  return "unknown";
};

/** Owner-specific guidance, without inventing a command for a user's declarative configuration. */
export const installationNote = (
  agent: RuntimeAgent,
  installer: Installer,
  writable: boolean,
  latest: boolean,
): string | undefined => {
  if (installer === "nix")
    return "Nix owns this installation in its immutable store. Update the package in your Nix or Home Manager configuration and activate that configuration, then Re-check. Gram cannot update it in place.";
  if (installer === "bundled")
    return "This executable belongs to an app or its managed daemon runtime. Update it through that owner, then Re-check. Gram cannot replace a bundled executable.";
  if (!writable)
    return "This executable is read-only for your account. Update it through its installation owner in a terminal, then Re-check. Gram does not request administrator access.";
  if (installer === "native" && agent === "codex" && !latest)
    return "Codex's standalone updater (`codex update`) installs latest and cannot pin a version. Gram can run it only when the latest release has passed its compatibility and release-age checks. An npm install would create a separate installation.";
  if (installer === "unknown")
    return "Gram could not identify this installation's owner. Update it through the tool that installed it, then Re-check. Installing with npm would create a separate installation and may not change the executable on PATH.";
  return undefined;
};

/** A step Gram can run: its command is exactly `argv`, so the user sees what runs. */
const runnable = (
  installer: Installer,
  argv: ReadonlyArray<string>,
  pinned: string | undefined,
): InstallStep => ({
  installer,
  command: argv.join(" "),
  exact: pinned !== undefined,
  ...(pinned === undefined ? {} : { version: pinned }),
  run: argv,
});

/**
 * The commands that bring the agent to `version`, best first: the one matching `installer`
 * (absent: not installed), then npm as the general fallback. A command that can't pin a version
 * installs the vendor's latest, so it's offered only when `version` is that latest (`latest`),
 * already past its 24 hours and compatible; otherwise an exact command stands in. The user can
 * copy any of them, and Gram runs one carrying `run` for them when they confirm it
 * (`agentRuntime.update`); a package manager's own release-age policy (npm `min-release-age`, pnpm
 * `minimumReleaseAge`) applies either way.
 *
 * `run` goes only on a single program with plain arguments, for the installer that put the CLI
 * there (or npm, when nothing is installed), so a run updates the install the row shows rather than
 * adding a second one beside it. Claude Code's installer stays copy-only: a `curl … | bash` or
 * PowerShell `irm` pipeline needs a shell to run at all, and a remote script piped into one isn't
 * something to execute without the user reading it first.
 */
export const installSteps = (
  agent: RuntimeAgent,
  installer: Installer | undefined,
  version: string,
  platform: NodeJS.Platform,
  latest: boolean,
): ReadonlyArray<InstallStep> => {
  if (installer === "nix" || installer === "bundled") return [];
  // A standalone Codex is not npm-owned. Its latest-only updater cannot install a baseline pin.
  if (installer === "native" && agent === "codex")
    return latest ? [runnable("native", ["codex", "update"], undefined)] : [];
  const pkg = NPM_PACKAGES[agent];
  const npm = runnable("npm", ["npm", "i", "-g", `${pkg}@${version}`], version);
  // Claude Code's installer takes the version to install as its argument.
  const claudeInstaller = (): InstallStep => ({
    installer: "native",
    command:
      platform === "win32"
        ? `& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) ${version}`
        : `curl -fsSL https://claude.ai/install.sh | bash -s ${version}`,
    exact: true,
    version,
  });
  const own: InstallStep | undefined = (() => {
    switch (installer) {
      case "npm":
        return npm;
      case "pnpm":
        return runnable("pnpm", ["pnpm", "add", "-g", `${pkg}@${version}`], version);
      case "bun":
        return runnable("bun", ["bun", "add", "-g", `${pkg}@${version}`], version);
      case "brew":
        return latest
          ? runnable(
              "brew",
              agent === "claude"
                ? ["brew", "upgrade", "--cask", "claude-code"]
                : ["brew", "upgrade", agent],
              undefined,
            )
          : undefined;
      case "native":
        return agent === "claude"
          ? latest
            ? runnable("native", ["claude", "update"], undefined)
            : claudeInstaller()
          : undefined;
      case undefined:
        // Not installed: Claude Code's own installer is the vendor's recommended way in.
        return agent === "claude" ? claudeInstaller() : undefined;
      default:
        return undefined;
    }
  })();
  if (own?.installer === "npm") return [own];
  // Nothing installed, so npm's install is the only one there will be.
  if (installer === undefined) return own === undefined ? [npm] : [own, npm];
  const { run: _second, ...copyOnly } = npm;
  return own === undefined ? [copyOnly] : [own, copyOnly];
};
