import { existsSync } from "node:fs";
import {
  AgentUnavailable,
  type CodexHome,
  type GatewayProfile,
  type ProfileId,
  type ThreadId,
} from "@gram/contracts";
import type { ChildProcess } from "node:child_process";
import { canonicalSessionHome } from "../session-home.ts";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  nodeFs,
  parseCliVersion,
  parseProbeOutput,
  pathCandidates,
  probeScript,
  resolveBinary,
} from "../cli/discovery.ts";
import { resettableOnSuccess } from "../cli/cache.ts";
import { runCommand } from "../cli/process.ts";
import {
  acceptChildSwitchStartup,
  protectChildForSwitch,
  spawnServe,
  stopChild,
  stopChildForSwitch,
} from "../child-process.ts";
import { GatewayKeyProvider } from "../gateway.ts";
import type { OutwardGate } from "../host.ts";
import { gatewayCatalog, parseCatalog, writeCatalog, type CodexCatalog } from "./catalog.ts";
import { CODEX_HELPER_VERSION, helperAppServerArgs } from "./helper-policy.ts";
import { appServerArgs, serverEnv } from "./config.ts";
import {
  CodexRpcError,
  isServerRequest,
  makeCodexRpc,
  type CodexIo,
  type CodexRpc,
  type ServerMessage,
} from "./rpc.ts";
import type { CodexRuntimeSource, ManagedCodex } from "./runtime.ts";
import { makeThreadOwnership } from "./thread-ownership.ts";
import { acquireHeld } from "../servers-hold.ts";
import { CODEX_CLI_VERSION } from "./version.ts";

