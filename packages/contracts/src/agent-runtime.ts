import * as Schema from "effect/Schema";

/**
 * The agent CLIs and their runtimes: where each one a session would start comes from, how it
 * compares with the bindings this build ships, what newer release is out, and the managed store
 * that installs exact versions.
 */

/** The agents whose CLI Gram binds to directly. */
export const RuntimeAgent = Schema.Literals(["claude", "codex"]);
export type RuntimeAgent = typeof RuntimeAgent.Type;

/**
 * Where the executable came from: `bundled` inside the signed app, the user's own install on the
 * login-shell `path`, a `custom` path the user set, or Gram's `managed` store.
 */
export const RuntimeSource = Schema.Literals(["bundled", "path", "custom", "managed"]);
export type RuntimeSource = typeof RuntimeSource.Type;

/**
 * How a CLI version fares with the bindings: `supported` within what was qualified, `graceful`
 * when it runs with known gaps, `unsupported` when shown not to work, `unknown` when nothing says
 * either way (an unread version, or one not yet qualified). Only `unsupported` is proof.
 */
export const CompatibilityVerdict = Schema.Literals([
  "supported",
  "graceful",
  "unsupported",
  "unknown",
]);
export type CompatibilityVerdict = typeof CompatibilityVerdict.Type;

/** A vendor release channel. */
export const RuntimeChannel = Schema.Literals(["stable", "preview"]);
export type RuntimeChannel = typeof RuntimeChannel.Type;

/** `MAJOR.MINOR.PATCH`, with an optional prerelease (`0.160.0-alpha.3`). */
export const RuntimeVersion = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
);
export type RuntimeVersion = typeof RuntimeVersion.Type;

/** The bindings this build ships for one agent, which a CLI version is judged against. */
export const BindingBaseline = Schema.Struct({
  /** The CLI version the adapter was generated or tested against. */
  cliVersion: RuntimeVersion,
  /** The shipped binding: the Agent SDK, the generated app-server protocol, or the HTTP SDK types. */
  binding: Schema.Literals(["claude-agent-sdk", "codex-protocol"]),
  bindingVersion: RuntimeVersion,
});
export type BindingBaseline = typeof BindingBaseline.Type;

/** The executable a new session of the agent would start, as resolved without starting it. */
export const ResolvedRuntime = Schema.Struct({
  source: RuntimeSource,
  /** Absolute path of the executable (or the `.cmd` shim a Windows npm install puts on PATH). */
  path: Schema.String,
  /** From `--version`; absent when it couldn't be read. */
  version: Schema.optionalKey(RuntimeVersion),
  /** Other installs further down the PATH, which the shell doesn't pick. */
  shadowed: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ path: Schema.String, version: Schema.optionalKey(RuntimeVersion) }),
    ),
  ),
});
export type ResolvedRuntime = typeof ResolvedRuntime.Type;

/**
 * A release newer than the resolved one. Every install path holds a release back until at least
 * 24 hours after it was published (`eligibleAt`); checking again never shortens that.
 */
export const NewerVersion = Schema.Struct({
  version: RuntimeVersion,
  channel: RuntimeChannel,
  /** Epoch ms the vendor published it. */
  publishedAt: Schema.Number,
  /** Epoch ms from which it may be installed. */
  eligibleAt: Schema.Number,
  /** `eligibleAt` has passed. */
  eligible: Schema.Boolean,
  /** That version's verdict, on the same basis as the resolved one's. */
  verdict: CompatibilityVerdict,
});
export type NewerVersion = typeof NewerVersion.Type;

/** How a user-owned install was put there, which decides the command that updates it. */
export const Installer = Schema.Literals([
  "npm",
  "pnpm",
  "bun",
  "brew",
  "native",
  "nix",
  "bundled",
  "unknown",
]);
export type Installer = typeof Installer.Type;

/**
 * A command that installs or updates a user-owned CLI. The user can copy it into a terminal, and
 * where it carries `run`, Gram runs it for them once they confirm (`agentRuntime.update`).
 */
