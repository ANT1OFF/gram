import {
  CheckoutInUse,
  type Checkout,
  effectiveCheckout,
  GitError,
  type GitState,
  hostOf,
  type HostAppToolsAnswer,
  type HostAppToolsRequest,
  type HostId,
  type HostUnavailable,
  InvalidState,
  NotFound,
  type TerminalId,
  type Project,
  type Thread,
  type HostSessionOpen,
  type ThreadId,
  ThreadNotFound,
  WorktreeDirty,
} from "@gram/contracts";
import {
  git,
  type GitStateRuntime,
  isInside,
  Proc,
  type ProcShape,
  type Worktrees,
} from "@gram/git";
import { posix, win32 } from "node:path";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
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
import { foregroundOf } from "../ports/pure.ts";
import {
  followingSessions,
  REATTACH_WITHIN_MS,
  STOPPED_REATTACH_MS,
} from "./following-sessions.ts";
import type { AttachmentsOnMachine } from "./carry-attachments.ts";
import type { HostConnection } from "./protocol.ts";
import { noAppToolsTunnel } from "./app-tools-tunnel.ts";
import type { RemoteHostsShape } from "./remote-hosts.ts";
import { redactUrlCredentials } from "./remote-url.ts";
import { olderHost } from "./folders.ts";
import { recordedCloneIdentity } from "../git/recorded-clone.ts";
import { cloneFolderOf, cloneIdentityOf } from "./repos.ts";
import type { WorkerHost } from "./worker-host.ts";
import { HOST_THREADS_DIR, type HostThreadPlaces } from "./thread-places.ts";

/**
 * The fewest folders a clone or worktree a host made sits below its root by: never the root, nor
 * a folder as broad as a home folder, which would claim all of that machine's paths for it.
 */
const CLONE_DEPTH = 3;

/**
 * Whether a folder a host answers with is one Gram records as a thread's: absolute, written
 * plainly (no `.` or `..`), and at least `depth` folders below the root. A host's answer is that
 * machine's word, and a checkout's path decides where the server routes its calls.
 */
export const plausibleFolder = (path: string, depth: number): boolean => {
  if (posix.isAbsolute(path)) {
    const parts = path.split("/").filter((part) => part !== "");
    return parts.length >= depth && !parts.some((part) => part === "." || part === "..");
  }
  if (win32.isAbsolute(path) && /^[A-Za-z]:[\\/]/.test(path)) {
    const parts = path
      .slice(3)
      .split(/[\\/]/)
      .filter((part) => part !== "");
    return parts.length >= depth && !parts.some((part) => part === "." || part === "..");
  }
  return false;
};

/**
 * Whether a host's answer for `threadId`'s own folder is one: plausible, and its clones'
 * `.threads/<thread id>`, never another thread's folder nor one of the machine's broad folders.
 */
export const ownThreadFolder = (path: string, threadId: string): boolean => {
  if (!plausibleFolder(path, CLONE_DEPTH + 1)) return false;
  const parts = path.split(posix.isAbsolute(path) ? "/" : /[\\/]/).filter((part) => part !== "");
  return parts.at(-1) === threadId && parts.at(-2) === HOST_THREADS_DIR;
};

/** The machine's thread places, a folder it made that isn't the thread's own taken back and refused. */
const checkedPlaces = (machine: Machine, places: HostThreadPlaces): HostThreadPlaces => ({
  ...places,
  make: (threadId, files) =>
    places
      .make(threadId, files)
      .pipe(
        Effect.flatMap((made) =>
          ownThreadFolder(made.path, threadId)
            ? Effect.succeed(made)
            : places
                .remove(threadId)
                .pipe(
                  Effect.andThen(
                    Effect.fail(new InvalidState({ message: implausible(machine, made.path) })),
                  ),
                ),
        ),
      ),
});

/** What a placement is told when the machine answered with a folder Gram doesn't record. */
const implausible = (machine: Machine, path: string) =>
  `${machine.name} answered with ${path} for the thread's folder, which isn't one Gram uses, so the thread isn't placed there.`;

