import {
  CheckoutInUse,
  type Checkout,
  effectiveCheckout,
  GitError,
  hostOf,
  type HostId,
  type HostUnavailable,
  InvalidState,
  NotFound,
  type Thread,
  type ThreadId,
  ThreadNotFound,
  WorktreeDirty,
} from "@gram/contracts";
import { git, type GitStateRuntime, Proc, type ProcShape, type Worktrees } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { type EventHub, isThreadRemoved } from "../events/event-hub.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { heldCheckoutPaths, usedCheckoutPaths } from "../runtime/create-in-checkout.ts";
import { agentHostOnMachine } from "../runtime/host-agent-sessions.ts";
import type { CheckoutServiceShape } from "../runtime/hooks.ts";
import type { TerminalGate } from "../terminal/gate.ts";
import { terminalsThroughHost } from "../terminal/host-terminals.ts";
import type { Terminals } from "../terminal/terminals.ts";
import type { HostConnection } from "./protocol.ts";
import type { RemoteHostsShape } from "./remote-hosts.ts";
import { cloneFolderOf } from "./repos.ts";
import type { WorkerHost } from "./worker-host.ts";

/** A joined machine as its worker host is named and reached. */
export interface Machine {
  readonly id: HostId;
  readonly name: string;
  /** The tailnet address it dialled, where its sessions reach their app tools; absent offline. */
  readonly origin?: () => string | undefined;
}

const offline = (machine: Machine) => `${machine.name} is offline.`;

/** Terminals that aren't there: a machine's host that went took its shells with it. */
const noTerminals = (machine: Machine): Terminals => ({
  open: () => Effect.fail(new InvalidState({ message: offline(machine) })),
  input: (terminalId) => Effect.fail(new NotFound({ entity: "terminal", id: terminalId })),
  resize: (terminalId) => Effect.fail(new NotFound({ entity: "terminal", id: terminalId })),
  close: () => Effect.void,
  list: () => Effect.succeed([]),
  subscribe: (terminalId) => Stream.fail(new NotFound({ entity: "terminal", id: terminalId })),
  snapshot: () => Effect.succeed([]),
});

/** The thread's checkouts that are on `machine`: its own, and any other repo's there. */
const ownCheckouts = (thread: Thread, machine: Machine) =>
  [thread.checkout, ...(thread.extraCheckouts ?? [])].filter(
    (checkout) => hostOf(checkout) === machine.id,
  );

const repoOf = (checkout: Checkout) => checkout.repoRoot ?? checkout.path;

/** The threads on `machine`, for the one-thread-per-worktree guard there. */
const onMachine = (threads: ReadonlyArray<Thread>, machine: Machine) =>
  threads.filter((thread) => hostOf(effectiveCheckout(thread)) === machine.id);

/**
 * The checkouts of the workers placed on `machine`, all of them worktrees made from the host's own
 * clone of the project's repository, which it finds by the project's `origin` here. The host's own
 * worktree code does the work, its refusals kept as this machine's checkouts give them: a dirty
 * worktree isn't removed without force, and an open one isn't taken twice. A checkout on the
 * machine records its id, so everything that reads it later goes back there.
 */
