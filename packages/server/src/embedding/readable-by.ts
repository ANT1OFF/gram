// Threads readable by one person only (`Thread.readableBy`), for an embedding host.
//
// A host that starts a thread from a profile may name the one subject who may see it
// (`ProfileStartRequest.readableBy`, a subject as fronted sign-in names people). The thread keeps
// it for good: no write changes or clears it (`ThreadStore`), and every thread it spawns, forks or
// makes from one of its agent's tool calls gets the same (`ThreadRuntimes.create`). A thread linked
// to another (a worker under an orchestrator, a join, an adoption) must have the same, so an
// orchestration is all one person's or none of it is.
//
// Who reads is the fiber's reader (`currentReader`): every RPC as its signed-in person, or as no
// one without fronted sign-in (`rpc/actor-guard.ts`); every agent tool call as its own thread's
// `readableBy`, or no one for a thread without it (`app-tools/registry.ts`); the server's own work
// as the server, which reads everything. A fiber that says nothing is no one, as with machines
// (`host/ownership.ts`). One rule, `mayRead`, decides; a reader with no subject never reads such a
// thread, so the rule fails closed.
//
// Whose a thread is gets asked on paths with no store at hand (an event on its way to a window), so
// the store notes each thread's `readableBy` wherever it reads or writes one, and once when it
// opens (`notePrivacy`). The value never changes, so the note never goes stale.
//
// Readers. Beside its person, such a thread may have readers (`Thread.readers`), set by the
// embedding host (`THREAD_READERS_PATH`): people who see it as its person does but never act on
// it. So there are two levels. Reading (`readerMay` given a `Privacy`, `level: "read"`) admits its
// person and its readers; acting (`readerMay` given the bare subject, `level: "act"`, the default
// everywhere) admits its person alone. A reader's agent is never a reader: what it reads would
// end up in a thread of its own that others may read. Unlike `readableBy`, readers change, so the
// store notes them on every write and on the host's change (`noteReaders`), never from a read.