export interface CodexServer {
  readonly prepareForSwitch?: Effect.Effect<void, AgentUnavailable>;
  readonly stopForSwitch?: Effect.Effect<void, AgentUnavailable>;
  readonly protectSwitchStartup?: (
    attemptId: string,
  ) => Effect.Effect<Effect.Effect<void, AgentUnavailable>, AgentUnavailable>;
  readonly rpc: CodexRpc;
  /** Whether this is still the cached child for its home/profile, rather than a retired setup. */
  readonly configCurrent: Effect.Effect<boolean>;
  /** Deliberate restart only: interruptible, and released only by the previous owning child's exit. */
  readonly waitForThreadExit: (
    threadId: string,
    onWait: Effect.Effect<void>,
  ) => Effect.Effect<void>;
  /** Read-only executable version probe; absent when the CLI could not identify itself. */
  readonly cliVersion?: string | undefined;
  /** Claims provider ownership before post-open validation; last scope close requests unsubscribe. */
  readonly openThread: <A extends { readonly thread: { readonly id: string } }, E, R>(
    resumeId: string | undefined,
    open: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | AgentUnavailable, R | Scope.Scope>;
  /** A gateway profile's provider is injected; otherwise the user's own configuration and login. */
  readonly gateway: boolean;
  /** Non-fatal problems to surface once per session (version skew, probe fallback). */
  readonly warnings: ReadonlyArray<string>;
  /**
   * Delivers the notifications and server requests for `threadId` until the scope closes. `onExit`
   * runs once if the app-server exits first. `SERVER_WIDE` hears the notifications about no thread,
   * such as a sign-in started without one finishing; a request about none is still declined.
   */
  readonly subscribe: (
    threadId: string,
    listener: CodexListener,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Holds the server for a session's lifetime; a server retired by `invalidate` stops once unused.
   * False, holding nothing, when it was already retired: open through `acquireHeld`.
   */
  readonly retain: Effect.Effect<boolean, never, Scope.Scope>;
  /**
   * The files Gram wrote for this server that Codex reads again on every thread open: the
   * owned home's `config.toml` and the profile's model catalog. Empty on the user's own home.
   */
  readonly generated: ReadonlyArray<string>;
}

export interface CodexListener {
  readonly message: (message: ServerMessage) => void;
  readonly exit: () => void;
}

export interface CodexServersShape {
  readonly switchAttemptReleased?: (attemptId: string) => Effect.Effect<boolean>;
  readonly switchAttemptReceipt?: (
    attemptId: string,
  ) => Effect.Effect<"notStarted" | "exited" | undefined>;
  /**
   * The shared app-server on `home` for a gateway profile, or for the user's own configuration,
   * started on first use. A running one first has any of its `generated` files written again that
   * were removed under it, as another Gram on the same data dir does when it shuts down.
   */
  readonly acquire: (
    profileId: ProfileId | undefined,
    home: CodexHome,
    /** A server-owned worker or orchestrator's stable Gram identity isolates its child lifetime. */
    sessionPartitionId?: ThreadId,
    switchStartup?: string,
  ) => Effect.Effect<CodexServer, AgentUnavailable>;
  /**
   * Runs `open` (a `thread/start`, `thread/resume` or `thread/fork`) with the outward gate's
   * exec-policy rules for `gate` in a Gram-owned home for a gated thread, and with them gone for any
   * other (`gate` undefined). Codex reads a home's rules once, as a thread opens, and keeps them for
   * the thread's life, so the rules can exist for just that moment; opens on the home take turns so
   * none sees another's, which is also what keeps one level's rules out of a thread at the other.
   * They can't simply stay: under the `never` policy of an ungated bypass session a `prompt` rule
   * doesn't ask, it rejects the push outright ("approval required by policy, but AskForApproval is
   * set to Never").
   */
  readonly opening: (
    home: CodexHome,
    gate: OutwardGate | undefined,
  ) => <A, E, R>(open: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Whether `opening` can do that: the gateway home and its rule writer are configured. */
  readonly gateReady: boolean;
  /** Per-home configuration check; native preparation itself is rechecked before admission/open. */
  readonly gateReadyFor?: (home: CodexHome) => boolean;
  /** Prepares the native home and verifies the rule writer, without starting inference. */
  readonly nativeGateReady?: Effect.Effect<boolean>;
  /** Retires the profile's app-servers on both homes (its key changed): the next `acquire` starts fresh. */
  readonly invalidate: (profileId: ProfileId) => Effect.Effect<void>;
  /**
   * Retires every app-server (the executable changed): each stops once its sessions have closed,
   * and the next `acquire` starts from the executable `runtime` resolves then.
   */
  readonly retireAll: Effect.Effect<void>;
  /**
   * Retires the app-servers of one profile (`undefined`, the user's own configuration) on both
   * homes, for a thread restarting to read its config afresh: each stops once its sessions have
   * closed, and the next `acquire` resolves the executable again and starts one that reads
   * `config.toml`, MCP servers included, as it is then.
   */
  readonly retire: (profileId: ProfileId | undefined) => Effect.Effect<void>;
  /**
   * The shared app-servers running now, with the home each reads its `config.toml` from. Starts
   * none: a config change has to reach these, and the next one to start reads the file anyway.
   */
  readonly running: Effect.Effect<
    ReadonlyArray<{ readonly server: CodexServer; readonly home: CodexHome }>
  >;
  /** The homes holding past sessions: the user's own, then Gram's configured native and gateway homes. */
  readonly homes: ReadonlyArray<CodexHome>;
  /**
   * A keyless app-server on `home` to list or delete past sessions: the shared one for `user`, and
   * for Gram-owned homes one that stops when the scope closes, so none stays up just for listing.
   */
  readonly history: (home: CodexHome) => Effect.Effect<CodexServer, AgentUnavailable, Scope.Scope>;
}

export class CodexServers extends Context.Service<CodexServers, CodexServersShape>()(
  "@gram/agents/CodexServers",
) {}

export interface CodexServersConfig {
  /** Login shell for the PATH probe; defaults to `$SHELL`, then `/bin/zsh`. */
  readonly shell?: string;
  /** Skip discovery and use this executable. */
  readonly binaryPath?: string;
  /**
   * Asked before each app-server starts: Gram's managed Codex when the user chose it,
   * otherwise (or absent) the `codex` discovery finds.
   */
  readonly runtime?: CodexRuntimeSource;
  readonly startupTimeoutMs?: number;
  /** Bounds unsubscribe replies and waiting for owning-child exit; never retries a lock. */
  readonly threadCloseTimeoutMs?: number;
  /**
   * Child env applied last, except that the gateway home's `CODEX_HOME` wins; live tests isolate the
   * user's own home with `CODEX_HOME`.
   */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Gram-owned native login home. Preparation links auth without reading its contents. */
  readonly ownedHome?: {
    readonly prepare: (userEnv: Readonly<Record<string, string>>) => Effect.Effect<string>;
    /** Keyless metadata access must also work after logout or before the first login. */
    readonly history?: (userEnv: Readonly<Record<string, string>>) => Effect.Effect<string>;
    readonly refresh?: (userEnv: Readonly<Record<string, string>>) => Effect.Effect<void>;
    readonly rules: NonNullable<CodexServersConfig["gateRules"]>;
  };
  /**
   * Gram's own `CODEX_HOME` for gateway profiles, prepared before each such app-server starts,
   * so gateway sessions never read or write the user's `~/.codex`. Absent: the user's own home.
   * Given the env a user-home app-server would get (the login shell's, then `extraEnv`), which is
   * where the user's own `CODEX_HOME` is set; this and the two below copy from that home.
   */
  readonly gatewayHome?: (userEnv: Readonly<Record<string, string>>) => Effect.Effect<string>;
  /**
   * Runs once the last app-server on the gateway home has exited, to remove what `gatewayHome` wrote;
   * never in a run that hasn't prepared the home since it last released it.
   */
  readonly releaseGatewayHome?: Effect.Effect<void>;
  /**
   * The user's own skill folders that Codex doesn't find from the gateway home, read as each gateway
   * app-server starts and given to it as extra skill roots (`skills/extraRoots/set`): read in place
   * and watched, never linked or copied into the home.
   */
  readonly gatewaySkillRoots?: (
    userEnv: Readonly<Record<string, string>>,
  ) => Effect.Effect<ReadonlyArray<string>>;
  /**
   * Brings what the gateway home inherits from the user's own home up to date (their global
   * `AGENTS.md`), before each thread opens on it.
   */
  readonly refreshGatewayHome?: (userEnv: Readonly<Record<string, string>>) => Effect.Effect<void>;
  /**
   * Writes the outward gate's rules for a level into the gateway home, replacing any that are
   * there, and takes them out again; see `opening`.
   */
  readonly gateRules?: {
    readonly install: (level: OutwardGate) => Effect.Effect<void>;
    readonly remove: Effect.Effect<void>;
  };
}

/** Warns when the CLI is older than the generated protocol, or on a different major/minor. */
export const codexVersionWarning = (cliVersion: string): string | undefined => {
  const [major, minor, patch] = cliVersion.split(".").map(Number);
  const [pMajor, pMinor, pPatch] = CODEX_CLI_VERSION.split(".").map(Number);
  if (major === pMajor && minor === pMinor && (patch ?? 0) >= (pPatch ?? 0)) return undefined;
  return `Codex ${cliVersion} differs from ${CODEX_CLI_VERSION}, which Gram's Codex adapter is built for; some features may misbehave.`;
};

const unavailable = (message: string) =>
  new AgentUnavailable({ agent: "codex", reason: "startup-failed", message });

/** A managed runtime's app-server didn't start; `retry` when the store has rolled back since. */
class ManagedStartFailed extends Data.TaggedError("ManagedStartFailed")<{
  readonly error: AgentUnavailable;
  readonly retry: boolean;
}> {}

/** A child per home/profile: metadata shares one; server-owned workers and orchestrators have stable partitions. */
const cacheKey = (
  profileId: ProfileId | undefined,
  home: CodexHome,
  sessionPartitionId?: ThreadId,
) => JSON.stringify([home, profileId ?? null, sessionPartitionId ?? null]);

/** `CodexServer.subscribe`'s key for the notifications about no thread. */
export const SERVER_WIDE = "";

/** The thread a server message is about; notifications without one (rate limits, remote control) are dropped. */
const threadOf = (message: ServerMessage): string | undefined => {
  const params = (message as { params?: { threadId?: unknown; thread?: { id?: unknown } } }).params;
  if (typeof params?.threadId === "string") return params.threadId;
  return typeof params?.thread?.id === "string" ? params.thread.id : undefined;
};

/** Canonical physical home, including an as-yet-uncreated home below an existing path alias. */
const homeIdentity = (env: Readonly<Record<string, string | undefined>>): string => {
  const path = resolve(
    env["CODEX_HOME"] ?? join(env["HOME"] ?? env["USERPROFILE"] ?? homedir(), ".codex"),
  );
  return canonicalSessionHome(path);
};

/** The app-server's stdio as newline-delimited JSON; listeners attach at spawn so nothing is lost. */
const childIo = (child: ChildProcess) =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string, CodexRpcError | Cause.Done>();
    let buffer = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        Queue.offerUnsafe(lines, buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2_000);
    });
    // A line written as the app-server exits fails with EPIPE, which with no listener is an
    // uncaught exception; the exit listener below already fails the queue with the reason.
    child.stdin?.on("error", () => {});
    child.once("error", (error) =>
      Queue.failCauseUnsafe(
        lines,
        Cause.fail(new CodexRpcError({ method: "", message: error.message })),
      ),
    );
    child.once("exit", (code) =>
      Queue.failCauseUnsafe(
        lines,
        Cause.fail(
          new CodexRpcError({
            method: "",
            message: `codex app-server exited (${code})${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
          }),
        ),
      ),
    );
    const io: CodexIo = {
      write: (line) =>
        Effect.sync(() => {
          child.stdin?.write(`${line}\n`);
        }),
      lines: Stream.fromQueue(lines),
    };
    return io;
  });

export const CodexServersLive = (
  config: CodexServersConfig = {},
  /** Helper-only process policy; each caller builds this layer in its own scope. */
  helperCwd?: string,
): Layer.Layer<CodexServers, never, GatewayKeyProvider> =>
  Layer.effect(CodexServers)(
    Effect.gen(function* () {
      const gateway = yield* GatewayKeyProvider;
      const layerScope = yield* Effect.scope;
      const startupTimeoutMs = config.startupTimeoutMs ?? 30_000;
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      );

      /** The login-shell environment, and the `codex` it finds, read once until a retire. */
      const probe = yield* resettableOnSuccess(
        Effect.gen(function* () {
          const warnings: Array<string> = [];
          const probed =
            process.platform === "win32"
              ? { env: inherited }
              : yield* runCommand(
                  config.shell ?? process.env["SHELL"] ?? "/bin/zsh",
                  ["-ilc", probeScript("codex")],
                  { timeoutMs: 5_000, isolateSession: true },
                ).pipe(
                  Effect.map((output) => parseProbeOutput(output.stdout)),
                  Effect.catch((error) => {
                    warnings.push(
                      `Login-shell probe failed (${error.message}); using the app's environment.`,
                    );
                    return Effect.succeed({ env: inherited });
                  }),
                );
          return { probed, env: probed.env, warnings };
        }),
      );
      const environment = probe.get;

      const prepare = yield* resettableOnSuccess(
        Effect.gen(function* () {
          const { probed, warnings: probeWarnings } = yield* environment;
          const warnings = [...probeWarnings];
          const candidates = config.binaryPath
            ? [config.binaryPath]
            : [
                ...("commandPath" in probed && probed.commandPath ? [probed.commandPath] : []),
                ...pathCandidates(probed.env, process.platform, "codex"),
              ];
          const binary = yield* resolveBinary(candidates, nodeFs).pipe(
            Effect.mapError(() => unavailable("No codex executable on the login-shell PATH.")),
          );
          const version = yield* runCommand(binary.path, ["--version"], {
            env: probed.env,
            timeoutMs: 15_000,
          }).pipe(
            Effect.map((output) => parseCliVersion(output.stdout)),
            Effect.catch(() => Effect.succeed(undefined)),
          );
          const skew = version === undefined ? undefined : codexVersionWarning(version);
          if (skew) warnings.push(skew);
          return { binaryPath: binary.path, env: probed.env, warnings, cliVersion: version };
        }),
      );

      /**
       * The executable the next app-server starts from: the managed runtime, holding its version
       * until `release`, or the discovered one. The managed one still takes the login-shell env.
       */
      const executable = Effect.gen(function* () {
        const managed = config.runtime === undefined ? undefined : yield* config.runtime.resolve;
        if (managed === undefined) {
          const prepared = yield* prepare.get;
          return { ...prepared, managed: undefined };
        }
        const env = yield* environment.pipe(Effect.onError(() => Effect.sync(managed.release)));
        const skew = codexVersionWarning(managed.version);
        return {
          binaryPath: managed.path,
          cliVersion: managed.version,
          env: env.env,
          warnings: [...env.warnings, ...(skew === undefined ? [] : [skew])],
          managed,
        };
      });

      /**
       * Codex's own catalog, which a gateway catalog has to carry whole; read once, as it only
       * changes with the binary. Run on the gateway home, so the dump never touches `~/.codex`.
       */
      const bundled = new Map<string, Effect.Effect<CodexCatalog | undefined>>();
      const bundledCatalog = (
        home: string,
        prepared: { readonly binaryPath: string; readonly env: Record<string, string> },
      ) =>
        Effect.gen(function* () {
          let cached = bundled.get(prepared.binaryPath);
          if (cached === undefined) {
            cached = yield* Effect.cached(
              Effect.gen(function* () {
                const output = yield* runCommand(
                  prepared.binaryPath,
                  ["debug", "models", "--bundled"],
                  {
                    env: { ...serverEnv(prepared.env), ...config.extraEnv, CODEX_HOME: home },
                    timeoutMs: 15_000,
                  },
                );
                const catalog = output.exitCode === 0 ? parseCatalog(output.stdout) : undefined;
                if (catalog === undefined) {
                  yield* Effect.logWarning(
                    "codex debug models gave no catalog; gateway models run on fallback metadata",
                  );
                }
                return catalog;
              }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`codex debug models failed: ${error.message}`).pipe(
                    Effect.as(undefined),
                  ),
                ),
              ),
            );
            bundled.set(prepared.binaryPath, cached);
          }
          return yield* cached;
        });

      /** The catalog file for `profile`'s models on the gateway home, when Codex lacks any of them. */
      const catalogFor = (
        home: string,
        profile: GatewayProfile,
        prepared: { readonly binaryPath: string; readonly env: Record<string, string> },
      ) =>
        profile.models.length === 0
          ? Effect.succeed(undefined)
          : bundledCatalog(home, prepared).pipe(
              Effect.flatMap((catalog) => {
                const merged =
                  catalog === undefined ? undefined : gatewayCatalog(catalog, profile.models);
                return merged === undefined
                  ? Effect.succeed(undefined)
                  : writeCatalog(home, profile.id, merged);
              }),
              // Without the file Codex runs these models on fallback metadata, which still works.
              Effect.catch((error) =>
                Effect.logWarning(
                  `couldn't write the gateway model catalog: ${error.message}`,
                ).pipe(Effect.as(undefined)),
              ),
            );

      const children = new Set<ChildProcess>();
      const servers = new Map<string, CodexServer>();
      const identities = new WeakMap<
        CodexServer,
        { profileId: ProfileId | undefined; home: CodexHome }
      >();
      /** Marks a server retired, stopping it now if no session holds it. */
      const retirers = new WeakMap<CodexServer, Effect.Effect<void>>();
      /** Writes a running server's `generated` files again when they are gone. */
      const restorers = new WeakMap<CodexServer, Effect.Effect<void>>();
      const lock = yield* Semaphore.make(1);
      // Preparing and releasing the gateway home take turns, so a release can't undo a start's prep.
      const homeLock = yield* Semaphore.make(1);
      // Thread opens on the gateway home take turns; see `CodexServersShape.opening`.
      const openLock = yield* Semaphore.make(1);
      /**
       * Gives a gateway app-server the user's skill folders; a warning for the thread when it won't
       * take them (a Codex without the method), since its threads then run without those skills.
       */
      const addSkillRoots = (
        rpc: CodexRpc,
        userEnv: Readonly<Record<string, string>>,
      ): Effect.Effect<string | undefined> =>
        Effect.gen(function* () {
          const roots =
            config.gatewaySkillRoots === undefined ? [] : yield* config.gatewaySkillRoots(userEnv);
          if (roots.length === 0) return undefined;
          return yield* rpc.request("skills/extraRoots/set", { extraRoots: [...roots] }).pipe(
            Effect.timeoutOrElse({
              duration: startupTimeoutMs,
              orElse: () =>
                Effect.fail(
                  new CodexRpcError({
                    method: "skills/extraRoots/set",
                    message: `no answer within ${startupTimeoutMs} ms`,
                  }),
                ),
            }),
            Effect.as(undefined),
            Effect.catch((error) =>
              Effect.succeed(
                `Codex didn't take your skills in ${roots.join(", ")}, so gateway threads run without them: ${error.message}`,
              ),
            ),
          );
        });

      let gatewayChildren = 0;
      // The home is shared with any other Gram on the data dir, whose servers this count
      // doesn't see, so a run that never prepared it leaves it alone.
      let homePrepared = false;
      const releaseIfUnused = homeLock.withPermits(1)(
        Effect.suspend(() => {
          if (gatewayChildren > 0 || !homePrepared || config.releaseGatewayHome === undefined) {
            return Effect.void;
          }
          homePrepared = false;
          return config.releaseGatewayHome;
        }),
      );
      const prepareGatewayHome = (
        prepareHome: NonNullable<CodexServersConfig["gatewayHome"]>,
        userEnv: Readonly<Record<string, string>>,
      ) =>
        // Preparing the home clears a gate rules file a crash left behind, so it waits out an open
        // that has just put one there.
        openLock
          .withPermits(1)(prepareHome(userEnv))
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                homePrepared = true;
              }),
            ),
          );

      yield* Effect.addFinalizer(() =>
        Effect.promise(() => Promise.all([...children].map((child) => stopChild(child)))).pipe(
          // Exit callbacks may be interrupted by shutdown; the owner still releases the home.
          Effect.andThen(releaseIfUnused),
        ),
      );

      const switchExits = new Map<string, boolean>();
      const switchAttempts = new Map<
        string,
        { closed: boolean; spawned: boolean; notStarted: boolean }
      >();
      const run = yield* FiberSet.makeRuntime();
      const ownership = makeThreadOwnership(
        config.threadCloseTimeoutMs ?? 5_000,
        startupTimeoutMs,
        (effect) => {
          run(effect);
        },
      );

      /** A server for `profileId` on `home`; a `cached` one is shared through `servers`. */
      const start = (
        profileId: ProfileId | undefined,
        home: CodexHome,
        cached = true,
        sessionPartitionId?: ThreadId,
        switchStartup?: string,
      ): Effect.Effect<CodexServer, AgentUnavailable> =>
        startFrom(profileId, home, cached, sessionPartitionId, switchStartup).pipe(
          Effect.catchTag("ManagedStartFailed", (failure) =>
            failure.retry && !switchStartup
              ? // The store went back to the version before; one more start runs from that.
                startFrom(profileId, home, cached, sessionPartitionId, switchStartup).pipe(
                  Effect.catchTag("ManagedStartFailed", (again) => Effect.fail(again.error)),
                )
              : Effect.fail(failure.error),
          ),
        );

      const startFrom = (
        profileId: ProfileId | undefined,
        home: CodexHome,
        cached: boolean,
        sessionPartitionId?: ThreadId,
        switchStartup?: string,
      ): Effect.Effect<CodexServer, AgentUnavailable | ManagedStartFailed> => {
        // Until the child exists to release it on exit, a failure here releases the managed hold.
        let managedHold: ManagedCodex | undefined;
        let spawned = false;
        return Effect.gen(function* () {
          const prepared = yield* executable;
          const managed: ManagedCodex | undefined = prepared.managed;
          managedHold = managed;
          if (helperCwd !== undefined && prepared.cliVersion !== CODEX_HELPER_VERSION)
            return yield* unavailable(
              "Codex guided helpers require the qualified CLI 0.162.1. Select that installed runtime, then refresh; unknown or other versions have not been qualified.",
            );
          if (home === "owned" && profileId !== undefined)
            return yield* unavailable(
              "Gateway profiles cannot use the native login home. Start a new gateway session.",
            );
          const credentials =
            profileId === undefined ? undefined : yield* gateway.credentials(profileId, "codex");
          const userEnv = { ...prepared.env, ...config.extraEnv };
          const prepareHome =
            home === "owned"
              ? !cached
                ? (config.ownedHome?.history ?? config.ownedHome?.prepare)
                : config.ownedHome?.prepare
              : config.gatewayHome;
          const serverHome =
            home !== "user" && prepareHome !== undefined
              ? yield* homeLock.withPermits(1)(
                  Effect.sync(() => {
                    if (home === "gateway") gatewayChildren++;
                  }).pipe(
                    Effect.andThen(
                      home === "gateway"
                        ? prepareGatewayHome(prepareHome, userEnv)
                        : openLock.withPermits(1)(prepareHome(userEnv)),
                    ),
                  ),
                )
              : undefined;
          if (home === "owned" && serverHome === undefined)
            return yield* unavailable("Gram's native Codex home could not be prepared.");
          const env: Record<string, string> = {
            ...serverEnv(prepared.env, credentials),
            ...config.extraEnv,
            ...(serverHome === undefined ? {} : { CODEX_HOME: serverHome }),
          };
          if (helperCwd !== undefined || home === "owned") {
            for (const name of Object.keys(env))
              if (
                /^(OPENAI_API_KEY|OPENAI_BASE_URL|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|LLM_API_KEY)$/i.test(
                  name,
                )
              )
                delete env[name];
          }
          const catalog =
            serverHome === undefined || credentials === undefined
              ? undefined
              : yield* catalogFor(serverHome, credentials.profile, prepared);
          const configFile = serverHome === undefined ? undefined : join(serverHome, "config.toml");
          const generated = [configFile, catalog].filter((path) => path !== undefined);
          const attempt =
            switchStartup === undefined ? undefined : switchAttempts.get(switchStartup);
          if (attempt !== undefined) {
            if (attempt.closed || attempt.spawned)
              return yield* unavailable("This switch attempt no longer permits a child to start.");
            attempt.spawned = true;
          }
          const child = spawnServe(
            prepared.binaryPath,
            helperCwd !== undefined
              ? helperAppServerArgs()
              : appServerArgs(credentials?.profile, catalog, home === "owned"),
            env,
            { stdin: "pipe", ...(helperCwd === undefined ? {} : { cwd: helperCwd }) },
          );
          if (switchStartup !== undefined) {
            protectChildForSwitch(child);
            switchExits.set(switchStartup, false);
            child.once("exit", () => switchExits.set(switchStartup, true));
          }
          spawned = true;
          const key = cacheKey(profileId, home, sessionPartitionId);
          children.add(child);
          if (managed !== undefined) {
            // A spawn that fails outright emits only `error`; `release` runs once either way.
            child.once("exit", managed.release);
            child.once("error", managed.release);
          }
          const listeners = new Map<string, Set<CodexListener>>();
          // Set once built; a child that exits during `initialize` never was.
          let self: CodexServer | undefined;
          let threadOwner: ReturnType<typeof ownership.owner> | undefined;
          child.once("exit", () => {
            threadOwner?.exit();
            children.delete(child);
            // A retired server's key may already belong to its replacement.
            if (self !== undefined && servers.get(key) === self) servers.delete(key);
            for (const set of listeners.values()) for (const listener of set) listener.exit();
            if (home === "gateway" && serverHome !== undefined) {
              gatewayChildren--;
              run(
                releaseIfUnused.pipe(
                  Effect.onError((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.void
                      : Effect.logError("codex gateway home release failed", cause),
                  ),
                ),
              );
            }
          });
          let users = 0;
          let retired = false;
          const stopIfUnused = Effect.suspend(() =>
            retired && users === 0 ? Effect.promise(() => stopChild(child)) : Effect.void,
          );

          const rpc = yield* childIo(child).pipe(
            Effect.flatMap((io) =>
              makeCodexRpc(io, (message) => {
                if (message.method === "thread/closed")
                  threadOwner?.closed(message.params.threadId);
              }),
            ),
            Effect.provideService(Scope.Scope, layerScope),
          );
          // Resolve path aliases without reading any credential/config file.
          threadOwner = ownership.owner(homeIdentity(env), rpc, () => {
            // A last thread-scope close makes this child unsuitable for cached reopen: its
            // recorder can still own the writer after unsubscribe/closed. Retire this exact
            // child, never its replacement; held siblings keep it until their own scopes end.
            retired = true;
            if (self !== undefined && servers.get(key) === self) servers.delete(key);
            if (users === 0) run(stopIfUnused);
          });
          if (!children.has(child)) threadOwner.exit();
          const ownedThreads = threadOwner;
          yield* Effect.forkIn(
            Stream.runForEach(rpc.messages, (message) =>
              Effect.sync(() => {
                const threadId = threadOf(message);
                const route = threadId ?? (isServerRequest(message) ? undefined : SERVER_WIDE);
                const set = route === undefined ? undefined : listeners.get(route);
                if (set !== undefined) for (const listener of set) listener.message(message);
                else if (isServerRequest(message)) {
                  // Nobody can answer it: decline rather than leave the agent waiting.
                  run(
                    rpc
                      .respond(message.id, { decision: "cancel" })
                      .pipe(
                        Effect.onError((cause) =>
                          Cause.hasInterruptsOnly(cause)
                            ? Effect.void
                            : Effect.logError("codex orphan request response failed", cause),
                        ),
                      ),
                  );
                }
              }),
            ),
            layerScope,
          );

          yield* rpc
            .request("initialize", {
              clientInfo: { name: "gram", title: "Gram", version: CODEX_CLI_VERSION },
              capabilities: { experimentalApi: true, requestAttestation: false },
            })
            .pipe(
              Effect.timeoutOrElse({
                duration: startupTimeoutMs,
                orElse: () =>
                  Effect.fail(
                    new CodexRpcError({
                      method: "initialize",
                      message: `no answer within ${startupTimeoutMs} ms`,
                    }),
                  ),
              }),
              Effect.andThen(rpc.notify("initialized")),
              Effect.tapError(() => Effect.promise(() => stopChild(child))),
              Effect.mapError((error) => unavailable(`Codex didn't start: ${error.message}`)),
              Effect.catch((error): Effect.Effect<never, AgentUnavailable | ManagedStartFailed> =>
                managed === undefined
                  ? Effect.fail(error)
                  : managed
                      .failed(error.message)
                      .pipe(
                        Effect.flatMap((retry) =>
                          Effect.fail(new ManagedStartFailed({ error, retry })),
                        ),
                      ),
              ),
            );
          if (managed !== undefined) yield* managed.started;
          const skillsWarning =
            serverHome === undefined ? undefined : yield* addSkillRoots(rpc, userEnv);

          const server: CodexServer = {
            protectSwitchStartup: (attemptId) =>
              Effect.gen(function* () {
                if (users !== 1 || process.platform === "win32")
                  return yield* new AgentUnavailable({
                    agent: "codex",
                    message:
                      "This Codex child cannot be isolated for a graceful orchestrator switch.",
                  });
                if (!switchExits.has(attemptId)) {
                  switchExits.set(attemptId, false);
                  child.once("exit", () => switchExits.set(attemptId, true));
                }
                const release = protectChildForSwitch(child);
                return Effect.suspend(() =>
                  !retired && users === 1 && acceptChildSwitchStartup(child, release)
                    ? Effect.void
                    : Effect.fail(
                        new AgentUnavailable({
                          agent: "codex",
                          message: "This switch startup no longer owns the active Codex child.",
                        }),
                      ),
                );
              }),
            prepareForSwitch: Effect.gen(function* () {
              if (users !== 1 || process.platform === "win32")
                return yield* new AgentUnavailable({
                  agent: "codex",
                  message:
                    "The previous Codex child has another session or cannot stop gracefully on this platform. No stop was requested.",
                });
              protectChildForSwitch(child);
            }),
            stopForSwitch: Effect.gen(function* () {
              if (users !== 1 || process.platform === "win32")
                return yield* new AgentUnavailable({
                  agent: "codex",
                  message:
                    "The previous Codex child still has another session or cannot stop gracefully on this platform. No replacement was started.",
                });
              // Retire only this exact child. Actual EXIT still owns the writer fence.
              retired = true;
              if (servers.get(key) === server) servers.delete(key);
              const exited = yield* Effect.promise(() => stopChildForSwitch(child));
              if (!exited)
                return yield* new AgentUnavailable({
                  agent: "codex",
                  message:
                    "The previous Codex child did not exit after a graceful stop. No replacement was started; its ownership remains held.",
                });
            }),
            rpc,
            configCurrent: Effect.sync(() => !retired && servers.get(key) === server),
            waitForThreadExit: ownedThreads.waitForExit,
            cliVersion: prepared.cliVersion,
            openThread: ownedThreads.open,
            gateway: credentials !== undefined,
            warnings:
              skillsWarning === undefined
                ? prepared.warnings
                : [...prepared.warnings, skillsWarning],
            subscribe: (threadId, listener) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  let set = listeners.get(threadId);
                  if (set === undefined) {
                    set = new Set();
                    listeners.set(threadId, set);
                  }
                  set.add(listener);
                  if (!children.has(child)) listener.exit();
                }),
                () =>
                  Effect.sync(() => {
                    const set = listeners.get(threadId);
                    set?.delete(listener);
                    if (set?.size === 0) listeners.delete(threadId);
                  }),
              ),
            // Checking `retired` and counting the user in one step leaves no gap for `invalidate`.
            retain: Effect.acquireRelease(
              Effect.sync(() => {
                if (retired) return false;
                users++;
                return true;
              }),
              (held) =>
                held
                  ? Effect.suspend(() => {
                      users--;
                      return stopIfUnused;
                    })
                  : Effect.void,
            ),
            generated,
          };
          // Codex reads `config.toml` and `model_catalog_json` again on every thread open, and a
          // catalog that is gone fails it with only "No such file or directory".
          restorers.set(
            server,
            Effect.gen(function* () {
              const lost = generated.filter((path) => !existsSync(path));
              if (lost.length === 0) return;
              yield* Effect.logWarning(
                `codex gateway home lost ${lost.join(", ")} while its app-server ran; writing ${lost.length === 1 ? "it" : "them"} again`,
              );
              if (
                prepareHome !== undefined &&
                configFile !== undefined &&
                lost.includes(configFile)
              ) {
                yield* homeLock.withPermits(1)(
                  home === "gateway"
                    ? prepareGatewayHome(prepareHome, userEnv)
                    : openLock.withPermits(1)(prepareHome(userEnv)),
                );
              }
              if (
                serverHome !== undefined &&
                credentials !== undefined &&
                catalog !== undefined &&
                lost.includes(catalog)
              ) {
                yield* catalogFor(serverHome, credentials.profile, prepared);
              }
            }),
          );
          retirers.set(
            server,
            Effect.suspend(() => {
              retired = true;
              return stopIfUnused;
            }),
          );
          self = server;
          identities.set(server, { profileId, home });
          if (cached) servers.set(key, server);
          return server;
        }).pipe(
          Effect.catchDefect(() =>
            Effect.fail(
              unavailable(
                "Codex home preparation or startup failed; check your native login and Gram data directory.",
              ),
            ),
          ),
          Effect.onError(() =>
            Effect.sync(() => {
              if (!spawned) managedHold?.release();
            }),
          ),
        );
      };

      const acquire = (
        profileId: ProfileId | undefined,
        home: CodexHome,
        sessionPartitionId?: ThreadId,
        switchStartup?: string,
      ) =>
        Effect.suspend(() => {
          const attempt =
            switchStartup === undefined
              ? undefined
              : { closed: false, spawned: false, notStarted: false };
          if (attempt !== undefined) {
            if (switchAttempts.has(switchStartup!))
              return unavailable("This switch startup attempt was already used.");
            switchAttempts.set(switchStartup!, attempt);
          }
          return lock
            .withPermits(1)(
              Effect.suspend(() => {
                const existing = servers.get(cacheKey(profileId, home, sessionPartitionId));
                if (existing !== undefined && attempt !== undefined) attempt.spawned = true;
                return existing === undefined
                  ? start(profileId, home, true, sessionPartitionId, switchStartup)
                  : (restorers.get(existing) ?? Effect.void).pipe(Effect.as(existing));
              }),
            )
            .pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (attempt !== undefined && Exit.isFailure(exit)) {
                    attempt.closed = true;
                    if (!attempt.spawned) attempt.notStarted = true;
                  }
                }),
              ),
            );
        });

      const opening =
        (home: CodexHome, gate: OutwardGate | undefined) =>
        <A, E, R>(open: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
          if (home === "user") return open;
          const refresh = home === "owned" ? config.ownedHome?.refresh : config.refreshGatewayHome;
          const refreshed =
            refresh === undefined
              ? Effect.void
              : environment.pipe(
                  Effect.map((found) => found.env),
                  Effect.orElseSucceed(() => inherited),
                  Effect.flatMap((env) => refresh({ ...env, ...config.extraEnv })),
                );
          const rules = home === "owned" ? config.ownedHome?.rules : config.gateRules;
          return openLock.withPermits(1)(
            refreshed.pipe(
              Effect.andThen(
                rules === undefined
                  ? open
                  : gate === undefined
                    ? rules.remove.pipe(Effect.andThen(open))
                    : rules.install(gate).pipe(Effect.andThen(open), Effect.ensuring(rules.remove)),
              ),
            ),
          );
        };

      /** Retires the profile's servers on both homes. Holds no lock: the caller takes it. */
      const retireProfile = (profileId: ProfileId | undefined) =>
        Effect.suspend(() =>
          Effect.forEach(
            [...servers].filter(([, server]) => identities.get(server)?.profileId === profileId),
            ([key, server]) => {
              servers.delete(key);
              return retirers.get(server) ?? Effect.void;
            },
            { discard: true },
          ),
        );

      return {
        switchAttemptReceipt: (id) =>
          Effect.sync(() =>
            switchExits.get(id) === true
              ? "exited"
              : switchAttempts.get(id)?.notStarted
                ? "notStarted"
                : undefined,
          ),
        switchAttemptReleased: (id) =>
          Effect.sync(
            () => switchExits.get(id) === true || switchAttempts.get(id)?.notStarted === true,
          ),
        acquire,
        opening,
        gateReady: config.gatewayHome !== undefined && config.gateRules !== undefined,
        gateReadyFor: (home) =>
          home === "owned"
            ? config.ownedHome !== undefined
            : home === "gateway" &&
              config.gatewayHome !== undefined &&
              config.gateRules !== undefined,
        nativeGateReady:
          config.ownedHome === undefined
            ? Effect.succeed(false)
            : openLock.withPermits(1)(
                Effect.gen(function* () {
                  const { env } = yield* environment;
                  yield* config.ownedHome!.prepare({ ...env, ...config.extraEnv });
                  yield* config.ownedHome!.rules.install("all");
                }).pipe(
                  Effect.ensuring(config.ownedHome.rules.remove),
                  Effect.as(true),
                  Effect.catchCause(() => Effect.succeed(false)),
                ),
              ),
        retireAll: lock.withPermits(1)(
          Effect.suspend(() => {
            const retiring = [...servers.values()];
            servers.clear();
            // The next server resolves the executable again, and reads its own catalog: an update
            // can move the realpath (Homebrew) or replace the binary at the same one (npm).
            bundled.clear();
            return Effect.all([probe.reset, prepare.reset]).pipe(
              Effect.andThen(
                Effect.forEach(retiring, (server) => retirers.get(server) ?? Effect.void, {
                  discard: true,
                }),
              ),
            );
          }),
        ),
        invalidate: (profileId) => lock.withPermits(1)(retireProfile(profileId)),
        retire: (profileId) =>
          lock.withPermits(1)(
            Effect.suspend(() => {
              // As for `retireAll`, for the one profile.
              bundled.clear();
              return Effect.all([probe.reset, prepare.reset]).pipe(
                Effect.andThen(retireProfile(profileId)),
              );
            }),
          ),
        running: Effect.sync(() =>
          [...servers.values()].map((server) => ({
            server,
            home: identities.get(server)!.home,
          })),
        ),
        homes: [
          "user",
          ...(config.ownedHome === undefined ? [] : ["owned" as const]),
          ...(config.gatewayHome === undefined ? [] : ["gateway" as const]),
        ],
        history: (home) =>
          home === "user"
            ? acquireHeld(acquire(undefined, "user"))
            : // Not cached, and unused once released, so retiring it stops it at once.
              Effect.acquireRelease(
                start(undefined, home, false),
                (server) => retirers.get(server) ?? Effect.void,
              ),
      } satisfies CodexServersShape;
    }),
  );
