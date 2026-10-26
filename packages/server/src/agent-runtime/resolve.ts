import type {
  AgentRuntime,
  AgentRuntimes,
  InstallStep,
  LaunchChecks,
  ManagedInstall,
  NewerVersion,
  RuntimeAgent,
  RuntimeChannel,
  RuntimeSourceChoice,
  ToolCheck,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import {
  BASELINES,
  compareVersions,
  installerOf,
  installationNote,
  installSteps,
  judgeAgainstBaseline,
  parseSemver,
  type Judgement,
} from "./policy.ts";
import type { VendorReleases } from "./releases.ts";
import { DAY_MS } from "../zone-time.ts";

/** The shortest a release waits after publication before anything offers to install it. */
export const RELEASE_AGE_MS = DAY_MS;

const AGENTS: ReadonlyArray<RuntimeAgent> = ["claude", "codex"];

/** Gram's managed store, as the managed-runtime service shows it to the resolver. */
interface ManagedRuntimesView {
  /** The store can install this agent on this machine; only those rows get a `managed` offer. */
  readonly serves: (agent: RuntimeAgent) => boolean;
  readonly active: (agent: RuntimeAgent) => Effect.Effect<ManagedInstall | undefined>;
  readonly source: (agent: RuntimeAgent) => Effect.Effect<RuntimeSourceChoice>;
  /** The versions the store would install now (qualified, past their wait), newest first. */
  readonly allowed: (
    agent: RuntimeAgent,
  ) => Effect.Effect<ReadonlyArray<{ readonly version: string; readonly channel: RuntimeChannel }>>;
}

export interface ResolveInput {
  readonly checks: LaunchChecks;
  readonly releases: VendorReleases;
  readonly platform: NodeJS.Platform;
  readonly now: number;
  /** Symlinks resolved; the path itself when that fails. */
  readonly realpath: (path: string) => string;
  /** Whether the folder of a Windows shim at `path` holds `node_modules/<npm package>`. */
  readonly npmPackageBeside: (agent: RuntimeAgent, path: string) => boolean;
  /** Can this account write the resolved executable? Absent in pure callers: assumed writable. */
  readonly writable?: (path: string) => boolean;
  readonly managed?: ManagedRuntimesView | undefined;
  /**
   * An explicit embedding policy pins the CLIs: no install steps or store offers. Versions
   * are still judged. Gram's local handler does not set this policy; managed CLI installations
   * retain their own source and ownership checks.
   */
  readonly pinnedCli?: boolean | undefined;
}

const isStable = (version: string) => parseSemver(version)?.prerelease === undefined;

/**
 * One agent's runtime: the executable the launch checks resolved (or the managed store's, when the
 * user chose it), its verdict, the newest release past it, and the steps to a supported version.
 */
const resolveOne = (input: ResolveInput, agent: RuntimeAgent) =>
  Effect.gen(function* () {
    const baseline = BASELINES[agent];
    const tool: ToolCheck | undefined = input.checks.tools.find((t) => t.tool === agent);
    const source = input.managed === undefined ? "path" : yield* input.managed.source(agent);
    // What the store holds, whichever source is chosen: Update offers only something newer.
    const installed = input.managed === undefined ? undefined : yield* input.managed.active(agent);
    const active = source === "managed" ? installed : undefined;

    const resolved: AgentRuntime["resolved"] =
      active !== undefined
        ? { source: "managed", path: active.path, version: active.version }
        : tool?.found === true && tool.path !== undefined
          ? {
              source: "path",
              path: tool.path,
              ...(tool.version === undefined || parseSemver(tool.version) === undefined
                ? {}
                : { version: tool.version }),
              ...(tool.shadowed === undefined || tool.shadowed.length === 0
                ? {}
                : {
                    shadowed: tool.shadowed.map((other) => ({
                      path: other.path,
                      ...(other.version === undefined || parseSemver(other.version) === undefined
                        ? {}
                        : { version: other.version }),
                    })),
                  }),
            }
          : undefined;

    const current: Judgement =
      resolved === undefined
        ? { verdict: "unknown", reason: "Not installed." }
        : resolved.version === undefined
          ? { verdict: "unknown", reason: "Its version couldn't be read." }
          : judgeAgainstBaseline(agent, resolved.version);

    const release = input.releases.releases[agent];
    let newer: NewerVersion | undefined;
    if (
      release !== undefined &&
      isStable(release.version) &&
      (resolved?.version === undefined || compareVersions(release.version, resolved.version) > 0)
    ) {
      const eligibleAt = release.publishedAt + RELEASE_AGE_MS;
      newer = {
        version: release.version,
        channel: "stable",
        publishedAt: release.publishedAt,
        eligibleAt,
        eligible: input.now >= eligibleAt,
        verdict: judgeAgainstBaseline(agent, release.version).verdict,
      };
    }

    // The version to point the user at: the newest release once it's past its wait and supported,
    // else the baseline when it is itself supported; with neither, there is nothing to suggest.
    const newerTarget = newer !== undefined && newer.eligible && newer.verdict === "supported";
    const realPath = resolved?.source === "path" ? input.realpath(resolved.path) : undefined;
    const installer =
      realPath === undefined || resolved === undefined
        ? undefined
        : installerOf(
            agent,
            resolved.path,
            realPath,
            input.platform === "win32" && input.npmPackageBeside(agent, resolved.path),
          );
    const writable =
      realPath === undefined || input.writable === undefined || input.writable(realPath);
    const updateNote =
      installer === undefined
        ? undefined
        : installationNote(agent, installer, writable, newerTarget);
    const target = newerTarget
      ? newer!.version
      : judgeAgainstBaseline(agent, baseline.cliVersion).verdict === "supported"
        ? baseline.cliVersion
        : undefined;
    const outdated =
      resolved === undefined ||
      current.verdict === "graceful" ||
      current.verdict === "unsupported" ||
      (newer !== undefined && newer.eligible && newer.verdict === "supported");
    const steps: ReadonlyArray<InstallStep> =
      input.pinnedCli === true ||
      !writable ||
      !outdated ||
      resolved?.source === "managed" ||
      target === undefined
        ? []
        : installSteps(
            agent,
            installer,
            target,
            input.platform,
            // `newer` is the registry's latest, so a "latest" command gets only what was checked.
            newerTarget,
          );

    const allowed =
      input.pinnedCli === true || input.managed === undefined || !input.managed.serves(agent)
        ? undefined
        : yield* input.managed.allowed(agent);
    // Update offers only what's newer than both the store's install and the CLI the user runs.
    const running = [installed?.version, resolved?.version].filter(
      (version): version is string => version !== undefined,
    );
    const candidate = allowed?.find((offer) =>
      running.every((version) => compareVersions(offer.version, version) > 0),
    );

    return {
      agent,
      ...(resolved === undefined ? {} : { resolved }),
      ...(installer === undefined || realPath === undefined
        ? {}
        : {
            installation: {
              installer,
              realPath,
              ...(updateNote === undefined ? {} : { updateNote }),
            },
          }),
      baseline,
      verdict: current.verdict,
      ...(current.verdict === "supported" || current.reason === undefined
        ? {}
        : { reason: current.reason }),
      ...(newer === undefined ? {} : { newer }),
      installSteps: steps,
      ...(allowed === undefined ? {} : { managed: candidate === undefined ? {} : { candidate } }),
    } satisfies AgentRuntime;
  });

/**
 * Every agent's runtime from what the launch checks found and the vendor releases last read.
 * Read-only: it runs nothing itself, so looking never starts an app-server or an MCP server.
 */
export const resolveAgentRuntimes = (input: ResolveInput): Effect.Effect<AgentRuntimes> =>
  Effect.gen(function* () {
    const agents = yield* Effect.forEach(AGENTS, (agent) => resolveOne(input, agent));
    return {
      checkedAt: input.checks.checkedAt,
      ...(input.releases.checkedAt === undefined
        ? {}
        : { releasesCheckedAt: input.releases.checkedAt }),
      ...(input.releases.checking === true ? { releasesChecking: true as const } : {}),
      ...(input.releases.unavailable === undefined
        ? {}
        : { releasesUnavailable: input.releases.unavailable }),
      agents,
    };
  });