import { isAbsolute, resolve } from "node:path";
import { isInside, physicalPath } from "@gram/git";
import type { Thread, ThreadId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { currentCaller } from "../host/ownership.ts";

/** Who reads: a person's subject, or none (no signed-in person, or a thread without one). */
export interface Reader {
  readonly subject: string | undefined;
  /**
   * The reader is a thread's agent (a tool call): a thread made in its call is made for the same
   * person, as that thread is (`spawnScope`).
   */
  readonly fromThread?: boolean | undefined;
  /** With `fromThread`: the thread whose agent it is, whose readers what it makes inherits. */
  readonly thread?: ThreadId | undefined;
}

/**
 * Who may see a thread readable by one person: that person (`readableBy`), and its readers, who
 * read but never act (`Thread.readers`).
 */
export interface Privacy {
  readonly readableBy: string;
  readonly readers: ReadonlySet<string>;
}

/**
 * What the rule is given: a bare subject (its person alone, the level of acting), who may see it
 * (`Privacy`, the level of reading), or undefined for a thread everyone may see.
 */
export type Readable = string | Privacy | undefined;

/** Whether a check is of reading a thread (its readers too) or of acting on it (its person). */
export type Level = "read" | "act";

/** What a reader who may only read a thread is told when it would act on it. */
export const ONLY_READS = "You may read that thread, but only the person it is for acts on it.";

/** The server's own work, which reads everything: said where a route is the server's own. */
export const SERVER = "server" as const;

/**
 * Who this fiber reads as, where an entry point said: every HTTP request and socket a person can
 * reach, as their subject or as no one (`http/server.ts`), the platform's own service as the
 * server; every RPC (`rpc/actor-guard.ts`) and every agent tool call (`app-tools/registry.ts`).
 * Absent: read from the caller the fiber is routed for (`currentCaller`), which is the server's
 * only where the server's own work said so (`ServerWork`), and no one otherwise.
 */
export const ReadingAs = Context.Reference<Reader | typeof SERVER | undefined>(
  "@gram/server/ReadingAs",
  { defaultValue: () => undefined },
);

/** No one: a person-facing request with no signed-in person, or a thread without a reader. */
export const NOBODY: Reader = { subject: undefined };

/** What a reader who may not see a thread is told: as if there were none. */
export const NOT_READABLE = "That thread isn't there.";

/** The longest subject a thread is kept for, as `startedBy`: printable, at most 128 characters. */
export const SUBJECT = /^[\x21-\x7e]{1,128}$/;

const known = new Map<ThreadId, string>();

/** Each thread's readers beside its person, as last written (`noteReaders`). */
const readersKnown = new Map<ThreadId, ReadonlySet<string>>();

/** Each workspace's readers, as its threads' last written: they are all one person's. */
const workspaceReaderSets = new Map<string, ReadonlySet<string>>();

const NO_READERS: ReadonlySet<string> = new Set();

/**
 * The reader of each workspace a thread readable by one person belongs to, noted with the thread:
 * what the workspace holds (its finished workers, memory, docs, outputs) stays that person's after
 * its orchestrator has gone. A workspace links only threads of one reader, so a workspace has one.
 */
const workspaceReaders = new Map<string, string>();

/**
 * Every folder a thread readable by one person has worked in, as noted: its checkout, the one it
 * follows now, and its other worktrees. Only ever added to, so a folder it moved out of stays its
 * (`touchesUnreadable` fails closed).
 */
const foldersOf = new Map<ThreadId, Set<string>>();

/**
 * The machines (`undefined` for this one) and the repositories (their top folders) a thread
 * readable by one person has worked in, as noted: what a shell there, or another checkout of the
 * same repository, could read of it beside the API (`sharesWithUnreadable`).
 */
const machinesOf = new Map<ThreadId, Set<string | undefined>>();
const reposOf = new Map<ThreadId, Set<string>>();

/** A checkout as the store keeps it. */
interface CheckoutAt {
  readonly path: string;
  readonly hostId?: string | undefined;
  readonly repoRoot?: string | undefined;
}

/** The folders of a thread as the store keeps it, any of which may be absent. */
export interface ThreadFolders {
  readonly checkout?: CheckoutAt | undefined;
  readonly currentCheckout?: CheckoutAt | undefined;
  readonly extraCheckouts?: ReadonlyArray<CheckoutAt> | undefined;
}

/**
 * Told each time a thread readable by one person is first noted on a machine (`undefined`: this
 * one), with its reader: what was open there for someone else must close (`rpc/handlers/terminal.ts`).
 */
const placedListeners = new Set<(reader: string, machine: string | undefined) => void>();

/** Listens for a private thread first noted on a machine; the answer stops listening. */
export const onPrivatePlaced = (
  listener: (reader: string, machine: string | undefined) => void,
): (() => void) => {
  placedListeners.add(listener);
  return () => void placedListeners.delete(listener);
};

/** The machine a checkout is on as the privacy notes key it: `undefined` for this one. */
export const machineKey = (hostId: string | undefined): string | undefined =>
  hostId === undefined || hostId === "local" ? undefined : hostId;

/** Notes whose a thread is, as it is read or written, and where it works. A reader never changes. */
export const notePrivacy = (
  thread: Pick<Thread, "id" | "readableBy"> & {
    readonly readers?: ReadonlyArray<string> | undefined;
  } & ThreadFolders & { readonly workspaceId?: string | undefined },
): void => {
  if (thread.readableBy === undefined) return;
  if (!known.has(thread.id)) known.set(thread.id, thread.readableBy);
  if (!readersKnown.has(thread.id)) noteReaders(thread);
  if (typeof thread.workspaceId === "string" && !workspaceReaders.has(thread.workspaceId))
    workspaceReaders.set(thread.workspaceId, thread.readableBy);
  const paths = [thread.checkout, thread.currentCheckout, ...(thread.extraCheckouts ?? [])];
  for (const each of paths) {
    if (each === undefined || typeof each.path !== "string" || !isAbsolute(each.path)) continue;
    let folders = foldersOf.get(thread.id);
    if (folders === undefined) foldersOf.set(thread.id, (folders = new Set()));
    folders.add(resolve(each.path));
    let machines = machinesOf.get(thread.id);
    if (machines === undefined) machinesOf.set(thread.id, (machines = new Set()));
    const machine = machineKey(each.hostId);
    if (!machines.has(machine)) {
      machines.add(machine);
      for (const listener of placedListeners) listener(thread.readableBy, machine);
    }
    if (typeof each.repoRoot === "string" && isAbsolute(each.repoRoot)) {
      let repos = reposOf.get(thread.id);
      if (repos === undefined) reposOf.set(thread.id, (repos = new Set()));
      repos.add(resolve(each.repoRoot));
    }
  }
};

/**
 * Notes a thread's readers as written (`Thread.readers`), replacing what was noted: on every
 * write of the thread and on the host's change, never on a read, which may be older.
 */
export const noteReaders = (
  thread: Pick<Thread, "id" | "readableBy"> & {
    readonly readers?: ReadonlyArray<string> | undefined;
    readonly workspaceId?: string | undefined;
  },
): void => {
  if (thread.readableBy === undefined) return;
  const readers =
    thread.readers === undefined || thread.readers.length === 0
      ? NO_READERS
      : new Set(thread.readers);
  readersKnown.set(thread.id, readers);
  if (typeof thread.workspaceId === "string") workspaceReaderSets.set(thread.workspaceId, readers);
};

/**
 * Whether a thread `reader` may not see works on the machine `hostId` (`undefined`: this one):
 * a shell there reaches its folder and this server's own files whatever the API refuses.
 */
export const machineHoldsUnreadable = (
  reader: Reader | undefined,
  hostId: string | undefined,
): boolean => {
  if (!anyPrivate()) return false;
  const key = machineKey(hostId);
  for (const [id, machines] of machinesOf)
    if (!readerMay(reader, known.get(id)) && machines.has(key)) return true;
  return false;
};

/**
 * Whether any of `paths` (absolute) is in a repository a thread `reader` may not see has a
 * checkout of: another checkout of it shares its `.git`, where that thread's commits are.
 */
export const sharesRepoWithUnreadable = (
  reader: Reader | undefined,
  paths: ReadonlyArray<string>,
  level: Level = "act",
): boolean => {
  if (paths.length === 0 || !anyPrivate()) return false;
  const repos: Array<string> = [];
  for (const [id, roots] of reposOf) if (!readerMay(reader, at(id, level))) repos.push(...roots);
  if (repos.length === 0) return false;
  return paths.some((path) => {
    const written = resolve(path);
    const real = realOf(written);
    return repos.some((repo) => within(written, repo) || within(real, repo));
  });
};

/**
 * Lines of a log with nothing of a thread `reader` may not see: no line naming its id or one of
 * its folders. Every line while no thread is readable by one person.
 */
export const logLinesFor = (
  reader: Reader | undefined,
  lines: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (!anyPrivate()) return lines;
  const hidden: Array<string> = [];
  for (const [id] of known)
    if (!readerMay(reader, at(id, "read"))) hidden.push(id, ...(foldersOf.get(id) ?? []));
  if (hidden.length === 0) return lines;
  return lines.filter((line) => !hidden.some((needle) => line.includes(needle)));
};

/** Whether any thread here is readable by one person: none, and nothing need be asked. */
export const anyPrivate = (): boolean => known.size > 0;

/** The subject a thread is readable by, as noted; undefined for a thread readable by anyone. */
export const readableByOf = (threadId: ThreadId): string | undefined => known.get(threadId);

/** The readers a thread has beside its person, as noted (`Thread.readers`). */
export const readersOf = (threadId: ThreadId): ReadonlySet<string> =>
  readersKnown.get(threadId) ?? NO_READERS;

/** Who may see a thread, as noted: its person and its readers; undefined for anyone. */
export const privacyOf = (threadId: ThreadId): Privacy | undefined => {
  const readableBy = known.get(threadId);
  return readableBy === undefined ? undefined : { readableBy, readers: readersOf(threadId) };
};

/** Who may see `thread`, as noted where it is, else as the value says. */
export const privacyOfThread = (
  thread: Pick<Thread, "id" | "readableBy"> & {
    readonly readers?: ReadonlyArray<string> | undefined;
  },
): Privacy | undefined =>
  privacyOf(thread.id) ??
  (thread.readableBy === undefined
    ? undefined
    : { readableBy: thread.readableBy, readers: new Set(thread.readers ?? []) });

/** A thread's `Readable` at `level`: its privacy to read, its person alone to act. */
const at = (threadId: ThreadId, level: Level): Readable =>
  level === "read" ? privacyOf(threadId) : known.get(threadId);

/**
 * The subject a workspace is readable by: its threads' reader, as noted, else its orchestrator's
 * (`orchestrator`, where the caller knows it); undefined for a workspace anyone may see.
 */
export const readableByOfWorkspace = (
  workspaceId: string,
  orchestrator?: ThreadId | undefined,
): string | undefined =>
  workspaceReaders.get(workspaceId) ??
  (orchestrator === undefined ? undefined : known.get(orchestrator));

/** Who may see a workspace (`readableByOfWorkspace`) and its readers; undefined for anyone. */
export const privacyOfWorkspace = (
  workspaceId: string,
  orchestrator?: ThreadId | undefined,
): Privacy | undefined => {
  const readableBy = readableByOfWorkspace(workspaceId, orchestrator);
  if (readableBy === undefined) return undefined;
  const readers =
    workspaceReaderSets.get(workspaceId) ??
    (orchestrator === undefined ? undefined : readersKnown.get(orchestrator)) ??
    NO_READERS;
  return { readableBy, readers };
};

/** This fiber's reader: `ReadingAs`, else its caller's person; undefined for the server's work. */
export const currentReader: Effect.Effect<Reader | undefined> = Effect.gen(function* () {
  const said = yield* ReadingAs;
  if (said === SERVER) return undefined;
  if (said !== undefined) return said;
  const caller = yield* currentCaller;
  return caller === undefined ? undefined : { subject: caller.person };
});

/**
 * The rule, given the reader: anyone for a thread without `readableBy`; else its person; and,
 * given its `Privacy` (reading), its readers too, unless the reader is an agent. The server's own
 * work (`undefined`) reads and acts on everything.
 */
export const readerMay = (reader: Reader | undefined, readable: Readable): boolean => {
  const readableBy = typeof readable === "string" ? readable : readable?.readableBy;
  if (readableBy === undefined || reader === undefined) return true;
  if (reader.subject === undefined) return false;
  if (reader.subject === readableBy) return true;
  return (
    typeof readable === "object" &&
    reader.fromThread !== true &&
    readable.readers.has(reader.subject)
  );
};

/** Whether this fiber's reader may see a thread who may see is this (`Readable`). */
export const mayRead = (readable: Readable): Effect.Effect<boolean> =>
  Effect.map(currentReader, (reader) => readerMay(reader, readable));

/** Whether this fiber's reader may see the thread `threadId`, as noted (`privacyOf`). */
export const mayReadThread = (threadId: ThreadId): Effect.Effect<boolean> =>
  mayRead(privacyOf(threadId));

/** The threads this fiber's reader may not see, as noted: for a query to leave out. */
export const hiddenThreads: Effect.Effect<ReadonlyArray<ThreadId>> = Effect.map(
  currentReader,
  (reader) => [...known].flatMap(([id]) => (readerMay(reader, privacyOf(id)) ? [] : [id])),
);

/** `items` this fiber's reader may see, by the thread each is of; none of a thread it may not. */
export const readableOnly = <A>(
  items: ReadonlyArray<A>,
  threadOf: (item: A) => ThreadId | Pick<Thread, "id" | "readableBy" | "readers"> | undefined,
): Effect.Effect<ReadonlyArray<A>> =>
  Effect.map(currentReader, (reader) =>
    items.filter((item) => {
      const of = threadOf(item);
      if (of === undefined) return true;
      return readerMay(reader, typeof of === "string" ? privacyOf(of) : privacyOfThread(of));
    }),
  );

/** A workspace as the reader rule asks about it: its id and orchestrator, where it has one. */
interface WorkspaceKey {
  readonly id: string;
  readonly orchestratorThreadId?: string | undefined;
}

/** Whether `reader` may see the workspace `workspace` (`privacyOfWorkspace`), at `level`. */
export const readerMayWorkspace = (
  reader: Reader | undefined,
  workspace: WorkspaceKey,
  level: Level = "read",
): boolean => {
  const orchestrator = workspace.orchestratorThreadId as ThreadId | undefined;
  return readerMay(
    reader,
    level === "read"
      ? privacyOfWorkspace(workspace.id, orchestrator)
      : readableByOfWorkspace(workspace.id, orchestrator),
  );
};

/** `items` this fiber's reader may see, by the workspace each is of (`readerMayWorkspace`). */
export const readableWorkspacesOnly = <A>(
  items: ReadonlyArray<A>,
  workspaceOf: (item: A) => WorkspaceKey,
): Effect.Effect<ReadonlyArray<A>> =>
  Effect.map(currentReader, (reader) =>
    items.filter((item) => readerMayWorkspace(reader, workspaceOf(item))),
  );

/**
 * The `readableBy` a thread made in this fiber inherits from the agent whose tool call makes it
 * (`Reader.fromThread`): a private thread's agent makes only threads private to the same person.
 */
export const spawnScope: Effect.Effect<string | undefined> = Effect.map(ReadingAs, (reader) =>
  reader !== undefined && reader !== SERVER && reader.fromThread === true
    ? reader.subject
    : undefined,
);

/** The thread whose agent's tool call this fiber runs (`Reader.thread`), whose readers it keeps. */
export const spawnThread: Effect.Effect<ThreadId | undefined> = Effect.map(ReadingAs, (reader) =>
  reader !== undefined && reader !== SERVER && reader.fromThread === true
    ? reader.thread
    : undefined,
);

/** A key that names a thread of this server's, never another service's (a review's on GitHub). */
const THREAD_KEY = /^(threadId|[a-z]+ThreadId)$/;
const NOT_THREAD_KEYS: ReadonlySet<string> = new Set(["reviewThreadId"]);

/**
 * Every thread a call's payload names anywhere in it, a few levels down too (`answers[].threadId`):
 * what a call reads or acts on, for the readers' rule (`embedding/readable-by.ts`), which must miss
 * none: an RPC's payload (`rpc/actor-guard.ts`) and an agent tool's input (`app-tools/registry.ts`).
 */
export const threadsMentioned = (payload: unknown): ReadonlyArray<ThreadId> => {
  const found: Array<ThreadId> = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 500)) walk(item, depth + 1);
      return;
    }
    for (const [key, field] of Object.entries(value)) {
      if (typeof field === "string" && THREAD_KEY.test(key) && !NOT_THREAD_KEYS.has(key)) {
        found.push(field as ThreadId);
      } else if (key === "threadIds" && Array.isArray(field)) {
        for (const id of field) if (typeof id === "string") found.push(id as ThreadId);
      } else {
        walk(field, depth + 1);
      }
    }
  };
  walk(payload, 0);
  return found;
};