export const InstallStep = Schema.Struct({
  installer: Installer,
  command: Schema.String,
  /** The command installs exactly `version`, rather than whatever is latest when it runs. */
  exact: Schema.Boolean,
  /** The version it installs, when `exact`. */
  version: Schema.optionalKey(RuntimeVersion),
  /**
   * The argv `agentRuntime.update` runs for it, `command` split on spaces. Absent for a step that is
   * copy-only: an installer pipeline, or a fallback that would put a second install beside the one
   * the user has.
   */
  run: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type InstallStep = typeof InstallStep.Type;

/** Present where Gram's managed store can install this agent on this machine. */
export const ManagedOffer = Schema.Struct({
  /**
   * The exact qualified, age-eligible version an Install or Update would put in the store; absent
   * when the active runtime is already the newest such version.
   */
  candidate: Schema.optionalKey(
    Schema.Struct({ version: RuntimeVersion, channel: RuntimeChannel }),
  ),
});
export type ManagedOffer = typeof ManagedOffer.Type;

/** One agent's runtime, as Settings → Agents shows it. */
export const AgentRuntime = Schema.Struct({
  agent: RuntimeAgent,
  /** Absent when no executable was found. */
  resolved: Schema.optionalKey(ResolvedRuntime),
  /** Ownership of a PATH installation, including why Gram cannot update it in place. */
  installation: Schema.optionalKey(
    Schema.Struct({
      installer: Installer,
      realPath: Schema.String,
      updateNote: Schema.optionalKey(Schema.String),
    }),
  ),
  baseline: BindingBaseline,
  /** The resolved version's verdict; `unknown` when nothing was resolved. */
  verdict: CompatibilityVerdict,
  /** Why, in a sentence, when the verdict isn't `supported`. */
  reason: Schema.optionalKey(Schema.String),
  /** The newest release past the resolved one, eligible or still waiting out its 24 hours. */
  newer: Schema.optionalKey(NewerVersion),
  /** The commands that bring a user-owned install to a supported version, best first. */
  installSteps: Schema.Array(InstallStep),
  managed: Schema.optionalKey(ManagedOffer),
});
export type AgentRuntime = typeof AgentRuntime.Type;

/**
 * Newer releases are read through the user's own `npm`, so its registry and sign-in apply, and
 * nothing else is tried: `npm-missing` (no npm, so no registry credential either), `sign-in` (the
 * registry answered 401 or 403; at EXAMPLE, npm registry's token has lapsed), or `unreachable` (anything else:
 * a proxy, rate limit, missing package or timeout).
 */
export const ReleaseCheckProblem = Schema.Struct({
  problem: Schema.Literals(["npm-missing", "sign-in", "unreachable"]),
  /** A few words for the details. Never npm's own output, which can name the registry. */
  message: Schema.String,
});
export type ReleaseCheckProblem = typeof ReleaseCheckProblem.Type;

/** `agentRuntime.list`. */
export const AgentRuntimes = Schema.Struct({
  /** Epoch ms of the local probe. */
  checkedAt: Schema.Number,
  /** Epoch ms vendor release metadata was last read; absent before the first read. */
  releasesCheckedAt: Schema.optionalKey(Schema.Number),
  /** Why newer releases couldn't be checked, when they couldn't. */
  releasesUnavailable: Schema.optionalKey(ReleaseCheckProblem),
  /** Newer releases are being read now (a cold read through a corporate registry takes minutes); ask again. */
  releasesChecking: Schema.optionalKey(Schema.Literal(true)),
  agents: Schema.Array(AgentRuntime),
});
export type AgentRuntimes = typeof AgentRuntimes.Type;

export const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export type Sha256Hex = typeof Sha256Hex.Type;

// ---------------------------------------------------------------------------------------------
// The managed store's install state

/** A runtime in the managed store. */
export const ManagedInstall = Schema.Struct({
  version: RuntimeVersion,
  sha256: Sha256Hex,
  /** Absolute path of the executable. */
  path: Schema.String,
  /** Epoch ms it was verified and recorded. */
  installedAt: Schema.Number,
});
export type ManagedInstall = typeof ManagedInstall.Type;

const Settled = {
  /** The runtime new sessions start from. */
  active: Schema.optionalKey(ManagedInstall),
  /** The last healthy one before it, which a rollback returns to. */
  previous: Schema.optionalKey(ManagedInstall),
};

/** One agent's managed store, from idle through an install to its outcome. */
export const RuntimeInstallState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle"), ...Settled }),
  Schema.Struct({
    state: Schema.Literal("downloading"),
    version: RuntimeVersion,
    receivedBytes: Schema.Number,
    totalBytes: Schema.Number,
    ...Settled,
  }),
  Schema.Struct({ state: Schema.Literal("verifying"), version: RuntimeVersion, ...Settled }),
  /** Unpacked and checked; now `--version` and a handshake run against an empty home. */
  Schema.Struct({ state: Schema.Literal("testing"), version: RuntimeVersion, ...Settled }),
  /** Verified and recorded; it becomes active once the agent has no live sessions. */
  Schema.Struct({
    state: Schema.Literal("ready"),
    version: RuntimeVersion,
    activeSessions: Schema.Int,
    ...Settled,
  }),
  /** The install stopped; `active` is still what runs. */
  Schema.Struct({
    state: Schema.Literal("failed"),
    version: RuntimeVersion,
    message: Schema.String,
    ...Settled,
  }),
  /** `from` failed to start before any turn, so `active` was put back. */
  Schema.Struct({
    state: Schema.Literal("rolledBack"),
    from: RuntimeVersion,
    message: Schema.String,
    ...Settled,
  }),
]);
export type RuntimeInstallState = typeof RuntimeInstallState.Type;

