import {
  AgentUnavailable,
  type Checkout,
  effectiveCheckout,
  GitError,
  type HostId,
  hostOf,
  InvalidState,
  isLocalHost,
  LOCAL_HOST_ID,
  NotFound,
  type TerminalId,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import {
  type GitStateChange,
  type GitStateRuntime,
  ProcSpawnError,
  samePathKey,
  WorktreeError,
  type Worktrees,
} from "@gram/git";
import { dirname } from "node:path";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ThreadStore } from "../persistence/thread-store.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import type { CheckoutServiceShape } from "../runtime/hooks.ts";
import type { Terminals } from "../terminal/terminals.ts";
import type { HostFiles } from "./files.ts";
import { noteForeignCheckouts } from "./foreign-paths.ts";
import type { WorkerHost, WorkerHostsShape } from "./worker-host.ts";

/** How often an offline machine's watch looks for it again. */
const REDIAL_CHECK = "5 seconds";

const commandOffline = (message: string) => new ProcSpawnError({ bin: "gram-host", message });
const worktreeOffline = (message: string) =>
  new WorktreeError({ reason: "failed", message, dirty: false });
const invalid = (message: string) => new InvalidState({ message });
const gitOffline = (message: string) => new GitError({ message });
const terminalOffline = (terminalId: TerminalId) => () =>
  new NotFound({ entity: "terminal", id: terminalId });

/** Every checkout a thread holds, followed ones included. */
const checkoutsOf = (thread: Thread): ReadonlyArray<Checkout> => [
  thread.checkout,
  ...(thread.currentCheckout === undefined ? [] : [thread.currentCheckout]),
  ...(thread.extraCheckouts ?? []),
];

/**
 * Which machines each folder a thread holds is on, by `samePathKey`: its checkouts and their
 * repositories, this machine's among them. Two machines can hold the same path (the same user and
 * default folders on both), so a path can name more than one. Read from the threads as they are,
 * so a worker placed a moment ago is found.
 */
const machinePaths = (threads: ReadonlyArray<Thread>) => {
  const paths = new Map<string, Set<HostId>>();
  const claim = (path: string, host: HostId) => {
    const key = samePathKey(path);
    const hosts = paths.get(key) ?? new Set<HostId>();
    hosts.add(host);
    paths.set(key, hosts);
  };
  let remote = false;
  for (const thread of threads) {
    // Before the keys below, so they are taken as written rather than looked up on this disk.
    noteForeignCheckouts(thread);
    for (const checkout of checkoutsOf(thread)) {
      const host = hostOf(checkout);
      if (host !== LOCAL_HOST_ID) remote = true;
      claim(checkout.path, host);
      if (checkout.repoRoot !== undefined) claim(checkout.repoRoot, host);
    }
  }
  // With no other machine's folder, every path is this machine's.
  return remote ? paths : new Map<string, Set<HostId>>();
};

/** A path more than one machine holds, which a path alone can't place. */
export const ambiguousPath = (path: string) =>
  `${path} is a folder on more than one machine, so Gram can't tell which one is meant. Open it from its thread.`;

/**
 * One machine's checkouts' git state, worktrees and folders, as `placedHost` reaches them: a machine
 * that is offline answers as such (its reads fail, its folders count as there, its watches wait for
 * it to come back), and nothing of it runs here instead.
 */
export type MachineParts = Pick<WorkerHost, "git" | "worktrees" | "files"> & {
  /** Whether the checkout's folder is there: true unless that machine says it is gone. */
  readonly present: (path: string) => Effect.Effect<boolean>;
};

/**
 * The work of every thread, wherever it is placed, as one `WorkerHost`: each call goes to the
 * machine of the thread, checkout or folder it is about, and to this machine for anything that
 * isn't on another one. What isn't about a thread (the port scan, the agents' models) is this
 * machine's.
 *
 * A machine that is offline answers as such: its reads fail, its folders count as there, its
 * watches wait for it to come back, and nothing of it runs here instead.
 */