/** Every workspace a call's payload or a tool's input names by id, anywhere in it. */
export const workspacesMentioned = (payload: unknown): ReadonlyArray<string> => {
  const found: Array<string> = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 500)) walk(item, depth + 1);
      return;
    }
    for (const [key, field] of Object.entries(value)) {
      if (key === "workspaceId" && typeof field === "string") found.push(field);
      else walk(field, depth + 1);
    }
  };
  walk(payload, 0);
  return found;
};

/** What a link between threads of two different `readableBy`s (or one's and none) is told. */
export const READERS_DIFFER = "Threads that work together are readable by the same person.";

/**
 * The threads that share `root`'s privacy: those it spawned or forked, and its workspaces', and
 * theirs in turn, of the same `readableBy`, open or closed. What a change of readers applies to,
 * since a reader of one of them reads what the others did for it.
 */
export const privacyFamily = (
  root: Pick<Thread, "id" | "readableBy"> & { readonly workspaceId?: string | undefined },
  threads: ReadonlyArray<
    Pick<Thread, "id" | "readableBy" | "spawnedBy" | "forkedFrom"> & {
      readonly workspaceId?: string | undefined;
    }
  >,
): ReadonlyArray<ThreadId> => {
  if (root.readableBy === undefined) return [];
  const same = threads.filter((thread) => thread.readableBy === root.readableBy);
  const family = new Set<ThreadId>([root.id]);
  const workspaces = new Set<string>(root.workspaceId === undefined ? [] : [root.workspaceId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const thread of same) {
      if (family.has(thread.id)) continue;
      const linked =
        (thread.spawnedBy !== undefined && family.has(thread.spawnedBy.threadId)) ||
        (thread.forkedFrom?.threadId !== undefined && family.has(thread.forkedFrom.threadId)) ||
        (thread.workspaceId !== undefined && workspaces.has(thread.workspaceId));
      if (!linked) continue;
      family.add(thread.id);
      if (thread.workspaceId !== undefined) workspaces.add(thread.workspaceId);
      grew = true;
    }
  }
  return [...family];
};