/** Why the managed store wouldn't install or switch to a version. */
export const RuntimeRefusal = Schema.Literals([
  /** This build doesn't approve it for this agent and platform. */
  "not-approved",
  /** Its 24 hours aren't up. */
  "not-eligible",
  /** Not qualified for this Gram version. */
  "not-qualified",
  /** The artifact failed verification. */
  "unverified",
  /** The managed store doesn't serve this agent or platform. */
  "unsupported",
  /** Another install of the agent is under way. */
  "busy",
  /** A rollback with no previous healthy runtime to go back to. */
  "nothing-to-roll-back",
]);
export type RuntimeRefusal = typeof RuntimeRefusal.Type;

export class RuntimeInstallRefused extends Schema.TaggedError<RuntimeInstallRefused>()(
  "RuntimeInstallRefused",
  { agent: RuntimeAgent, reason: RuntimeRefusal, message: Schema.String },
) {}

/** `agentRuntime.install`: an exact approved version, never "latest". */
export const RuntimeInstallPayload = Schema.Struct({
  agent: RuntimeAgent,
  version: RuntimeVersion,
});
export type RuntimeInstallPayload = typeof RuntimeInstallPayload.Type;

/** Which runtime an agent's new sessions start from: Gram's store, or the user's own. */
export const RuntimeSourceChoice = Schema.Literals(["managed", "path"]);
export type RuntimeSourceChoice = typeof RuntimeSourceChoice.Type;

// ---------------------------------------------------------------------------------------------
// Updating the user's own CLI

/**
 * Why an update of the user's own CLI failed: `sign-in` (the registry refused npm's credential),
 * `release-age` (the package manager's own release-age policy holds the version back),
 * `permission` (a global install that needs admin rights), `in-use` (Windows won't replace a
 * running executable), `missing` (the installer isn't on the login-shell PATH), `timeout`,
 * `cancelled`, or `failed` for anything else.
 */
export const CliUpdateProblem = Schema.Literals([
  "sign-in",
  "release-age",
  "permission",
  "in-use",
  "missing",
  "timeout",
  "cancelled",
  "failed",
]);
export type CliUpdateProblem = typeof CliUpdateProblem.Type;

const UpdateRun = {
  /** The command as the user confirmed it. */
  command: Schema.String,
  /** The last few kilobytes of what it printed, stdout and stderr together, secrets scrubbed. */
  output: Schema.String,
};

/**
 * One agent's update of the user's own CLI, from idle through the run to its outcome. It lives in
 * the server's memory only, so a restart answers `idle` and nothing is left stuck.
 */
export const CliUpdateState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle") }),
  Schema.Struct({
    state: Schema.Literal("running"),
    ...UpdateRun,
    /** Epoch ms. */
    startedAt: Schema.Number,
    /** The agent's threads with a live session, which keep the version they started with. */
    runningThreads: Schema.Int,
  }),
  /** The command exited 0 and the CLI was probed again. */
  Schema.Struct({
    state: Schema.Literal("succeeded"),
    ...UpdateRun,
    /** The version before, when it was read. */
    from: Schema.optionalKey(RuntimeVersion),
    /** The version the probe reads now; absent when it couldn't be read. */
    version: Schema.optionalKey(RuntimeVersion),
    runningThreads: Schema.Int,
  }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    ...UpdateRun,
    problem: CliUpdateProblem,
    /** A sentence for the row; never the package manager's own text, which can name the registry. */
    message: Schema.String,
  }),
]);
export type CliUpdateState = typeof CliUpdateState.Type;

/**
 * Why an update wouldn't start: `busy` (one is already running for the agent) or `not-offered`
 * (the command isn't one Gram offers to run for it now, as after the CLI changed).
 */
export class CliUpdateRefused extends Schema.TaggedError<CliUpdateRefused>()("CliUpdateRefused", {
  agent: RuntimeAgent,
  reason: Schema.Literals(["busy", "not-offered"]),
  message: Schema.String,
}) {}

/** `agentRuntime.update`: the command the user saw and confirmed, matched against the listing. */
export const CliUpdatePayload = Schema.Struct({ agent: RuntimeAgent, command: Schema.String });
export type CliUpdatePayload = typeof CliUpdatePayload.Type;
