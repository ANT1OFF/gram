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
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { placedHost } from "./placed.ts";
import type { WorkerHost } from "./worker-host.ts";

const MACHINE = HostId.make("m-0123456789abcdef01234567");
const REMOTE_PATH = "/srv/gram-host/repos/git.example.test/acme/widgets.worktrees/feature";
const LOCAL_PATH = "/Users/me/widgets";

/** A host that records each call it answers, by its name. */
const recordingHost = (id: HostId, calls: Array<string>): WorkerHost => {
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
      close: say("close"),
      list: () => Effect.succeed([]),
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

const setup = (online: { value: boolean }) => {
  const calls: Array<string> = [];
  const local = recordingHost(LOCAL_HOST_ID, calls);
  const machine = recordingHost(MACHINE, calls);
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
      yield* placed.checkouts.release(THREADS[0]!, {});
      expect(calls).toEqual([`${MACHINE}:prepare`, "local:prepare", `${MACHINE}:release`]);
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
});
