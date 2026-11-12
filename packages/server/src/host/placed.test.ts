import { describe, expect, it } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import {
  type Checkout,
  type GitState,
  HostId,
  HostUnavailable,
  LOCAL_HOST_ID,
  type TerminalId,
  type Thread,
  ThreadId,
  ThreadNotFound,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { ActingPerson } from "../embedding/person.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { openSignInTerminal } from "./claude-sign-in.ts";
import type { HeadlessPlacement } from "./headless.ts";
import { NOT_YOUR_MACHINE, ownedMachines, RoutedFor } from "./ownership.ts";
import { placedHost } from "./placed.ts";
import type { WorkerHost } from "./worker-host.ts";

const MACHINE = HostId.make("m-0123456789abcdef01234567");
const REMOTE_PATH = "/srv/gram-host/repos/git.example.test/acme/widgets.worktrees/feature";
const LOCAL_PATH = "/Users/me/widgets";

/** A host that records each call it answers, by its name. */
const recordingHost = (
  id: HostId,
  calls: Array<string>,
  /** Terminals its host lists, open before this Gram started. */
  kept: ReadonlyArray<TerminalId> = [],
): WorkerHost => {
  const say =
    (name: string) =>
    (..._args: ReadonlyArray<unknown>) =>
      Effect.sync(() => {
        calls.push(`${id}:${name}`);
        return { id } as never;
      });
  const agent = {
    kind: "claude",
    open: (options: { readonly threadId: string }) =>
      Effect.sync(() => {
        calls.push(`${id}:open:${options.threadId}`);
        return {} as never;
      }),
  } as unknown as AgentHost;
  return {
    id,
    sessions: AgentHosts.of({ get: () => Effect.succeed(agent) }),
    checkouts: {
      prepare: say("prepare"),
      checkRelease: say("checkRelease"),
      release: say("release"),
      discard: say("discard"),
      present: () =>
        Effect.sync(() => {
          calls.push(`${id}:present`);
          return false;
        }),
      restore: say("restore"),
    },
    worktrees: {
      list: say("worktrees.list"),
      baseBranches: say("baseBranches"),
      create: say("create"),
      remove: say("remove"),
      restore: say("worktrees.restore"),
      pendingPermissions: say("pendingPermissions"),
    },
    git: {
      local: (cwd: string) =>
        Effect.sync(() => {
          calls.push(`${id}:git.local:${cwd}`);
          return { repo: true } as unknown as GitState;
        }),
      present: () =>
        Effect.sync(() => {
          calls.push(`${id}:git.present`);
          return false;
        }),
      snapshot: say("snapshot"),
      watch: () => {
        throw new Error("not in this test");
      },
    },
    files: { list: say("files.list"), search: say("files.search"), names: say("files.names") },
    terminals: {
      open: (request: { readonly threadId?: string }) =>
        Effect.sync(() => {
          calls.push(`${id}:terminal.open:${request.threadId}`);
          return { terminalId: `${id}-t1` as TerminalId } as never;
        }),
      input: (terminalId: TerminalId) =>
        Effect.sync(() => {
          calls.push(`${id}:terminal.input:${terminalId}`);
        }),
      resize: say("resize"),
      close: (terminalId: TerminalId) =>
        Effect.sync(() => {
          calls.push(`${id}:terminal.close:${terminalId}`);
        }),
      list: () => Effect.succeed(kept.map((terminalId) => ({ terminalId }))),
      subscribe: () => {
        throw new Error("not in this test");
      },
      snapshot: () => Effect.succeed([]),
    },
    ports: { scan: Effect.die(new Error("not in this test")) },
  } as unknown as WorkerHost;
};

const thread = (id: string, checkout: Checkout) =>
  ({ id: ThreadId.make(id), checkout }) as unknown as Thread;

const THREADS = [
  thread("t-remote", {
    kind: "worktree",
    path: REMOTE_PATH,
    branch: "feature",
    repoRoot: "/srv/gram-host/repos/git.example.test/acme/widgets",
    hostId: MACHINE,
  }),
  thread("t-local", { kind: "main", path: LOCAL_PATH }),
];

const KEPT = "kept-on-the-machine" as TerminalId;

const setup = (online: { value: boolean }, headless?: HeadlessPlacement) => {
  const calls: Array<string> = [];
  const local = recordingHost(LOCAL_HOST_ID, calls);
  const machine = recordingHost(MACHINE, calls, [KEPT]);
  const placed = placedHost(
    {
      local,
      get: (id) =>
        id === MACHINE && online.value
          ? Effect.succeed(machine)
          : Effect.fail(new HostUnavailable({ hostId: id, message: "That machine is offline." })),
    },
    {
      listThreads: Effect.succeed(THREADS),
      getThread: (id) => {
        const found = THREADS.find((t) => t.id === id);
        return found === undefined
          ? Effect.fail(new ThreadNotFound({ threadId: id }))
          : Effect.succeed(found);
      },
    },
    undefined,
    headless,
  );
  return { calls, placed };
};

describe("placedHost", () => {
  it.effect("sends each folder's reads to the machine it is on", () =>
    Effect.gen(function* () {
      const { calls, placed } = setup({ value: true });
      yield* placed.git.local(REMOTE_PATH);
      yield* placed.git.local(LOCAL_PATH);
      yield* placed.files.list("/srv/gram-host/repos/git.example.test/acme/widgets", {
        showHidden: false,
      } as never);
      expect(calls).toEqual([
        `${MACHINE}:git.local:${REMOTE_PATH}`,
        `local:git.local:${LOCAL_PATH}`,
        `${MACHINE}:files.list`,
      ]);
    }),
  );

  it.effect("makes a checkout on the machine a request names, and this one's otherwise", () =>
    Effect.gen(function* () {
      const { calls, placed } = setup({ value: true });
      yield* placed.checkouts.prepare(
        { kind: "newWorktree", branch: "b", hostId: MACHINE },
        [],
        LOCAL_PATH,
      );
      yield* placed.checkouts.prepare({ kind: "newWorktree", branch: "b" }, [], LOCAL_PATH);
      yield* placed.checkouts.release(THREADS[0]!, { removeWorktree: { force: true } });
      expect(calls).toEqual([`${MACHINE}:prepare`, "local:prepare", `${MACHINE}:release`]);
    }),
  );

  it.effect("leaves a machine's own clone as it is to a headless Gram", () =>
    Effect.gen(function* () {
      const { calls, placed } = setup({ value: true });
      const refused = yield* placed.checkouts
        .prepare({ kind: "current", hostId: MACHINE }, [], LOCAL_PATH)
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "InvalidState",
        message: "A thread on a joined machine works in a new worktree there.",
      });
      expect(placed.checkouts.place).toBeUndefined();
      expect(calls).toEqual([]);

      const headless = setup(
        { value: true },
        { machine: Effect.succeed(MACHINE), ownerOf: () => undefined },
      );
      const request = yield* headless.placed.checkouts.place!({ kind: "current" });
      expect(request).toEqual({ kind: "current", hostId: MACHINE });
      yield* headless.placed.checkouts.prepare(request, [], LOCAL_PATH);
      expect(headless.calls).toEqual([`${MACHINE}:prepare`]);
    }),
  );

  it.effect("opens a thread's session and terminals on its machine", () =>
    Effect.gen(function* () {
      const { calls, placed } = setup({ value: true });
      const agent = yield* placed.sessions.get("claude");
      expect(yield* placed.sessions.get("claude")).toBe(agent);
      yield* Effect.scoped(agent.open({ threadId: ThreadId.make("t-remote") } as never));
      yield* Effect.scoped(agent.open({ threadId: ThreadId.make("t-local") } as never));
      const opened = yield* placed.terminals.open({
        threadId: ThreadId.make("t-remote"),
        cols: 80,
        rows: 24,
      });
      yield* placed.terminals.input(opened.terminalId, "ls\n");
      expect(calls).toEqual([
        `${MACHINE}:open:t-remote`,
        "local:open:t-local",
        `${MACHINE}:terminal.open:t-remote`,
        `${MACHINE}:terminal.input:${MACHINE}-t1`,
      ]);
    }),
  );

  it.effect("reaches a terminal the machine kept through a restart of this Gram", () =>
    Effect.gen(function* () {
      // A fresh placedHost is a main Gram that restarted: it never opened KEPT. Before this
      // change its input and close went to this machine, and the shell ran on there.
      const { calls, placed } = setup({ value: true });
      yield* placed.terminals.input(KEPT, "ls\n");
      yield* placed.terminals.close(KEPT);
      expect(calls).toEqual([
        `${MACHINE}:terminal.input:${KEPT}`,
        `${MACHINE}:terminal.close:${KEPT}`,
      ]);
    }),
  );

  it.effect("while the machine is offline: its folders are there, and nothing runs here", () =>
    Effect.gen(function* () {
      const { calls, placed } = setup({ value: false });
      expect(yield* placed.checkouts.present(REMOTE_PATH)).toBe(true);
      expect((yield* placed.git.local(REMOTE_PATH).pipe(Effect.flip))._tag).toBe("ProcSpawnError");
      const agent = yield* placed.sessions.get("claude");
      const refused = yield* Effect.scoped(
        agent.open({ threadId: ThreadId.make("t-remote") } as never),
      ).pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "AgentUnavailable",
        message: "That machine is offline.",
      });
      const prepared = yield* placed.checkouts
        .prepare({ kind: "newWorktree", branch: "b", hostId: MACHINE }, [], LOCAL_PATH)
        .pipe(Effect.flip);
      expect(prepared._tag).toBe("InvalidState");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("a folder inside a machine's checkout is that machine's too", () =>
    Effect.gen(function* () {
      const { calls, placed } = setup({ value: true });
      yield* placed.git.local(`${REMOTE_PATH}/src/deep`);
      yield* placed.git.local("/Users/me/elsewhere");
      expect(calls).toEqual([
        `${MACHINE}:git.local:${REMOTE_PATH}/src/deep`,
        "local:git.local:/Users/me/elsewhere",
      ]);
    }),
  );

  it.effect("a thread on an offline machine still closes, keeping its worktree there", () =>
    Effect.gen(function* () {
      const { calls, placed } = setup({ value: false });
      const remote = THREADS[0]!;
      yield* placed.checkouts.checkRelease(remote, {});
      yield* placed.checkouts.release(remote, {});
      const refused = yield* placed.checkouts
        .checkRelease(remote, { removeWorktree: { force: false } })
        .pipe(Effect.flip);
      expect(refused._tag).toBe("GitError");
      // Past the point of no return: logged, and the close goes on.
      yield* placed.checkouts.release(remote, { removeWorktree: { force: false } });
      expect(calls).toEqual([]);
    }),
  );

  it.effect(
    "never guesses between machines that hold the same path, and reaches each by its id",
    () =>
      Effect.gen(function* () {
        // Two machines with the same user and default folders, and this one, all at one path.
        const OTHER = HostId.make("m-fedcba9876543210fedcba98");
        const SHARED = "/srv/synthetic/work";
        const ROOT = "/srv/synthetic/repos/widgets";
        const threads = [
          thread("t-a", {
            kind: "worktree",
            path: SHARED,
            repoRoot: ROOT,
            hostId: MACHINE,
          } as never),
          thread("t-b", {
            kind: "worktree",
            path: `${ROOT}/.worktrees/b`,
            repoRoot: ROOT,
            hostId: OTHER,
          } as never),
          thread("t-b2", { kind: "worktree", path: SHARED, hostId: OTHER } as never),
          thread("t-local", { kind: "main", path: SHARED }),
        ];
        const calls: Array<string> = [];
        const byId = new Map([
          [LOCAL_HOST_ID, recordingHost(LOCAL_HOST_ID, calls)],
          [MACHINE, recordingHost(MACHINE, calls)],
          [OTHER, recordingHost(OTHER, calls)],
        ]);
        const placed = placedHost(
          { local: byId.get(LOCAL_HOST_ID)!, get: (id) => Effect.succeed(byId.get(id)!) },
          {
            listThreads: Effect.succeed(threads),
            getThread: (id) => Effect.succeed(threads.find((t) => t.id === id)!),
          },
        );
        // Before, the last thread at the path won: every caller's read went to that one machine.
        const refused = yield* placed.git.local(SHARED).pipe(Effect.flip);
        expect(refused.message).toContain("more than one machine");
        expect(
          (yield* placed.worktrees.list(ROOT, { openCheckouts: [] }).pipe(Effect.flip))._tag,
        ).toBe("WorktreeError");
        // What a path alone can't place isn't marked gone.
        expect(yield* placed.git.present(SHARED)).toBe(true);
        expect(calls).toEqual([]);
        // A worktree path only one machine holds is still that machine's, below a shared repo root.
        yield* placed.git.local(`${ROOT}/.worktrees/b`);
        // A caller that knows the machine reaches it, whoever else holds the path.
        yield* placed.machine(MACHINE).git.local(SHARED);
        yield* placed.machine(OTHER).git.local(SHARED);
        yield* placed.machine(LOCAL_HOST_ID).git.local(SHARED);
        expect(calls).toEqual([
          `${OTHER}:git.local:${ROOT}/.worktrees/b`,
          `${MACHINE}:git.local:${SHARED}`,
          `${OTHER}:git.local:${SHARED}`,
          `local:git.local:${SHARED}`,
        ]);
      }),
  );
});

