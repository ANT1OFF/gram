import { type CodexRuntimeSource, codexSmokeTest, type ManagedCodex } from "@gram/agents/codex";
import {
  AgentUnavailable,
  type ManagedInstall,
  type RuntimeAgent,
  RuntimeInstallRefused,
  type RuntimeInstallState,
  type RuntimeRefusal,
  type RuntimeSourceChoice,
} from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Proc } from "@gram/git";
import { ServerConfig } from "../config.ts";
import { CODEX_BASELINE } from "./codex-baseline.ts";
import {
  codexTarget,
  compareVersions,
  gate,
  type GateContext,
  type GateRefusal,
  type RuntimeArtifact,
} from "./gate.ts";
import { makeLeases } from "./leases.ts";
import { npmPackDownloader } from "./npm-pack.ts";
import {
  makeRuntimeStore,
  runtimeRoot,
  versionId,
  type ActiveRecord,
  type RuntimeReceipt,
} from "./store.ts";
import {
  activate,
  keepSet,
  rollback as rollbackTransaction,
  stage,
  type Downloader,
  type InstallPhase,
  type TransactionDeps,
} from "./transaction.ts";

/** What the RPC layer hands the managed store once it exists; see `ManagedRuntimesShape.connect`. */
interface ManagedRuntimeHooks {
  /** The persisted "Use Gram-managed Codex" choice. */
  readonly readSource: Effect.Effect<RuntimeSourceChoice>;
  readonly writeSource: (source: RuntimeSourceChoice) => Effect.Effect<void>;
  /** Codex sessions with a turn (or background work) under way. */
  readonly busySessions: Effect.Effect<number>;
  /**
   * The executable changed: retire Codex's app-servers and reopen each live Codex session once it
   * is idle, so new turns run on the new one and no running turn is touched.
   */
  readonly switched: Effect.Effect<void>;
}

export interface ManagedRuntimesShape {
  /** For the Codex adapter: the managed executable when the user chose it. */
  readonly codexSource: CodexRuntimeSource;
  /** Whether the store can install `agent` on this machine. */
  readonly serves: (agent: RuntimeAgent) => boolean;
  /** The runtime new managed sessions start from. */
  readonly active: (agent: RuntimeAgent) => Effect.Effect<ManagedInstall | undefined>;
  /** Whether the user chose the managed runtime for `agent`. */
  readonly source: (agent: RuntimeAgent) => Effect.Effect<RuntimeSourceChoice>;
  /** What the gate would install now, newest first. */
  readonly allowed: (
    agent: RuntimeAgent,
  ) => Effect.Effect<ReadonlyArray<{ readonly version: string; readonly channel: "stable" }>>;
  readonly state: (
    agent: RuntimeAgent,
  ) => Effect.Effect<RuntimeInstallState, RuntimeInstallRefused>;
  readonly watch: (
    agent: RuntimeAgent,
  ) => Stream.Stream<RuntimeInstallState, RuntimeInstallRefused>;
  readonly install: (
    agent: RuntimeAgent,
    version: string,
  ) => Effect.Effect<RuntimeInstallState, RuntimeInstallRefused>;
  readonly cancel: (
    agent: RuntimeAgent,
  ) => Effect.Effect<RuntimeInstallState, RuntimeInstallRefused>;
  readonly rollback: (
    agent: RuntimeAgent,
  ) => Effect.Effect<RuntimeInstallState, RuntimeInstallRefused>;
  readonly useSource: (
    agent: RuntimeAgent,
    source: RuntimeSourceChoice,
  ) => Effect.Effect<void, RuntimeInstallRefused>;
  /** Installs the hooks; until then the source reads as the user's own and nothing switches. */
  readonly connect: (hooks: ManagedRuntimeHooks) => Effect.Effect<void>;
}

/**
 * Gram's managed Codex: the per-user store, its install, update and rollback transaction,
 * and the executable the Codex adapter starts when the user chose it. Built before the agent hosts
 * (which read `codexSource`) and connected to settings and sessions late, by the RPC handlers.
 */