/** A joined machine as its worker host is named and reached. */
export interface Machine {
  readonly id: HostId;
  readonly name: string;
  /** The tailnet address it dialled, where its sessions reach their app tools; absent offline. */
  readonly origin?: () => string | undefined;
  /** Why its sessions can't reach their app tools while `origin` is absent, when it isn't offline. */
  readonly unreachable?: () => string | undefined;
  /** Asks the machine for its Claude Code sign-in again, after a start failed for it. */
  readonly recheckSignIn?: () => void;
  /**
   * Its connection now, failing while it is offline. Given, its sessions follow it across a
   * redial (`followingSessions`); without it, they end with the connection they opened on.
   */
  readonly connection?: Effect.Effect<HostConnection, HostUnavailable>;
  /** How long its sessions wait for it to dial in again, read at each wait. */
  readonly reattachMs?: () => number;
  /** Why a thread's session mustn't open there now, asked as it goes (`followingSessions`). */
  readonly admit?: (threadId: ThreadId) => string | undefined;
}

const offline = (machine: Machine) => `${machine.name} is offline.`;

/**
 * Whether a terminal of a thread runs a command on the machine, by the machine's own scan and its
 * shells' process ids there (`shells`, by terminal); undefined when that can't be told, so a close
 * at rest leaves the thread open. Never this machine's processes: the ids are the other machine's.
 */