export const placedHost = (
  hosts: Pick<WorkerHostsShape, "local" | "get">,
  store: Pick<ThreadStore["Service"], "listThreads" | "getThread">,
  /** Whether any machine is joined: with none, every call is this machine's, looked up for free. */
  anyMachines: () => boolean = () => true,
): WorkerHost & {
  readonly machine: (id: HostId) => MachineParts;
  readonly placeOf: (path: string) => Effect.Effect<HostId | undefined>;
} => {
  const local = hosts.local;
  /** Set once a checkout is made on a machine here, which then stays routed after it is removed. */
  let placedNow = false;
  const routing = () => placedNow || anyMachines();
  const maps = new WeakMap<ReadonlyArray<Thread>, Map<string, Set<HostId>>>();
  const threads = store.listThreads;
  /**
   * The machine `path` is on: the one its own folder, or the nearest folder above it, is on.
   * `undefined` when more than one machine holds that folder: a path alone can't say which.
   */
  const hostIdOfPath = (path: string): Effect.Effect<HostId | undefined> =>
    routing()
      ? Effect.map(threads, (all) => {
          let paths = maps.get(all);
          if (paths === undefined) {
            paths = machinePaths(all);
            maps.set(all, paths);
          }
          if (paths.size === 0) return LOCAL_HOST_ID;
          for (let at = path; ; at = dirname(at)) {
            const found = paths.get(samePathKey(at));
            if (found !== undefined) return found.size === 1 ? [...found][0]! : undefined;
            if (dirname(at) === at) return LOCAL_HOST_ID;
          }
        })
      : Effect.succeed(LOCAL_HOST_ID);
  // Always read: one call per session open or terminal, and a thread reopened from a machine
  // since removed is still that machine's (and unavailable), never this one's.
  const hostIdOfThread = (threadId: ThreadId) =>
    store.getThread(threadId).pipe(
      Effect.map((thread) => hostOf(effectiveCheckout(thread))),
      // A thread that isn't stored (a dream, a helper) is this machine's.
      Effect.orElseSucceed(() => LOCAL_HOST_ID),
    );
  /** The host `id` names, or the reason it can't be reached as `onOffline` words it. */
  const hostFor = <E>(id: HostId, onOffline: (message: string) => E) =>
    id === LOCAL_HOST_ID
      ? Effect.succeed(local)
      : hosts.get(id).pipe(Effect.mapError((error) => onOffline(error.message)));
  /**
   * The machine parts where `placeOf` says each path is: `undefined` for a path more than one
   * machine holds, which is refused rather than guessed, and counts as there.
   */
  const partsWhere = (
    placeOf: (path: string) => Effect.Effect<HostId | undefined>,
  ): MachineParts => {
    const onPath = <A, E>(
      path: string,
      onOffline: (message: string) => E,
      run: (host: WorkerHost) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E> =>
      Effect.flatMap(placeOf(path), (id) =>
        id === undefined
          ? Effect.fail(onOffline(ambiguousPath(path)))
          : Effect.flatMap(hostFor(id, onOffline), run),
      );
    // An offline machine's folder is there as far as anyone here can tell, and so is one that a
    // path alone can't place.
    const presentOn = (cwd: string, here: (cwd: string) => Effect.Effect<boolean>) =>
      Effect.flatMap(placeOf(cwd), (id) =>
        id === undefined
          ? Effect.succeed(true)
          : id === LOCAL_HOST_ID
            ? here(cwd)
            : hosts.get(id).pipe(
                Effect.flatMap((host) => host.git.present(cwd)),
                Effect.orElseSucceed(() => true),
              ),
      );

    const git: GitStateRuntime["Service"] = {
      local: (cwd) => onPath(cwd, commandOffline, (host) => host.git.local(cwd)),
      present: (cwd) => presentOn(cwd, local.git.present),
      snapshot: (cwd, options) =>
        onPath(cwd, commandOffline, (host) => host.git.snapshot(cwd, options)),
      watch: (paths, options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const byHost = new Map<HostId, Array<string>>();
            for (const path of paths) {
              const id = yield* placeOf(path);
              if (id === undefined) {
                yield* Effect.logWarning("not watching a folder more than one machine holds").pipe(
                  Effect.annotateLogs({ path }),
                );
                continue;
              }
              byHost.set(id, [...(byHost.get(id) ?? []), path]);
            }
            /**
             * A machine's watch for as long as it is wanted: while the machine is offline, or once
             * its connection ends, it waits for the machine to dial in again and watches anew.
             */
            const onMachine = (
              id: HostId,
              list: ReadonlyArray<string>,
            ): Stream.Stream<GitStateChange> =>
              Stream.concat(
                Stream.unwrap(
                  hosts.get(id).pipe(
                    Effect.match({
                      onFailure: (): Stream.Stream<GitStateChange> =>
                        Stream.drain(Stream.fromEffect(Effect.sleep(REDIAL_CHECK))),
                      // Paced too, so a watch that ends at once can't spin.
                      onSuccess: (host) =>
                        Stream.concat(
                          host.git.watch(list, options),
                          Stream.drain(Stream.fromEffect(Effect.sleep(REDIAL_CHECK))),
                        ),
                    }),
                  ),
                ),
                Stream.suspend(() => onMachine(id, list)),
              );
            return Stream.mergeAll(
              [...byHost].map(([id, list]) =>
                id === LOCAL_HOST_ID ? local.git.watch(list, options) : onMachine(id, list),
              ),
              { concurrency: "unbounded" },
            );
          }),
        ),
    };

    const worktrees: Worktrees["Service"] = {
      list: (repoPath, options) =>
        onPath(repoPath, worktreeOffline, (host) => host.worktrees.list(repoPath, options)),
      baseBranches: (repoPath) =>
        onPath(repoPath, worktreeOffline, (host) => host.worktrees.baseBranches(repoPath)),
      create: (request) =>
        onPath(request.repoPath, worktreeOffline, (host) => host.worktrees.create(request)),
      remove: (request) =>
        onPath(request.repoPath, worktreeOffline, (host) => host.worktrees.remove(request)),
      restore: (request) =>
        onPath(request.repoPath, worktreeOffline, (host) => host.worktrees.restore(request)),
      pendingPermissions: (repoPath, worktreeDir) =>
        onPath(repoPath, worktreeOffline, (host) =>
          host.worktrees.pendingPermissions(repoPath, worktreeDir),
        ),
    };

    const files: HostFiles = {
      list: (path, options) => onPath(path, invalid, (host) => host.files.list(path, options)),
      search: (root, query, options) =>
        onPath(root, invalid, (host) => host.files.search(root, query, options)),
      names: (root) => onPath(root, invalid, (host) => host.files.names(root)),
    };

    return { git, worktrees, files, present: (path) => presentOn(path, local.checkouts.present) };
  };

  /** Each path where the threads say it is. */
  const placedParts = partsWhere(hostIdOfPath);
  const { git, worktrees, files } = placedParts;
  /** One machine's parts, whatever else holds the same paths: for a caller that knows the machine. */
  const partsOf = new Map<HostId, MachineParts>();
  const machine = (id: HostId): MachineParts => {
    let parts = partsOf.get(id);
    if (parts === undefined) {
      parts = partsWhere(() => Effect.succeed(id));
      partsOf.set(id, parts);
    }
    return parts;
  };

  const onThreadOf = <A, E>(
    thread: Thread,
    onOffline: (message: string) => E,
    run: (host: WorkerHost) => Effect.Effect<A, E>,
  ) => Effect.flatMap(hostFor(hostOf(effectiveCheckout(thread)), onOffline), run);
  const checkouts: CheckoutServiceShape = {
    // Placed where the request says; a request that names no machine is this machine's.
    prepare: (request, openCheckouts, projectRoot) =>
      Effect.flatMap(
        hostFor(
          request.kind === "newWorktree" ? (request.hostId ?? LOCAL_HOST_ID) : LOCAL_HOST_ID,
          invalid,
        ),
        (host) =>
          host.checkouts.prepare(request, openCheckouts, projectRoot).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (host.id !== LOCAL_HOST_ID) placedNow = true;
              }),
            ),
          ),
      ),
    // A close that removes nothing needs no machine: a thread on one that is offline, or was
    // removed, still closes. One that would remove its worktree there is refused while it's away.
    checkRelease: (thread, options) =>
      isLocalHost(thread.checkout)
        ? local.checkouts.checkRelease(thread, options)
        : options.removeWorktree === undefined
          ? Effect.void
          : Effect.flatMap(hostFor(hostOf(thread.checkout), gitOffline), (host) =>
              host.checkouts.checkRelease(thread, options),
            ),
    /**
     * After the session stopped, past the point of no return: a machine that went offline since
     * keeps the worktree, which is logged, rather than leave the thread half closed.
     */
    release: (thread, options) =>
      isLocalHost(thread.checkout)
        ? local.checkouts.release(thread, options)
        : options.removeWorktree === undefined
          ? Effect.void
          : hosts.get(hostOf(thread.checkout)).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.logWarning("kept a worktree on a machine that is offline").pipe(
                    Effect.annotateLogs({ path: thread.checkout.path, reason: error.message }),
                  ),
                onSuccess: (host) => host.checkouts.release(thread, options),
              }),
            ),
    discard: (checkout) =>
      hostFor(hostOf(checkout), (message) => message).pipe(
        Effect.flatMap((host) => host.checkouts.discard(checkout)),
        Effect.catch((message) =>
          Effect.logWarning("couldn't take back a prepared worktree").pipe(
            Effect.annotateLogs({ path: checkout.path, reason: message }),
          ),
        ),
      ),
    present: placedParts.present,
    restore: (thread, fromPr) =>
      onThreadOf(thread, invalid, (host) => host.checkouts.restore(thread, fromPr)),
  };

  /** Which machine each terminal opened through here is on. */
  const terminalHosts = new Map<TerminalId, HostId>();
  /**
   * The machine `terminalId` is on. One this Gram didn't open (a joined machine kept it through a
   * restart of this Gram) is looked for among the machines threads are placed on, by what each
   * one's host lists, so its input and close reach it there rather than this machine.
   */
  const terminalHostOf = (terminalId: TerminalId): Effect.Effect<HostId> =>
    Effect.suspend(() => {
      const known = terminalHosts.get(terminalId);
      if (known !== undefined || !routing()) return Effect.succeed(known ?? LOCAL_HOST_ID);
      const listed = (host: WorkerHost) =>
        host.terminals
          .list()
          .pipe(Effect.map((all) => all.some((terminal) => terminal.terminalId === terminalId)));
      return Effect.gen(function* () {
        if (yield* listed(local)) {
          terminalHosts.set(terminalId, LOCAL_HOST_ID);
          return LOCAL_HOST_ID;
        }
        const all = yield* threads.pipe(Effect.orElseSucceed((): ReadonlyArray<Thread> => []));
        const machines = new Set(all.map((thread) => hostOf(effectiveCheckout(thread))));
        machines.delete(LOCAL_HOST_ID);
        for (const id of machines) {
          const host = yield* hosts.get(id).pipe(Effect.option);
          if (host._tag === "Some" && (yield* listed(host.value))) {
            terminalHosts.set(terminalId, id);
            return id;
          }
        }
        return LOCAL_HOST_ID;
      });
    });
  const onTerminal = <A, E>(
    terminalId: TerminalId,
    run: (terminals: Terminals) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | NotFound> =>
    Effect.flatMap(terminalHostOf(terminalId), (id) =>
      id === LOCAL_HOST_ID
        ? run(local.terminals)
        : Effect.flatMap(hostFor(id, terminalOffline(terminalId)), (host) => run(host.terminals)),
    );
  const terminalsOfThread = (threadId: ThreadId | undefined) =>
    threadId === undefined
      ? Effect.succeed(local)
      : Effect.flatMap(hostIdOfThread(threadId), (id) => hostFor(id, invalid));
  const terminals: Terminals = {
    open: (request, settings) =>
      Effect.gen(function* () {
        const host =
          request.threadId === undefined && request.hostId !== undefined
            ? yield* hostFor(request.hostId, invalid)
            : yield* terminalsOfThread(request.threadId);
        const opened = yield* host.terminals.open(request, settings);
        terminalHosts.set(opened.terminalId, host.id);
        return opened;
      }),
    input: (terminalId, data) => onTerminal(terminalId, (t) => t.input(terminalId, data)),
    resize: (terminalId, cols, rows) =>
      onTerminal(terminalId, (t) => t.resize(terminalId, cols, rows)),
    close: (terminalId) =>
      onTerminal(terminalId, (t) => t.close(terminalId)).pipe(
        Effect.ensuring(Effect.sync(() => terminalHosts.delete(terminalId))),
      ),
    list: (threadId) =>
      terminalsOfThread(threadId).pipe(
        Effect.flatMap((host) => host.terminals.list(threadId)),
        Effect.orElseSucceed(() => []),
      ),
    subscribe: (terminalId) =>
      Stream.unwrap(
        terminalHostOf(terminalId).pipe(
          Effect.flatMap((id) =>
            id === LOCAL_HOST_ID
              ? Effect.succeed(local.terminals.subscribe(terminalId))
              : hostFor(id, terminalOffline(terminalId)).pipe(
                  Effect.map((host) => host.terminals.subscribe(terminalId)),
                ),
          ),
        ),
      ),
    snapshot: (threadId) =>
      terminalsOfThread(threadId).pipe(
        Effect.flatMap((host) => host.terminals.snapshot(threadId)),
        Effect.orElseSucceed(() => []),
      ),
  };

  /** One wrapper per agent, so the runtime always holds the same object for it. */
  const wrapped = new WeakMap<object, unknown>();
  const sessions = AgentHosts.of({
    get: (kind) =>
      Effect.map(local.sessions.get(kind), (agent) => {
        const known = wrapped.get(agent) as typeof agent | undefined;
        if (known !== undefined) return known;
        const through: typeof agent = {
          ...agent,
          open: (options) =>
            Effect.flatMap(hostIdOfThread(options.threadId), (id) =>
              id === LOCAL_HOST_ID
                ? agent.open(options)
                : hosts.get(id).pipe(
                    Effect.mapError(
                      (error) =>
                        new AgentUnavailable({
                          agent: kind,
                          reason: "startup-failed",
                          message: error.message,
                        }),
                    ),
                    Effect.flatMap((host) => host.sessions.get(kind)),
                    Effect.flatMap((onMachine) => onMachine.open(options)),
                  ),
            ),
        };
        wrapped.set(agent, through);
        return through;
      }),
  });

  return {
    id: LOCAL_HOST_ID,
    sessions,
    checkouts,
    worktrees,
    git,
    files,
    terminals,
    ports: local.ports,
    process: local.process,
    machine,
    placeOf: hostIdOfPath,
  };
};