/** Whether two threads may be linked (a worker and its orchestrator, a join, an adoption). */
export const sameReaders = (
  a: Pick<Thread, "id" | "readableBy">,
  b: Pick<Thread, "id" | "readableBy">,
): boolean => (a.readableBy ?? readableByOf(a.id)) === (b.readableBy ?? readableByOf(b.id));

// Folders. A thread readable by one person has its files in a folder (a profile's AGENTS.md and
// instructions, its work), which a call taking a path of the caller's choosing could reach. A call
// naming a path inside such a folder, by any spelling (`..`, a link that leads there), is refused
// to anyone the thread is unreadable by (`rpc/actor-guard.ts`), and a listing of a folder above it
// leaves the folder out (`withoutUnreadable`).

/** `path` with every link resolved, as far as it exists; the rest as written (`physicalPath`). */
export const realOf = (path: string): string => physicalPath(path);

/** Whether `path` is `folder` or inside it, by whole components. */
const within = (path: string, folder: string): boolean => isInside(folder, path);

/** The folders, as written and with links resolved, of the threads `reader` may not see. */
const unreadableFolders = (reader: Reader | undefined, level: Level): ReadonlyArray<string> => {
  const folders: Array<string> = [];
  for (const [id, paths] of foldersOf) {
    if (readerMay(reader, at(id, level))) continue;
    for (const path of paths) {
      folders.push(path);
      const real = realOf(path);
      if (real !== path) folders.push(real);
    }
  }
  return folders;
};