/** `MACHINE` started for Grace, behind the door `WorkerHosts.get` keeps (`ownedMachines`). */
const graces = () => {
  const calls: Array<string> = [];
  // KEPT: a terminal it kept through a restart of this Gram, which Gram finds again by its id.
  const machine = recordingHost(MACHINE, calls, [KEPT]);
  const ownerOf = (id: HostId) => (id === MACHINE ? "grace" : undefined);
  const get = ownedMachines(ownerOf, (id: HostId) =>
    id === MACHINE
      ? Effect.succeed(machine)
      : Effect.fail(new HostUnavailable({ hostId: id, message: "That machine is offline." })),
  );
  const placed = placedHost(
    { local: recordingHost(LOCAL_HOST_ID, calls), get },
    {
      listThreads: Effect.succeed(THREADS),
      getThread: (id) => {
        const found = THREADS.find((t) => t.id === id);
        return found === undefined
          ? Effect.fail(new ThreadNotFound({ threadId: id }))
          : Effect.succeed(found);
      },
    },
  );
  return { calls, placed, get };
};
const as =
  (person: string | undefined) =>
  <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.provideService(ActingPerson, person),
      Effect.provideService(RoutedFor, { person }),
    );

describe("a machine started for one person, on every route to it", () => {
  // The review's case: Ada opens Grace's Sign in terminal, clears its line and types a command.
  it.effect(
    "keeps another member from her terminals, her sign-in shell and her thread's host",
    () =>
      Effect.gen(function* () {
        const { calls, placed, get } = graces();
        const signIn = yield* as("ada")(
          openSignInTerminal(placed.terminals, get, MACHINE, { cols: 80, rows: 24 }),
        ).pipe(Effect.flip);
        expect(signIn.message).toBe(NOT_YOUR_MACHINE);
        for (const open of [
          placed.terminals.open({ hostId: MACHINE, cols: 80, rows: 24 } as never),
          placed.terminals.open({ threadId: "t-remote", cols: 80, rows: 24 } as never),
        ])
          expect((yield* as("ada")(open).pipe(Effect.flip)).message).toBe(NOT_YOUR_MACHINE);
        // A terminal Grace opened is hers: Ada's keystrokes never reach it.
        const opened = yield* as("grace")(
          placed.terminals.open({ hostId: MACHINE, cols: 80, rows: 24 } as never),
        );
        calls.length = 0;
        const typed = yield* as("ada")(
          placed.terminals.input(opened.terminalId, "\u0015echo synthetic-command\r"),
        ).pipe(Effect.flip);
        // Answered as a terminal it can't find: it says nothing of whose it is.
        expect(typed._tag).toBe("NotFound");
        // Nor her files, git or a session in her thread.
        expect((yield* as("ada")(placed.git.local(REMOTE_PATH)).pipe(Effect.flip)).message).toBe(
          NOT_YOUR_MACHINE,
        );
        const agent = yield* placed.sessions.get("claude");
        expect(
          (yield* as("ada")(Effect.scoped(agent.open({ threadId: "t-remote" } as never))).pipe(
            Effect.flip,
          )).message,
        ).toBe(NOT_YOUR_MACHINE);
        // Nobody signed in is no one, so not Grace either.
        expect(
          (yield* as(undefined)(placed.terminals.input(opened.terminalId, "x")).pipe(Effect.flip))
            ._tag,
        ).toBe("NotFound");
        expect(calls).toEqual([]);
      }),
  );

  it.effect("serves its owner, and the server's own work on what is already there", () =>
    Effect.gen(function* () {
      const { calls, placed, get } = graces();
      yield* as("grace")(
        openSignInTerminal(placed.terminals, get, MACHINE, { cols: 80, rows: 24 }),
      );
      const opened = yield* as("grace")(
        placed.terminals.open({ hostId: MACHINE, cols: 80, rows: 24 } as never),
      );
      yield* as("grace")(placed.terminals.input(opened.terminalId, "ls\r"));
      // A session the server reopens on its own carries no caller.
      yield* Effect.scoped(
        (yield* placed.sessions.get("claude")).open({ threadId: "t-remote" } as never),
      );
      expect(calls).toEqual([
        `${MACHINE}:terminal.open:undefined`,
        `${MACHINE}:terminal.input:${MACHINE}-t1`,
        `${MACHINE}:terminal.open:undefined`,
        `${MACHINE}:terminal.input:${MACHINE}-t1`,
        `${MACHINE}:open:t-remote`,
      ]);
    }),
  );

  // Round 5's route: a terminal's id alone, with no thread named. Every terminal call resolves
  // its machine through the one door (`ownedMachines`), a terminal found again after a restart
  // included, so the id gets no one onto Grace's machine.
  it.effect("routes a terminal by its id alone through the owner's door, a kept one included", () =>
    Effect.gen(function* () {
      const { calls, placed } = graces();
      for (const call of [
        placed.terminals.input(KEPT, "synthetic command\r"),
        placed.terminals.resize(KEPT, 80, 24),
        placed.terminals.close(KEPT),
      ])
        yield* as("ada")(call).pipe(Effect.ignore);
      expect(calls.filter((call) => call.startsWith(`${MACHINE}:`))).toEqual([]);
      // Grace's own reach it.
      yield* as("grace")(placed.terminals.input(KEPT, "ls\r"));
      expect(calls).toContain(`${MACHINE}:terminal.input:${KEPT}`);
    }),
  );
});
