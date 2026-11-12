// Where a thread started from a profile is placed when the server is headless: on the joined
// machine that takes what names none, its folder made and its files laid by that machine's host.
// Over stubs of the machine's host; the real host and the real protocol are in
// `host/headless-control-plane.test.ts` and `host/thread-places.test.ts`.
import { describe, expect, it } from "@effect/vitest";
import {
  applySettingsPatch,
  type Checkout,
  DEFAULT_SETTINGS,
  HostId,
  HostUnavailable,
  InvalidState,
  LOCAL_HOST_ID,
  type ProfileFile,
  type Thread,
  type ThreadId,
  ThreadNotFound,
  type ThreadProfile,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { olderHost } from "../host/folders.ts";
import { NO_MACHINE_JOINED } from "../host/headless.ts";
import type { HostThreadPlaces } from "../host/thread-places.ts";
import type { WorkerHost } from "../host/worker-host.ts";
import type { CreateThreadInput } from "../runtime/thread-runtimes-shape.ts";
import type { ProfileRepositories } from "./repositories.ts";
import { makeProfileStarter, NAME_A_MACHINE, PROFILE_THREADS_DIR } from "./start.ts";

const MACHINE = HostId.make("machine-1");
const ON = applySettingsPatch(DEFAULT_SETTINGS, { experimental: { embedding: true } });

const profile = (over: Partial<ThreadProfile> = {}): ThreadProfile => ({
  version: 1,
  agent: "claude",
  charter: "You write release notes.",
  files: [{ path: "AGENTS.md", content: "# House rules\n" }],
  model: { model: "fake-model" },
  connectors: {},
  workplace: { kind: "scratch" },
  ...over,
});

/** A starter over a headless server's placement, recording what the machine's host was asked. */
const headless = (
  options: {
    readonly places?: boolean;
    readonly machine?: Effect.Effect<HostId, InvalidState>;
    readonly create?: (input: CreateThreadInput) => Effect.Effect<Thread, InvalidState>;
    readonly repositories?: ProfileRepositories;
    /** False for a server that isn't headless: it places only what names a machine. */
    readonly headless?: boolean;
  } = {},
) => {
  const dataDir = mkdtempSync(join(tmpdir(), "gram-profile-placement-"));
  const calls: Array<
    | {
        readonly call: "make";
        readonly threadId: ThreadId;
        readonly files: ReadonlyArray<ProfileFile>;
      }
    | {
        readonly call: "lay";
        readonly checkout: string;
        readonly files: ReadonlyArray<ProfileFile>;
      }
    | { readonly call: "remove"; readonly threadId: ThreadId }
    | { readonly call: "close"; readonly threadId: ThreadId }
  > = [];
  const created: Array<CreateThreadInput> = [];
  const places: HostThreadPlaces = {
    make: (threadId, files) =>
      Effect.sync(() => {
        calls.push({ call: "make", threadId, files });
        return { path: `/machine/repos/.threads/${threadId}` };
      }),
    lay: (checkout, files) =>
      Effect.sync(() => {
        calls.push({ call: "lay", checkout, files });
        return { laid: files.map((file) => file.path) };
      }),
    remove: (threadId) => Effect.sync(() => void calls.push({ call: "remove", threadId })),
  };
  const host = {
    id: MACHINE,
    name: "build box",
    ...(options.places === false ? {} : { threadPlaces: places }),
  } as WorkerHost;
  const starter = makeProfileStarter({
    store: {
      getSettings: Effect.succeed(ON),
      listProfiles: Effect.succeed([]),
      ensureProject: () => Effect.void as never,
      getThread: (threadId) => Effect.fail(new ThreadNotFound({ threadId })),
      listClosed: Effect.succeed([]),
    },
    runtimes: {
      create: (input) => {
        created.push(input);
        return (options.create?.(input) ??
          Effect.succeed({ id: input.id, checkout: input.checkout } as Thread)) as never;
      },
      close: (threadId) => Effect.sync(() => void calls.push({ call: "close", threadId })) as never,
    },
    dataDir,
    repositories: options.repositories,
    hosts: {
      ...(options.headless === false
        ? {}
        : {
            headless: {
              machine: options.machine ?? Effect.succeed(MACHINE),
              ownerOf: () => undefined,
            },
          }),
      get: (id) =>
        id === MACHINE
          ? Effect.succeed(host)
          : Effect.fail(new HostUnavailable({ hostId: id, message: `No machine "${id}".` })),
    },
  });
  return { starter, calls, created, dataDir, cleanup: () => rmSync(dataDir, { recursive: true }) };
};

describe("a profile thread on a headless server", () => {
  it.effect("is placed on the default machine, in a folder the machine's host makes", () =>
    Effect.gen(function* () {
      const { starter, calls, created, dataDir, cleanup } = headless();
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      const thread = yield* starter.start(profile());
      expect(calls).toEqual([
        {
          call: "make",
          threadId: thread.id,
          files: [{ path: "AGENTS.md", content: "# House rules\n" }],
        },
      ]);
      expect(created[0]?.checkout).toEqual({
        kind: "main",
        path: `/machine/repos/.threads/${thread.id}`,
        hostId: MACHINE,
      });
      // Nothing of the thread is written here: the project's folder is empty.
      expect(readdirSync(join(dataDir, PROFILE_THREADS_DIR))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("is refused, with nothing made, when no machine can take it or its host is older", () =>
    Effect.gen(function* () {
      const none = headless({
        machine: Effect.fail(new InvalidState({ message: NO_MACHINE_JOINED })),
      });
      const older = headless({ places: false });
      yield* Effect.addFinalizer(() => Effect.sync(() => (none.cleanup(), older.cleanup())));
      expect(yield* none.starter.start(profile()).pipe(Effect.flip)).toMatchObject({
        _tag: "InvalidState",
        message: NO_MACHINE_JOINED,
      });
      expect(yield* older.starter.start(profile()).pipe(Effect.flip)).toMatchObject({
        _tag: "InvalidState",
        message: olderHost({ name: "build box" }),
      });
      for (const each of [none, older]) {
        expect(each.calls).toEqual([]);
        expect(each.created).toEqual([]);
        expect(existsSync(join(each.dataDir, PROFILE_THREADS_DIR))).toBe(false);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("takes the folder back from the machine when the thread can't be created", () =>
    Effect.gen(function* () {
      const { starter, calls, cleanup } = headless({
        create: () => Effect.fail(new InvalidState({ message: "no" })),
      });
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      yield* starter.start(profile()).pipe(Effect.flip);
      expect(calls.map((each) => each.call)).toEqual(["make", "close", "remove"]);
    }).pipe(Effect.scoped),
  );

  it.effect("lays a repository workplace's files on the machine its worktree was placed on", () =>
    Effect.gen(function* () {
      const worktree: Checkout = {
        kind: "worktree",
        path: "/machine/repos/git.example.test/acme/widgets/.worktrees/thread-1",
        hostId: MACHINE,
        branch: "thread/1",
      };
      const local: Array<string> = [];
      const repositories: ProfileRepositories = {
        prepare: () =>
          Effect.succeed({ projectRoot: "/data/clone", checkout: worktree, extraCheckouts: [] }),
        exclude: (checkout) => Effect.sync(() => void local.push(checkout)),
        discard: () => Effect.void,
      };
      const { starter, calls, created, cleanup } = headless({ repositories });
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      yield* starter.start(
        profile({
          workplace: {
            kind: "repositories",
            repositories: [{ url: "https://git.example.test/acme/widgets.git" }],
          },
        }),
      );
      expect(calls).toEqual([
        {
          call: "lay",
          checkout: worktree.path,
          files: [{ path: "AGENTS.md", content: "# House rules\n" }],
        },
      ]);
      // Nothing was written or excluded on this machine, where that path means something else.
      expect(local).toEqual([]);
      expect(existsSync(worktree.path)).toBe(false);
      expect(created[0]?.checkout).toEqual(worktree);
    }).pipe(Effect.scoped),
  );

  it.effect("goes on the machine a caller names, on any server, and only there", () =>
    Effect.gen(function* () {
      // Not headless, and a default machine that isn't the one named: the named one is used.
      const { starter, calls, created, dataDir, cleanup } = headless({
        headless: false,
        machine: Effect.fail(new InvalidState({ message: "not asked" })),
      });
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      const started = yield* starter.startOne(profile(), { on: MACHINE });
      expect(started.created).toBe(true);
      expect(calls.map((each) => each.call)).toEqual(["make"]);
      expect(created[0]?.checkout).toMatchObject({ kind: "main", hostId: MACHINE });
      expect(readdirSync(join(dataDir, PROFILE_THREADS_DIR))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a machine that isn't joined, or this one, before anything is made", () =>
    Effect.gen(function* () {
      const prepared: Array<unknown> = [];
      const repositories: ProfileRepositories = {
        prepare: (...args) =>
          Effect.sync(() => void prepared.push(args)).pipe(
            Effect.andThen(Effect.fail(new InvalidState({ message: "not asked" }))),
          ),
        exclude: () => Effect.void,
        discard: () => Effect.void,
      };
      const { starter, calls, created, dataDir, cleanup } = headless({ repositories });
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      const gone = HostId.make("machine-gone");
      for (const workplace of [
        { kind: "scratch" as const },
        {
          kind: "repositories" as const,
          repositories: [{ url: "https://git.example.test/acme/widgets.git" }],
        },
      ]) {
        const unknown = yield* starter
          .startOne(profile({ workplace }), { on: gone })
          .pipe(Effect.flip);
        expect(unknown.message).toBe('No machine "machine-gone".');
        const here = yield* starter
          .startOne(profile({ workplace }), { on: LOCAL_HOST_ID })
          .pipe(Effect.flip);
        expect(here.message).toBe(NAME_A_MACHINE);
      }
      expect(prepared).toEqual([]);
      expect(calls).toEqual([]);
      expect(created).toEqual([]);
      expect(existsSync(join(dataDir, PROFILE_THREADS_DIR))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("makes a repository workplace's worktrees on the machine a caller names", () =>
    Effect.gen(function* () {
      const asked: Array<HostId | undefined> = [];
      const repositories: ProfileRepositories = {
        prepare: (_threadId, _repositories, machine) =>
          Effect.sync(() => {
            asked.push(machine);
            return {
              projectRoot: "/data/clone",
              checkout: {
                kind: "worktree" as const,
                path: "/machine/repos/widgets/.worktrees/t",
                hostId: MACHINE,
                branch: "thread/t",
              },
              extraCheckouts: [],
            };
          }),
        exclude: () => Effect.void,
        discard: () => Effect.void,
      };
      const { starter, calls, cleanup } = headless({ repositories, headless: false });
      yield* Effect.addFinalizer(() => Effect.sync(cleanup));
      yield* starter.startOne(
        profile({
          workplace: {
            kind: "repositories",
            repositories: [{ url: "https://git.example.test/acme/widgets.git" }],
          },
        }),
        { on: MACHINE },
      );
      expect(asked).toEqual([MACHINE]);
      expect(calls.map((each) => each.call)).toEqual(["lay"]);
    }).pipe(Effect.scoped),
  );
});