/** Whether any of `paths` (absolute) lies in a folder of a thread `reader` may not see. */
export const touchesUnreadable = (
  reader: Reader | undefined,
  paths: ReadonlyArray<string>,
  level: Level = "act",
): boolean => {
  if (paths.length === 0 || !anyPrivate()) return false;
  const folders = unreadableFolders(reader, level);
  if (folders.length === 0) return false;
  return paths.some((path) => {
    const written = resolve(path);
    const real = realOf(written);
    return folders.some((folder) => within(written, folder) || within(real, folder));
  });
};

/** A key that names a path of the caller's choosing, a folder or a file. */
const PATH_KEY =
  /(path|paths|root|roots|cwd|dir|directory|directories|folder|worktree|file|files)$/i;

/**
 * Every path a call's payload names, anywhere in it: absolute ones as given, relative ones against
 * `bases` (the folders the call is about: the threads it names, and its own absolute paths).
 */
export const pathsMentioned = (
  payload: unknown,
  bases: ReadonlyArray<string> = [],
): ReadonlyArray<string> => {
  const absolute: Array<string> = [];
  const relative: Array<string> = [];
  const take = (value: unknown) => {
    if (typeof value !== "string" || value === "" || value.length > 4096) return;
    (isAbsolute(value) ? absolute : relative).push(value);
  };
  const walk = (value: unknown, depth: number) => {
    if (depth > 4 || typeof value !== "object" || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 500)) walk(item, depth + 1);
      return;
    }
    for (const [key, field] of Object.entries(value)) {
      if (PATH_KEY.test(key)) {
        if (Array.isArray(field)) for (const item of field.slice(0, 500)) take(item);
        else take(field);
      }
      walk(field, depth + 1);
    }
  };
  walk(payload, 0);
  const against = [...bases, ...absolute];
  return [...absolute, ...relative.flatMap((path) => against.map((base) => resolve(base, path)))];
};