export class ManagedRuntimes extends Context.Service<ManagedRuntimes, ManagedRuntimesShape>()(
  "@gram/server/ManagedRuntimes",
) {
  static readonly layer: Layer.Layer<ManagedRuntimes, never, ServerConfig | Proc> = Layer.effect(
    ManagedRuntimes,
  )(
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const proc = yield* Proc;
      return yield* makeManagedRuntimes({
        downloader: npmPackDownloader(proc),
        root: runtimeRoot(config.dataDir),
        appVersion: config.appVersion ?? "0.0.0",
      });
    }),
  );
}

export interface ManagedRuntimesOptions {
  readonly root: string;
  readonly appVersion: string;
  readonly downloader: Downloader;
  readonly smoke?: TransactionDeps["smoke"];
  readonly baseline?: ReadonlyArray<RuntimeArtifact>;
  readonly target?: string | undefined;
  readonly now?: () => number;
  /** How often a staged update checks whether Codex is idle yet. */
  readonly idlePollMs?: number;
}

/** Variables the smoke test's Codex gets: enough to run, and none of the user's credentials. */
const SMOKE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "SystemRoot",
  "SYSTEMROOT",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "ComSpec",
  "PATHEXT",
];

const smokeEnv = (): Record<string, string> =>
  Object.fromEntries(
    SMOKE_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value] as const];
    }),
  );

const refused = (reason: RuntimeRefusal, message: string) =>
  new RuntimeInstallRefused({ agent: "codex", reason, message });

const refusalFor = (refusal: GateRefusal): RuntimeInstallRefused => {
  switch (refusal.reason) {
    case "too-new":
      return refused("not-eligible", refusal.message);
    case "not-qualified":
      return refused("not-qualified", refusal.message);
    case "wrong-platform":
      return refused("unsupported", refusal.message);
    default:
      return refused("unverified", refusal.message);
  }
};

const onlyCodex = (agent: RuntimeAgent) =>
  agent === "codex"
    ? Effect.void
    : Effect.fail(
        new RuntimeInstallRefused({
          agent,
          reason: "unsupported",
          message: "Gram manages only Codex's runtime for now.",
        }),
      );

const unavailable = (message: string) =>
  new AgentUnavailable({ agent: "codex", reason: "startup-failed", message });

const installOf = (store: ReturnType<typeof makeRuntimeStore>, receipt: RuntimeReceipt) =>
  ({
    version: receipt.version,
    sha256: receipt.archiveSha256,
    path: store.executable(receipt),
    installedAt: Date.parse(receipt.installedAt),
  }) satisfies ManagedInstall;