export const machineCheckouts = (
  machine: Machine,
  connection: HostConnection,
  deps: { readonly proc: ProcShape; readonly threads: Effect.Effect<ReadonlyArray<Thread>> },
): CheckoutServiceShape => {
  const others = (thread: Thread | undefined) =>
    Effect.map(deps.threads, (threads) =>
      usedCheckoutPaths(onMachine(threads, machine).filter((t) => t.id !== thread?.id)),
    );

  /** The project's remote, read here: the host clones the same repository. */
  const originOf = (projectRoot: string) =>
    git(projectRoot, ["remote", "get-url", "origin"]).pipe(
      Effect.provideService(Proc, deps.proc),
      Effect.mapError((error) => new GitError({ message: error.message })),
      Effect.flatMap((out) => {
        const url = out.stdout.trim();
        if (out.status === 0 && url !== "") {
          // Checked here too, so a token in the URL never leaves this machine.
          const filed = cloneFolderOf(url);
          return "error" in filed
            ? Effect.fail(new InvalidState({ message: filed.error }))
            : Effect.succeed(url);
        }
        return Effect.fail(
          new InvalidState({
            message: `A worker on ${machine.name} needs the project's origin remote, and ${projectRoot} has none.`,
          }),
        );
      }),
    );

  const refuseDirty = (checkout: Checkout) =>
    Effect.gen(function* () {
      if (checkout.kind !== "worktree") return;
      const state = yield* connection.git.local(checkout.path).pipe(
        Effect.mapError(
          () =>
            new GitError({
              message: `Couldn't read ${checkout.path} on ${machine.name}, so it isn't removed.`,
            }),
        ),
      );
      if (state.changedFiles > 0)
        return yield* new WorktreeDirty({ path: checkout.path, changedFiles: state.changedFiles });
    });

  return {
    prepare: (request, openCheckouts, projectRoot) =>
      Effect.gen(function* () {
        if (request.kind !== "newWorktree")
          return yield* new InvalidState({
            message: `A worker on ${machine.name} works in a new worktree there.`,
          });
        const url = yield* originOf(projectRoot);
        const { path: repoPath } = yield* connection.repos
          .ensure(url)
          .pipe(
            Effect.mapError((error) =>
              error.reason === "failed"
                ? new GitError({ message: error.message })
                : new InvalidState({ message: error.message }),
            ),
          );
        const created = yield* connection.worktrees
          .create({
            repoPath,
            branch: request.branch,
            ...(request.base === undefined ? {} : { base: request.base }),
            openCheckouts,
          })
          .pipe(
            Effect.mapError((error) =>
              error.reason === "conflict"
                ? new CheckoutInUse({ path: repoPath, message: error.message })
                : error.reason === "invalidRequest"
                  ? new InvalidState({ message: error.message })
                  : new GitError({ message: error.message }),
            ),
          );
        return {
          ...created.checkout,
          repoRoot: created.checkout.repoRoot ?? repoPath,
          hostId: machine.id,
        };
      }),
    checkRelease: (thread, options) =>
      options.removeWorktree === undefined || options.removeWorktree?.force === true
        ? Effect.void
        : Effect.forEach(ownCheckouts(thread, machine), refuseDirty, {
            discard: true,
          }),
    release: (thread, options) =>
      Effect.gen(function* () {
        const removal = options.removeWorktree;
        if (removal === undefined) return;
        const used = yield* others(thread);
        for (const [index, target] of ownCheckouts(thread, machine).entries()) {
          if (target.kind !== "worktree") continue;
          if (!removal.force) yield* refuseDirty(target);
          yield* connection.worktrees
            .remove({
              repoPath: repoOf(target),
              worktreeDir: target.path,
              force: removal.force,
              openCheckouts: used,
              ...(index === 0 && options.permissionRules !== undefined
                ? { mergeRules: options.permissionRules }
                : {}),
            })
            .pipe(
              Effect.mapError((error) =>
                error.dirty
                  ? new WorktreeDirty({ path: target.path, changedFiles: 0 })
                  : new GitError({ message: error.message }),
              ),
            );
        }
      }),
    discard: (checkout) =>
      Effect.gen(function* () {
        if (checkout.kind !== "worktree") return;
        const open = heldCheckoutPaths(onMachine(yield* deps.threads, machine));
        yield* connection.worktrees
          .remove({
            repoPath: repoOf(checkout),
            worktreeDir: checkout.path,
            force: false,
            openCheckouts: open,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("couldn't take back a prepared worktree").pipe(
                Effect.annotateLogs({
                  machine: machine.id,
                  path: checkout.path,
                  error: error.message,
                }),
              ),
            ),
          );
      }),
    // An offline machine answers "there": its worktree isn't marked missing for being unreachable.
    present: (path) => connection.git.present(path),
    restore: (thread, fromPr) =>
      Effect.gen(function* () {
        const checkout = effectiveCheckout(thread);
        if (checkout.kind !== "worktree" || checkout.branch === undefined)
          return yield* new InvalidState({
            message: "Only a worktree with a recorded branch can be restored.",
          });
        return yield* connection.worktrees
          .restore({
            repoPath: repoOf(checkout),
            worktreeDir: checkout.path,
            branch: checkout.branch,
            fromPr,
            openCheckouts: yield* others(thread),
          })
          .pipe(
            Effect.mapError((error) =>
              error.reason === "conflict"
                ? new CheckoutInUse({ path: checkout.path, message: error.message })
                : error.reason === "invalidRequest"
                  ? new InvalidState({ message: error.message })
                  : new GitError({ message: error.message }),
            ),
          );
      }),
  };
};

/** A machine's worktrees as the server's own are reached: an activity lookup isn't sent. */
const machineWorktrees = (connection: HostConnection): Worktrees["Service"] => ({
  ...connection.worktrees,
  list: (repoPath, options) =>
    connection.worktrees.list(repoPath, { openCheckouts: options.openCheckouts }),
});

/**
 * A machine's checkouts' git state. Only the local tier is read there for now: the PR badge and
 * the rebase signal need the network tier, which runs where the checkout is.
 */
const machineGit = (connection: HostConnection): GitStateRuntime["Service"] => ({
  local: connection.git.local,
  present: connection.git.present,
  snapshot: (cwd, options) =>
    options.local === undefined ? connection.git.local(cwd) : Effect.succeed(options.local),
  // A watch ends with the machine's connection, as its watcher there does.
  watch: (paths, options) =>
    connection.git.watch(paths, options).pipe(Stream.catch(() => Stream.empty)),
});