/**
 * `result` of a listing (`fs.list`, `fs.files`, a worktree list) with no entry inside a folder of a
 * thread `reader` may not see: each array's objects whose `path`, against `base` where relative,
 * lies there are left out. Unchanged while no thread is readable by one person.
 */
export const withoutUnreadable = (
  reader: Reader | undefined,
  result: unknown,
  base: string | undefined,
  level: Level = "act",
): unknown => {
  if (!anyPrivate()) return result;
  const folders = unreadableFolders(reader, level);
  if (folders.length === 0) return result;
  const bases = base === undefined ? [] : [resolve(base), realOf(base)];
  const hidden = (path: string): boolean => {
    const spellings = isAbsolute(path) ? [resolve(path)] : bases.map((each) => resolve(each, path));
    return spellings.some((spelling) => folders.some((folder) => within(spelling, folder)));
  };
  const scrub = (value: unknown, depth: number): unknown => {
    if (depth > 6 || typeof value !== "object" || value === null) return value;
    if (Array.isArray(value))
      return value
        .filter((item) => {
          const path = (item as { readonly path?: unknown } | null)?.path;
          return !(typeof path === "string" && hidden(path));
        })
        .map((item) => scrub(item, depth + 1));
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, scrub(field, depth + 1)]),
    );
  };
  return scrub(result, 0);
};