const terminalBusyOn =
  (connection: HostConnection, shells: ReadonlyMap<TerminalId, number>) => (threadId: ThreadId) =>
    Effect.gen(function* () {
      const open = (yield* connection.terminals.list(threadId)).filter((t) => t.alive);
      // An empty list from a machine that went meanwhile says nothing about its shells.
      if (connection.gone()) return undefined;
      if (open.length === 0) return false;
      const swept = yield* connection.scan.pipe(Effect.orElseSucceed(() => undefined));
      if (swept?.processes === undefined) return undefined;
      for (const { terminalId } of open) {
        const pid = shells.get(terminalId);
        // A shell whose id hasn't come in yet can't be ruled out.
        if (pid === undefined) return undefined;
        if (foregroundOf(swept.processes, swept.children, pid) !== undefined) return true;
      }
      return false;
    });

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
  deps: {
    readonly proc: ProcShape;
    readonly threads: Effect.Effect<ReadonlyArray<Thread>>;
    readonly projects: Effect.Effect<ReadonlyArray<Project>>;
  },
): CheckoutServiceShape => {
  const others = (thread: Thread | undefined) =>
    Effect.map(deps.threads, (threads) =>
      usedCheckoutPaths(onMachine(threads, machine).filter((t) => t.id !== thread?.id)),
    );

  /**
   * The project's remote, read here as stored, not as `insteadOf` rewrites it: the host clones the
   * same repository.
   */
  const originOf = (projectRoot: string) =>
    git(projectRoot, ["config", "--get", "remote.origin.url"]).pipe(
      Effect.provideService(Proc, deps.proc),
      Effect.mapError((error) => new GitError({ message: redactUrlCredentials(error.message) })),
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
        // A folder the user picked there for this thread alone, checked by the machine itself:
        // the host refuses a credential folder or its own, and resolves links where they are.
        if (request.kind === "machineFolder") {
          const folders = connection.folders;
          if (folders === undefined)
            return yield* new InvalidState({ message: olderHost(machine) });
          const found = yield* folders.check(request.path);
          if (!plausibleFolder(found.path, 1))
            return yield* new InvalidState({ message: implausible(machine, found.path) });
          const checkout: Checkout = {
            kind: "main",
            path: found.path,
            hostId: machine.id,
            ...(found.branch === undefined ? {} : { branch: found.branch }),
          };
          return checkout;
        }
        if (request.kind === "existingWorktree")
          return yield* new InvalidState({
            message: `A worker on ${machine.name} works in a new worktree there.`,
          });
        const url = yield* originOf(projectRoot);
        // The clone it is handed is of the origin its project recorded when it was added, never
        // one rewritten since.
        yield* recordedCloneIdentity(yield* deps.projects, projectRoot, cloneIdentityOf(url));
        const { path: repoPath } = yield* connection.repos
          .ensure(url)
          .pipe(
            Effect.mapError((error) =>
              error.reason === "failed"
                ? new GitError({ message: redactUrlCredentials(error.message) })
                : new InvalidState({ message: error.message }),
            ),
          );
        if (!plausibleFolder(repoPath, CLONE_DEPTH))
          return yield* new InvalidState({ message: implausible(machine, repoPath) });
        // The machine's own clone as it is, for a thread that makes no branch of its own (an
        // orchestrator of a headless Gram): where the worktrees of its workers there come from.
        // Its branch is read there; every other value is this machine's own.
        if (request.kind === "current") {
          const state = yield* connection.git.local(repoPath).pipe(
            Effect.mapError(
              () =>
                new GitError({
                  message: `Couldn't read ${repoPath} on ${machine.name} after cloning it.`,
                }),
            ),
          );
          const cloneIdentity = cloneIdentityOf(url);
          const main: Checkout = {
            kind: "main",
            path: repoPath,
            hostId: machine.id,
            ...(state.branch === undefined ? {} : { branch: state.branch }),
            ...(cloneIdentity === undefined ? {} : { cloneIdentity }),
          };
          return main;
        }
        const created = yield* connection.worktrees
          .create({
            repoPath,
            branch: request.branch,
            ...(request.base === undefined ? {} : { base: request.base }),
            ...(request.untrusted === true ? { untrusted: true } : {}),
            openCheckouts,
          })
          .pipe(
            Effect.mapError((error) =>
              error.reason === "conflict"
                ? new CheckoutInUse({ path: repoPath, message: error.message })
                : error.reason === "invalidRequest"
                  ? new InvalidState({ message: error.message })
                  : new GitError({ message: redactUrlCredentials(error.message) }),
            ),
          );
        // The record a check of the worker's ownership later goes by, made of this machine's own
        // values: the branch it asked for (as the host's worktree code trims it), the clone it was
        // handed for its origin, that origin's identity and the machine. Of the host's reply only
        // where it put the worktree, and the base it chose, are taken; a reply naming another
        // branch is refused rather than recorded.
        const branch = request.branch.trim();
        if (
          !plausibleFolder(created.checkout.path, CLONE_DEPTH) ||
          isInside(created.checkout.path, repoPath)
        )
          return yield* new InvalidState({ message: implausible(machine, created.checkout.path) });
        if (created.checkout.branch !== branch)
          return yield* new InvalidState({
            message: `${machine.name} made the worktree on another branch than the ${branch} Gram asked for, so it isn't used.`,
          });
        const cloneIdentity = cloneIdentityOf(url);
        const checkout: Checkout = {
          kind: created.checkout.kind,
          path: created.checkout.path,
          hostId: machine.id,
          branch,
          ...(created.checkout.base === undefined ? {} : { base: created.checkout.base }),
          repoRoot: repoPath,
          ...(cloneIdentity === undefined ? {} : { cloneIdentity }),
        };
        return checkout;
      }),
    checkRelease: (thread, options) =>
      options.removeWorktree === undefined || options.removeWorktree?.force === true
        ? Effect.void
        : Effect.forEach(ownCheckouts(thread, machine), refuseDirty, {
            discard: true,
          }),
    release: (thread, options) =>
      Effect.gen(function* () {
        // What a stop kept of the thread at its remote stays: a closed thread can be reopened
        // (`thread-lifecycle.ts` keeps it as it was), and its work in progress with it.
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
                  : new GitError({ message: redactUrlCredentials(error.message) }),
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
            ...(checkout.untrusted === true ? { untrusted: true } : {}),
            openCheckouts: yield* others(thread),
          })
          .pipe(
            Effect.mapError((error) =>
              error.reason === "conflict"
                ? new CheckoutInUse({ path: checkout.path, message: error.message })
                : error.reason === "invalidRequest"
                  ? new InvalidState({ message: error.message })
                  : new GitError({ message: redactUrlCredentials(error.message) }),
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
 * A joined machine's git state as this machine takes it: its local git facts only. What GitHub or
 * this machine says (the origin's repository, PR badges, another worktree's PR, a missing folder)
 * is never the host's to say, so whatever a host sends of it is dropped here, at the boundary:
 * a host can't point a thread's PR lookup at another repository or PR.
 */
export const localTierOf = (state: GitState): GitState => {
  const {
    origin: _origin,
    pr: _pr,
    extraPrs: _extraPrs,
    prElsewhere: _prElsewhere,
    missingPrs: _missingPrs,
    workElsewhere: _workElsewhere,
    missing: _missing,
    ...local
  } = state;
  return local;
};

/**
 * A machine's checkouts' git state. Only the local tier is read there for now: the PR badge and
 * the rebase signal need the network tier, which runs where the checkout is.
 */
const machineGit = (connection: HostConnection): GitStateRuntime["Service"] => ({
  local: (cwd) => Effect.map(connection.git.local(cwd), localTierOf),
  present: connection.git.present,
  snapshot: (cwd, options) =>
    options.local === undefined
      ? Effect.map(connection.git.local(cwd), localTierOf)
      : Effect.succeed(localTierOf(options.local)),
  // A watch ends with the machine's connection, as its watcher there does.
  watch: (paths, options) =>
    connection.git.watch(paths, options).pipe(
      Stream.map((change) => ({ ...change, state: localTierOf(change.state) })),
      Stream.catch(() => Stream.empty),
    ),
});

/**
 * Another machine's worker host, over its connection: the workers placed there, their checkouts,
 * worktrees, git state, files, terminals and port scan. Unlike this machine's host process, nothing
 * falls back to running here: what is on that machine stays there, and while it is offline its
 * calls fail, its folders read as there, and its sessions don't start.
 *
 * Its shells don't count among this machine's process roots, since their process ids are that
 * machine's; their port chips come later. Whether one runs a command is read from that machine's
 * own scan (`terminalBusyOn`).
 */
export interface MachineDeps {
  readonly store: ThreadStore["Service"];
  readonly hub: EventHub["Service"];
  readonly agents: AgentHosts["Service"];
  readonly proc: ProcShape;
  readonly gate?: TerminalGate["Service"] | undefined;
  /**
   * The one folder a send's attachments are carried to the machine from (`carryAttachments`):
   * set on a server with no local user, where any other path is the server's own file.
   */
  readonly carriedFrom?: string | undefined;
  /**
   * Answers a session's app-tool call carried over a machine's own connection
   * (`app-tools-tunnel`), for a machine that reaches no address of this Gram's: one a hosted
   * server relays (`PairedMachine.via`). Absent: such a machine's sessions get no app tools.
   */
  readonly appTools?: (
    machine: HostId,
    request: HostAppToolsRequest,
  ) => Effect.Effect<Omit<HostAppToolsAnswer, "id">>;
}

export const machineWorkerHost = (
  machine: Machine,
  connection: HostConnection,
  { store, hub, agents, proc, gate, carriedFrom }: MachineDeps,
): Effect.Effect<WorkerHost, never, Scope.Scope> =>
  Effect.gen(function* () {
    const threads = store.listThreads.pipe(Effect.orElseSucceed((): ReadonlyArray<Thread> => []));
    const projects = store.listProjects.pipe(
      Effect.orElseSucceed((): ReadonlyArray<Project> => []),
    );
    /** The machine's shells by terminal, with their process ids there. */
    const shells = new Map<TerminalId, number>();
    const terminals = yield* terminalsThroughHost(
      connection.terminals,
      connection.gone,
      noTerminals(machine),
      {
        ...(gate === undefined ? {} : { held: gate.held }),
        // Kept apart from this machine's `ProcessRoots`: these ids mean nothing here.
        roots: {
          add: (_threadId, pid, terminalId) => void shells.set(terminalId, pid),
          remove: (pid) => {
            for (const [terminalId, known] of shells) if (known === pid) shells.delete(terminalId);
          },
        },
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
    // A removed thread's attachments there go with it; a thread on no machine finds nothing.
    const attachments = connection.attachments;
    if (attachments !== undefined) {
      yield* hub.internalEvents(isThreadRemoved, `attachment cleanup on ${machine.id}`).pipe(
        Stream.runForEach((event) => attachments.remove(event.threadId)),
        Effect.forkScoped,
      );
    }
    const wrapped = new WeakMap<object, ReturnType<typeof agentHostOnMachine>>();
    // A session outlives the dial it opened on: a dropped connection that comes back picks it up.
    const sessions =
      machine.connection === undefined
        ? connection.sessions
        : followingSessions(machine.connection, {
            ...(machine.reattachMs === undefined ? {} : { reattachMs: machine.reattachMs }),
            ...(machine.admit === undefined
              ? {}
              : { admit: (request: HostSessionOpen) => machine.admit?.(request.threadId) }),
          });
    return {
      id: machine.id,
      sessions: AgentHosts.of({
        get: (kind) =>
          Effect.map(agents.get(kind), (agent) => {
            const known = wrapped.get(agent);
            if (known !== undefined) return known;
            const through = agentHostOnMachine(
              sessions,
              connection.gone,
              agent,
              machine.name,
              machine.origin ?? (() => undefined),
              machine.recheckSignIn,
              currentAttachments(machine, connection),
              carriedFrom,
              machine.unreachable,
            );
            wrapped.set(agent, through);
            return through;
          }),
      }),
      checkouts: machineCheckouts(machine, connection, { proc, threads, projects }),
      worktrees: machineWorktrees(connection),
      git: machineGit(connection),
      files: connection.files,
      folders: connection.folders,
      terminals,
      ports: { scan: connection.scan, terminalBusy: terminalBusyOn(connection, shells) },
      process: connection.hello,
      name: machine.name,
      reads: connection.reads,
      attachments: connection.attachments,
      threadPlaces:
        connection.threadPlaces === undefined
          ? undefined
          : checkedPlaces(machine, connection.threadPlaces),
      identify: connection.repos.identify,
      shared: connection.shared,
      loopback: connection.loopback,
    };
  });

/**
 * The machine's attachments store on its connection at the time of each call, since a session
 * outlives the dial it opened on; why not while it is offline or on a build without one.
 */
const currentAttachments =
  (machine: Machine, opened: HostConnection): AttachmentsOnMachine =>
  () =>
    (machine.connection ?? Effect.succeed(opened)).pipe(
      Effect.mapError(() => `${machine.name} is offline`),
      Effect.flatMap((connection) =>
        connection.attachments === undefined
          ? Effect.fail(
              `gram-host on ${machine.name} is older than this Gram; update it (Settings → Machines, or rerun its install command there)`,
            )
          : Effect.succeed(connection.attachments),
      ),
    );

/**
 * Opens a relayed machine's app-tool tunnel and answers each call on it for as long as `scope`
 * lasts (its connection): the address its sessions reach their app tools at. Undefined when its
 * host carries none or this Gram answers none, so its sessions open without app tools rather
 * than at an address that would take their tokens elsewhere.
 */
/** The one address a host's tunnel may be at: its own loopback, by port. */
const TUNNEL_ADDRESS = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;

export const appToolsTunnel = (
  id: HostId,
  connection: HostConnection,
  deps: Pick<MachineDeps, "appTools">,
) =>
  Effect.gen(function* () {
    const tunnel = connection.appTools;
    const answer = deps.appTools;
    if (tunnel === undefined || answer === undefined) return undefined;
    // A host that never answers is given no tunnel, rather than holding up the others.
    const opened = yield* tunnel.open.pipe(Effect.timeout("10 seconds"), Effect.option);
    // Only the host's own loopback: a session's token goes nowhere else a host might name.
    if (opened._tag === "None" || !TUNNEL_ADDRESS.test(opened.value.url)) return undefined;
    // Each call answered on a fiber of its own, by its id: a session that hangs up on one there
    // stops it here (`cancel`), as one that hangs up on this Gram's own endpoint does.
    const calls = yield* FiberMap.make<string>();
    yield* tunnel.requests.pipe(
      Stream.runForEach((request) =>
        request.cancel === true
          ? FiberMap.remove(calls, request.id)
          : FiberMap.run(
              calls,
              request.id,
              answer(id, request).pipe(
                Effect.flatMap((answered) => tunnel.answer({ id: request.id, ...answered })),
                Effect.ignore,
              ),
            ).pipe(Effect.asVoid),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    return opened.value.url;
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
    /**
     * Each relayed machine's app-tool tunnel, one per connection, answered for as long as that
     * connection lasts: started when the machine comes online (a redial too), not when a worker
     * host is first built here, since a session that reattaches to the new connection builds none.
     */
    const tunnels = new WeakMap<HostConnection, Deferred.Deferred<string | undefined>>();
    const tunnelOf = (id: HostId, connection: HostConnection) =>
      Effect.suspend(() => {
        const kept = tunnels.get(connection);
        if (kept !== undefined) return Deferred.await(kept);
        const made = Deferred.makeUnsafe<string | undefined>();
        tunnels.set(connection, made);
        return Effect.gen(function* () {
          const scope = yield* Scope.fork(root);
          const url = yield* appToolsTunnel(id, connection, deps).pipe(
            Scope.provide(scope),
            Effect.catchCause(() => Effect.succeed(undefined)),
            // Stopped before it finished: no one waits on it, and the next lookup opens it again.
            Effect.onInterrupt(() =>
              Effect.andThen(
                Effect.sync(() => {
                  if (tunnels.get(connection) === made) tunnels.delete(connection);
                  Deferred.doneUnsafe(made, Exit.succeed(undefined));
                }),
                Scope.close(scope, Exit.void),
              ),
            ),
          );
          Deferred.doneUnsafe(made, Exit.succeed(url));
          // Its answers end with the connection: the next one opens the tunnel again.
          yield* Effect.forkIn(
            Effect.gen(function* () {
              while (!connection.gone()) yield* Effect.sleep("2 seconds");
              yield* Scope.close(scope, Exit.void);
            }),
            root,
          );
          return url;
        });
      });
    // Each at once: one host slow to answer holds up no other's tunnel. Read afresh each time.
    const relayedOnline = Effect.suspend(() =>
      Effect.forEach(
        remote
          .list()
          .filter((machine) => machine.via !== undefined && machine.onlineSince !== undefined),
        (machine) =>
          remote.connection(machine.id).pipe(
            Effect.option,
            Effect.flatMap((connection) =>
              connection._tag === "Some" ? tunnelOf(machine.id, connection.value) : Effect.void,
            ),
          ),
        { concurrency: "unbounded", discard: true },
      ),
    );
    // Only where this Gram answers app-tool calls at all: without, no machine has a tunnel.
    if (deps.appTools !== undefined) {
      const changes = yield* Queue.sliding<void>(1);
      const unwatch = remote.watch(() => Queue.offerUnsafe(changes, undefined));
      yield* Effect.addFinalizer(() => Effect.sync(unwatch));
      yield* Queue.take(changes).pipe(
        Effect.andThen(relayedOnline),
        Effect.catchCause(() => Effect.void),
        Effect.forever,
        Effect.forkScoped,
      );
      Queue.offerUnsafe(changes, undefined);
    }
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
          // A machine a hosted server relays reaches no address of this Gram's: its sessions'
          // app tools go over its own connection, at an address on its loopback.
          // Never the relaying server's own address: a thread's token would go there.
          const relayed = remote.machines.get(id)?.via !== undefined;
          const tunnel = relayed ? yield* tunnelOf(id, connection) : undefined;
          const machine = {
            id,
            name: remote.machines.get(id)?.name ?? id,
            origin: () => (relayed ? tunnel : remote.origin(id)),
            // A relayed machine whose gram-host carries no app tools is refused in words, not
            // waited on as if it were offline.
            unreachable: () =>
              relayed && tunnel === undefined && !connection.gone()
                ? noAppToolsTunnel(remote.machines.get(id)?.name ?? id)
                : undefined,
            recheckSignIn: () => void remote.checkSignIn(id),
            connection: remote.connection(id),
            // A machine readied to stop is waited for longer: it comes back as a new host.
            reattachMs: () =>
              remote.stops.recently(id) ? STOPPED_REATTACH_MS : REATTACH_WITHIN_MS,
            // Asked again as the open goes out: the machine may have come back on another disk
            // since its session was let through, and owe a resume first.
            admit: (threadId: ThreadId) =>
              remote.stops.blocked(id, threadId) ??
              (remote.stops.resuming(id) && !remote.stops.isThreadBack(id, threadId)
                ? "That machine's threads are being put back."
                : undefined),
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