export const makeManagedRuntimes = (
  options: ManagedRuntimesOptions,
): Effect.Effect<ManagedRuntimesShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const store = makeRuntimeStore(options.root, "codex");
    const leases = makeLeases();
    const target = "target" in options ? options.target : codexTarget();
    const now = options.now ?? Date.now;
    const context = (): GateContext => ({ appVersion: options.appVersion, target, now: now() });
    const deps: TransactionDeps = {
      store,
      leases,
      downloader: options.downloader,
      smoke:
        options.smoke ??
        ((executable, version) =>
          codexSmokeTest(executable, { expectedVersion: version, env: smokeEnv() })),
      context,
    };
    const scope = yield* Effect.scope;
    const run = yield* FiberSet.makeRuntime();
    let hooks: ManagedRuntimeHooks | undefined;
    /** Writes to `active.json` take turns: an install's activation, a rollback, a first start. */
    const writes = yield* Semaphore.make(1);
    let record: ActiveRecord = {};
    const recovered = yield* Deferred.make<void>();

    const settled = (r: ActiveRecord) => ({
      ...(r.current === undefined ? {} : { active: installOf(store, r.current) }),
      ...(r.previous === undefined ? {} : { previous: installOf(store, r.previous) }),
    });
    const ref = yield* SubscriptionRef.make<RuntimeInstallState>({ state: "idle" });
    const publish = (state: RuntimeInstallState) => SubscriptionRef.set(ref, state);
    const reload = Effect.promise(() => store.readActive()).pipe(
      Effect.tap((next) =>
        Effect.sync(() => {
          record = next;
        }),
      ),
    );
    /** Republishes the settled part of the state, keeping an in-flight or outcome state's kind. */
    const refreshSettled = Effect.gen(function* () {
      const next = yield* reload;
      const current = yield* SubscriptionRef.get(ref);
      yield* publish(settledReplace(current, settled(next)));
    });

    /** An install's staged version, from before its smoke test until it is selected or dropped. */
    const staging = new Set<string>();
    const prune = Effect.promise(() =>
      store.prune(new Set([...keepSet(record, leases), ...staging])),
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("managed runtime prune failed", cause),
      ),
    );
    yield* Effect.acquireRelease(
      Effect.sync(() => leases.onIdle(() => run(writes.withPermits(1)(prune)))),
      (stop) => Effect.sync(stop),
    );

    // Startup recovery runs beside the server's own start; the first resolve waits for it.
    yield* Effect.forkIn(
      Effect.promise(() => store.recover()).pipe(
        Effect.flatMap(() => reload),
        Effect.flatMap(() => prune),
        Effect.flatMap(() => refreshSettled),
        Effect.catchCause((cause) => Effect.logWarning("managed runtime recovery failed", cause)),
        Effect.ensuring(Deferred.succeed(recovered, undefined)),
      ),
      scope,
    );
    const ready = Deferred.await(recovered);

    const artifacts = options.baseline ?? CODEX_BASELINE;

    /** Whether going back to `receipt` is still allowed: approved here, and through the gate. */
    const stillApproved = (receipt: RuntimeReceipt) =>
      artifacts.some(
        (a) =>
          a.version === receipt.version &&
          a.target === receipt.target &&
          a.sha256 === receipt.archiveSha256 &&
          gate(a, context()) === undefined,
      );

    const sourceOf = Effect.suspend(() => hooks?.readSource ?? Effect.succeed("path" as const));

    /** What may be installed now, newest first: what passes the gate. */
    const allowedArtifacts = Effect.sync(() =>
      artifacts
        .filter((artifact) => gate(artifact, context()) === undefined)
        .toSorted((a, b) => compareVersions(b.version, a.version)),
    );

    /** The install under way; `installing` is set before it forks, so two can't start. */
    let job: Fiber.Fiber<void, never> | undefined;
    let installing = false;

    const describePhase = (version: string, phase: InstallPhase): RuntimeInstallState => {
      const base = settled(record);
      switch (phase.phase) {
        case "downloading":
          return {
            state: "downloading",
            version,
            receivedBytes: phase.received,
            totalBytes: phase.total,
            ...base,
          };
        case "testing":
          return { state: "testing", version, ...base };
        default:
          return { state: "verifying", version, ...base };
      }
    };

    /** Waits until no Codex session the switch would affect is mid-turn, showing how many are. */
    const untilIdle = (version: string) =>
      Effect.gen(function* () {
        while (true) {
          const source = yield* sourceOf;
          const busy = source === "managed" && hooks !== undefined ? yield* hooks.busySessions : 0;
          if (busy === 0) return;
          yield* publish({ state: "ready", version, activeSessions: busy, ...settled(record) });
          yield* Effect.sleep(options.idlePollMs ?? 2_000);
        }
      });

    const switched = Effect.gen(function* () {
      if (hooks === undefined || (yield* sourceOf) !== "managed") return;
      yield* hooks.switched;
    });

    const runInstall = (artifact: RuntimeArtifact) =>
      Effect.gen(function* () {
        staging.add(versionId(artifact.version, artifact.target));
        const staged = yield* stage(deps, artifact, (phase) => {
          run(
            publish(describePhase(artifact.version, phase)).pipe(
              Effect.onError((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("managed runtime progress failed", cause),
              ),
            ),
          );
        });
        if (!staged.selected) {
          yield* untilIdle(artifact.version);
          // Selected and handed over together: once `active.json` changes, the app-servers are
          // retired and sessions reopen, whatever a Cancel says.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* writes.withPermits(1)(
                activate(deps, staged.receipt, () => {}).pipe(Effect.ensuring(reload)),
              );
              staging.clear();
              yield* switched;
            }),
          );
        }
        yield* publish({ state: "idle", ...settled(record) });
      }).pipe(
        Effect.catch((error) =>
          reload.pipe(
            Effect.andThen(
              error._tag === "RuntimeRefused" && error.reason === "too-new"
                ? // The registry is holding it back for a day, as we would: nothing went wrong, and
                  // Update comes back once it is offered.
                  Effect.logInfo(`managed Codex ${artifact.version}: ${error.message}`).pipe(
                    Effect.andThen(publish({ state: "idle", ...settled(record) })),
                  )
                : publish({
                    state: "failed",
                    version: artifact.version,
                    message: error.message,
                    ...settled(record),
                  }),
            ),
          ),
        ),
        Effect.onInterrupt(() =>
          // Cancelled: what was staged but never selected goes, and the state is as it was.
          reload.pipe(
            Effect.andThen(Effect.sync(() => staging.clear())),
            Effect.andThen(writes.withPermits(1)(prune)),
            Effect.andThen(publish({ state: "idle", ...settled(record) })),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            staging.clear();
            installing = false;
            job = undefined;
          }),
        ),
      );

    /** The rest of `install`, once the store is reserved for it. */
    const admit = (version: string) =>
      Effect.gen(function* () {
        const candidates = artifacts.filter((a) => a.version === version && a.target === target);
        if (candidates.length === 0) {
          return yield* target === undefined
            ? refused("unsupported", "Gram can't manage Codex on this machine.")
            : refused(
                "not-approved",
                `Codex ${version} isn't one Gram has approved for this machine.`,
              );
        }
        const passing = candidates.find((a) => gate(a, context()) === undefined);
        if (passing === undefined) return yield* refusalFor(gate(candidates[0]!, context())!);
        yield* publish({
          state: "downloading",
          version,
          receivedBytes: 0,
          totalBytes: passing.size,
          ...settled(record),
        });
        const fiber = yield* Effect.forkIn(runInstall(passing), scope);
        if (installing) job = fiber;
        return yield* SubscriptionRef.get(ref);
      });

    const codexSource: CodexRuntimeSource = {
      resolve: Effect.gen(function* () {
        if ((yield* sourceOf) !== "managed") return undefined;
        yield* ready;
        const current = record.current;
        if (current === undefined) {
          return yield* unavailable(
            "Gram-managed Codex isn't installed: install it in Settings → Agents, or switch back to your own codex there.",
          );
        }
        if (staging.has(current.id)) {
          // Its files are being reinstalled; nothing may start from them until that is verified,
          // and no lease taken now could keep them from being replaced.
          return yield* unavailable(
            `Gram-managed Codex ${current.version} is being repaired; try again once Settings → Agents shows it done.`,
          );
        }
        if (!(yield* Effect.promise(() => store.intact(current)))) {
          return yield* unavailable(
            `Gram-managed Codex ${current.version} changed on disk since it was verified, so it won't be run. Install it again in Settings → Agents.`,
          );
        }
        // Checked again with no yield before the lease: a repair that began while this resolve
        // awaited the checks above must not find a lease appear after its own in-use check.
        if (staging.has(current.id)) {
          return yield* unavailable(
            `Gram-managed Codex ${current.version} is being repaired; try again once Settings → Agents shows it done.`,
          );
        }
        const release = leases.acquire(current.id);
        const managed: ManagedCodex = {
          path: store.executable(current),
          version: current.version,
          release,
          started: writes
            .withPermits(1)(
              Effect.gen(function* () {
                const latest = yield* reload;
                if (latest.unproven !== true || latest.current?.id !== current.id) return;
                const { unproven: _proven, ...rest } = latest;
                yield* Effect.promise(() => store.writeActive(rest));
                yield* reload;
              }),
            )
            .pipe(Effect.catchCause(() => Effect.void)),
          failed: (message) =>
            writes
              .withPermits(1)(
                Effect.gen(function* () {
                  const latest = yield* reload;
                  // Only a version that has never started a session is blamed for not starting.
                  if (latest.unproven !== true || latest.current?.id !== current.id) return false;
                  if (latest.previous === undefined) return false;
                  // Going back only to what may still run: a predecessor the gate refuses stays put.
                  if (!stillApproved(latest.previous)) return false;
                  yield* rollbackTransaction(deps, message).pipe(Effect.ensuring(reload));
                  yield* publish({
                    state: "rolledBack",
                    from: current.version,
                    message,
                    ...settled(record),
                  });
                  yield* Effect.logWarning(
                    `managed Codex ${current.version} didn't start; rolled back to ${record.current?.version}`,
                  );
                  return true;
                }),
              )
              .pipe(Effect.catch(() => Effect.succeed(false))),
        };
        return managed;
      }),
    };

    return {
      codexSource,
      serves: (agent) => agent === "codex" && target !== undefined,
      active: (agent) =>
        agent !== "codex"
          ? Effect.succeed(undefined)
          : ready.pipe(
              Effect.map(() =>
                record.current === undefined ? undefined : installOf(store, record.current),
              ),
            ),
      source: (agent) => (agent === "codex" ? sourceOf : Effect.succeed("path" as const)),
      allowed: (agent) =>
        agent !== "codex"
          ? Effect.succeed([])
          : allowedArtifacts.pipe(
              Effect.map((list) =>
                list.map((a) => ({ version: a.version, channel: "stable" as const })),
              ),
            ),
      state: (agent) =>
        onlyCodex(agent).pipe(Effect.andThen(ready), Effect.andThen(SubscriptionRef.get(ref))),
      watch: (agent) =>
        Stream.unwrap(
          onlyCodex(agent).pipe(Effect.andThen(ready), Effect.as(SubscriptionRef.changes(ref))),
        ),
      install: (agent, version) =>
        Effect.gen(function* () {
          yield* onlyCodex(agent);
          yield* ready;
          if (installing) {
            return yield* refused("busy", "An install of Codex is already under way.");
          }
          // Reserved before anything yields, so a second request can't also pass the check.
          installing = true;
          return yield* admit(version).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                installing = false;
              }),
            ),
          );
        }),
      cancel: (agent) =>
        Effect.gen(function* () {
          yield* onlyCodex(agent);
          const running = job;
          // Activation is uninterruptible, so a cancel that arrives then waits for it to finish.
          if (running !== undefined) yield* Fiber.interrupt(running);
          return yield* SubscriptionRef.get(ref);
        }),
      rollback: (agent) =>
        Effect.gen(function* () {
          yield* onlyCodex(agent);
          yield* ready;
          if (installing) {
            return yield* refused("busy", "Wait for the Codex install under way, or cancel it.");
          }
          // Checked and switched under the write lock, on the record as it is then, so the version
          // checked is the one selected; and with its handoff, so a dropped request can't leave
          // the app-servers on the version `active.json` no longer selects.
          yield* Effect.uninterruptible(
            writes
              .withPermits(1)(
                Effect.gen(function* () {
                  const latest = yield* reload;
                  const previous = latest.previous;
                  if (previous === undefined) {
                    return yield* refused(
                      "nothing-to-roll-back",
                      "There's no earlier Codex to go back to.",
                    );
                  }
                  // A version this build no longer approves isn't run again.
                  if (!stillApproved(previous)) {
                    return yield* refused(
                      "not-qualified",
                      `Codex ${previous.version} is no longer approved for this Gram.`,
                    );
                  }
                  yield* rollbackTransaction(deps).pipe(
                    Effect.ensuring(reload),
                    Effect.mapError((error) =>
                      refused(
                        error._tag === "RuntimeRefused" && error.reason === "no-previous"
                          ? "nothing-to-roll-back"
                          : "unverified",
                        error.message,
                      ),
                    ),
                  );
                }),
              )
              .pipe(Effect.andThen(switched)),
          );
          yield* publish({ state: "idle", ...settled(record) });
          return yield* SubscriptionRef.get(ref);
        }),
      useSource: (agent, source) =>
        Effect.gen(function* () {
          yield* onlyCodex(agent);
          yield* ready;
          if (source === "managed" && record.current === undefined) {
            return yield* refused(
              "unsupported",
              "Install Gram-managed Codex first; until then sessions use your own codex.",
            );
          }
          if (hooks === undefined) return;
          const { readSource, writeSource, switched: handOver } = hooks;
          // Both directions change the executable new sessions start from; the choice and the
          // handoff go together, so a dropped request can't persist one without the other.
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if ((yield* readSource) === source) return;
              yield* writeSource(source);
              yield* handOver;
            }),
          );
        }),
      connect: (next) =>
        Effect.sync(() => {
          hooks = next;
        }),
    } satisfies ManagedRuntimesShape;
  });

/** `next`'s `active`/`previous` in place of `current`'s, dropping keys `next` no longer has. */
const settledReplace = (
  current: RuntimeInstallState,
  next: { readonly active?: ManagedInstall; readonly previous?: ManagedInstall },
): RuntimeInstallState => {
  const { active: _a, previous: _p, ...rest } = current;
  return { ...rest, ...next } as RuntimeInstallState;
};