/**
 * Another machine's worker host, over its connection: the workers placed there, their checkouts,
 * worktrees, git state, files, terminals and port scan. Unlike this machine's host process, nothing
 * falls back to running here: what is on that machine stays there, and while it is offline its
 * calls fail, its folders read as there, and its sessions don't start.
 *
 * Its shells don't count among this machine's process roots, since their process ids are that
 * machine's; their port chips come later.
 */
export interface MachineDeps {
  readonly store: ThreadStore["Service"];
  readonly hub: EventHub["Service"];
  readonly agents: AgentHosts["Service"];
  readonly proc: ProcShape;
  readonly gate?: TerminalGate["Service"] | undefined;
}

export const machineWorkerHost = (
  machine: Machine,
  connection: HostConnection,
  { store, hub, agents, proc, gate }: MachineDeps,
): Effect.Effect<WorkerHost, never, Scope.Scope> =>
  Effect.gen(function* () {
    const threads = store.listThreads.pipe(Effect.orElseSucceed((): ReadonlyArray<Thread> => []));
    const terminals = yield* terminalsThroughHost(
      connection.terminals,
      connection.gone,
      noTerminals(machine),
      {
        ...(gate === undefined ? {} : { held: gate.held }),
        // Only a thread placed on this machine has a folder here.
        threadFolder: (threadId: ThreadId) =>
          store.getThread(threadId).pipe(
            Effect.flatMap((thread) => {
              const checkout = effectiveCheckout(thread);
              return hostOf(checkout) === machine.id
                ? Effect.succeed(checkout.path)
                : Effect.fail(new ThreadNotFound({ threadId }));
            }),
          ),
        // Every shell on another machine opens in a worker's folder there.
        defaultFolder: Effect.succeed(undefined),
        settingsShell: Effect.succeed(undefined),
        path: Effect.succeed(""),
        hostSettings: true,
        closedThreads: hub
          .internalEvents(isThreadRemoved, `terminal cleanup on ${machine.id}`)
          .pipe(Stream.map((event) => event.threadId)),
      },
    );
    const wrapped = new WeakMap<object, ReturnType<typeof agentHostOnMachine>>();
    return {
      id: machine.id,
      sessions: AgentHosts.of({
        get: (kind) =>
          Effect.map(agents.get(kind), (agent) => {
            const known = wrapped.get(agent);
            if (known !== undefined) return known;
            const through = agentHostOnMachine(
              connection.sessions,
              connection.gone,
              agent,
              machine.name,
              machine.origin ?? (() => undefined),
            );
            wrapped.set(agent, through);
            return through;
          }),
      }),
      checkouts: machineCheckouts(machine, connection, { proc, threads }),
      worktrees: machineWorktrees(connection),
      git: machineGit(connection),
      files: connection.files,
      terminals,
      ports: { scan: connection.scan },
      process: connection.hello,
    };
  });

/**
 * The worker hosts of the machines joined to this Gram, each built once per connection: a machine
 * that dials in again gets a new one, and the old one's terminals and watches close, as they do
 * once its connection ends. A host is only good while its connection lasts, so callers look one up
 * for each piece of work rather than keep it. A machine
 * that isn't joined, confirmed and dialled in now is `HostUnavailable`.
 */
export const machineHosts = (
  remote: RemoteHostsShape,
  deps: MachineDeps,
): Effect.Effect<(id: HostId) => Effect.Effect<WorkerHost, HostUnavailable>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = yield* Effect.scope;
    const built = new Map<
      HostId,
      {
        readonly connection: HostConnection;
        readonly host: WorkerHost;
        readonly scope: Scope.Closeable;
      }
    >();
    const lock = yield* Semaphore.make(1);
    return (id) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const connection = yield* remote.connection(id);
          const kept = built.get(id);
          if (kept?.connection === connection) return kept.host;
          if (kept !== undefined) {
            built.delete(id);
            yield* Scope.close(kept.scope, Exit.void);
          }
          const scope = yield* Scope.fork(root);
          const machine = {
            id,
            name: remote.machines.get(id)?.name ?? id,
            origin: () => remote.origin(id),
          };
          const host = yield* machineWorkerHost(machine, connection, deps).pipe(
            Scope.provide(scope),
          );
          built.set(id, { connection, host, scope });
          // Once the machine's connection ends, its terminals and watches here end with it.
          yield* Effect.forkIn(
            Effect.gen(function* () {
              while (!connection.gone()) yield* Effect.sleep("2 seconds");
              if (built.get(id)?.connection === connection) built.delete(id);
              yield* Scope.close(scope, Exit.void);
            }),
            root,
          );
          return host;
        }),
      );
  });
