import * as fs from "node:fs/promises";
import type { Dir, Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  CREDENTIAL_FOLDERS_IN_HOME,
  errnoCode,
  type FolderEntry,
  type FolderListing,
  HostFailed,
  type HostFolderChecked,
  InvalidState,
  isCredentialFolder,
  type NotFound,
} from "@gram/contracts";
import { git, Proc, type ProcShape, realPath } from "@gram/git";
import * as Effect from "effect/Effect";
import { expandHome, folderError } from "../fs/folders.ts";
import { hostHome, hostRepos } from "./host-config.ts";
import type { HostSessionsService } from "./sessions.ts";

/**
 * A machine's folders for a one-off thread the user places there: listed for the picker and
 * checked before a session starts in one. Everything here runs on the machine itself, its paths its
 * own, so `~` is its home.
 */
export interface HostFolders {
  /** Folders as `fs.browse` lists them, without the ones a thread may never run in. */
  readonly browse: (
    input: string,
    limit: number,
  ) => Effect.Effect<FolderListing, NotFound | InvalidState>;
  /** The folder a thread may run in, links resolved, or why it may not. */
  readonly check: (path: string) => Effect.Effect<HostFolderChecked, NotFound | InvalidState>;
}

/** Where the folders no thread may run in are, on the machine, as it is configured. */
export interface FolderBounds {
  readonly home: string;
  /** The host's own folder: its key, its config, its token and its attachments. */
  readonly hostHome: string;
  /** The clones the host keeps, whose worktrees its workers' sessions run in. */
  readonly hostRepos: string;
  /** Where the agents keep their logins when configured elsewhere (`CLAUDE_CONFIG_DIR`, …). */
  readonly agentHomes: ReadonlyArray<string>;
}

/** The bounds of the machine this runs on, read from its environment. */
export const boundsHere = (
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): FolderBounds => ({
  home,
  hostHome: hostHome(env, home),
  hostRepos: hostRepos(env, home),
  agentHomes: [env["CLAUDE_CONFIG_DIR"], env["CODEX_HOME"]].flatMap((set) =>
    set !== undefined && set !== "" ? [resolve(expandHome(set, home))] : [],
  ),
});

/** The filesystem calls the gate and the listing make; a test can slow one down. */
export interface FolderIo {
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<Stats>;
  readonly opendir: (path: string) => Promise<Dir>;
}

const NODE_IO: FolderIo = {
  realpath: realPath,
  stat: (path) => fs.stat(path),
  opendir: (path) => fs.opendir(path),
};

/** At most this many folders in one listing, whatever the caller asks for. */
export const MAX_LISTED = 500;
/** At most this many entries of one folder are read for a listing; the rest are left unread. */
export const MAX_SCANNED = 5_000;
/** How long a listing, a check or a gate may take before it is given up, a mount stuck say. */
export const FOLDER_DEADLINE = "10 seconds";
const PROBE_DEADLINE = "2 seconds";
const PROBES = 8;

type Use = "browse" | "run" | "session";

interface Protected {
  readonly id: string;
  readonly kind: "credentials" | "own" | "clones";
}

const identity = (info: Stats) => `${info.dev}:${info.ino}`;

const STRICTNESS: Readonly<Record<Protected["kind"], number>> = {
  clones: 0,
  own: 1,
  credentials: 2,
};

const absent = (error: unknown) => {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
};

const credentials = (path: string) =>
  `Gram doesn't run a chat in ${path}: it holds keys or credentials.`;
const own = (path: string) => `Gram doesn't run a chat in ${path}: it is Gram Host's own folder.`;
const WHOLE = "Gram doesn't run a chat in the whole filesystem.";

/** What a call says to a machine whose host is from a build before the call was. */
export const olderHost = (machine: { readonly name: string }) =>
  `gram-host on ${machine.name} is older than this Gram; update it (Settings → Machines, or rerun its install command there).`;

const refused = (message: string) => new InvalidState({ message });

const attempt = <A>(path: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => folderError(error, path) });

const probe = (io: FolderIo, path: string) =>
  Effect.tryPromise(() => io.stat(path)).pipe(Effect.timeout(PROBE_DEADLINE), Effect.option);

/** A folder the gate let through: where it really is, and which folder that is. */
export interface Admitted {
  readonly path: string;
  readonly id: string;
  readonly info: Stats;
}

/**
 * The one gate every use of a folder on the machine goes through: a listing, a check, and every
 * session that opens there. It resolves the folder's real path, then refuses it when its name or
 * any of its parents' names is a credential folder's, or when it or any parent is, by device and
 * inode, the real folder of a credential folder, an agent's login folder or Gram Host's own. Those
 * are resolved on the machine at each use, so neither a link, a parent's link, another spelling of
 * a name (case, Unicode form) nor a credential folder moved elsewhere behind a link gets through.
 * A protected folder whose identity can't be read (its parent unreadable, an I/O error) refuses,
 * rather than protecting nothing; only one that isn't there protects nothing.
 *
 * It is a guard against a mistake, not a sandbox: a session there runs as the machine's user and
 * can read whatever that user can, from any folder. Who may list folders and open sessions on the
 * host (the main Gram over its signed connection) is the boundary; this keeps a chat from being
 * started in, or a picker from listing, a folder that is plainly no place for one.
 *
 * A worker's session in a worktree of the host's clones is the one use of Gram Host's folder let
 * through: that is where the host makes them. Where a session runs grants it nothing: a worktree's
 * ownership comes only from what the main Gram recorded as it made it (`checkWorkerPr`).
 */
export const folderGate = (bounds: FolderBounds, io: FolderIo = NODE_IO) => {
  const protectedNow = Effect.forEach(
    [
      ...CREDENTIAL_FOLDERS_IN_HOME.map((parts) => ({
        path: join(bounds.home, ...parts),
        kind: "credentials" as const,
      })),
      ...bounds.agentHomes.map((path) => ({ path, kind: "credentials" as const })),
      { path: bounds.hostHome, kind: "own" as const },
      { path: bounds.hostRepos, kind: "clones" as const },
    ],
    ({ path, kind }) =>
      Effect.tryPromise({ try: () => io.stat(path), catch: (error) => error }).pipe(
        Effect.map((info): ReadonlyArray<Protected> => [{ id: identity(info), kind }]),
        Effect.catch((error) =>
          absent(error)
            ? Effect.succeed<ReadonlyArray<Protected>>([])
            : Effect.fail(
                refused(
                  `Gram couldn't read ${path} on this machine, so it can't tell whether this folder is one it keeps chats out of.`,
                ),
              ),
        ),
      ),
    { concurrency: 8 },
  ).pipe(Effect.map((found) => found.flat()));

  const guardedNow = Effect.map(protectedNow, (found) => {
    const kinds = new Map<string, Protected["kind"]>();
    for (const folder of found) {
      const before = kinds.get(folder.id);
      if (before === undefined || STRICTNESS[folder.kind] > STRICTNESS[before])
        kinds.set(folder.id, folder.kind);
    }
    return kinds;
  });

  const admit = (
    input: string,
    use: Use,
    known?: ReadonlyMap<string, Protected["kind"]>,
  ): Effect.Effect<Admitted, NotFound | InvalidState> =>
    Effect.gen(function* () {
      const typed = resolve(bounds.home, expandHome(input.trim(), bounds.home));
      if (isCredentialFolder(typed)) return yield* refused(credentials(typed));
      const real = yield* attempt(typed, () => io.realpath(typed));
      if (isCredentialFolder(real)) return yield* refused(credentials(real));
      if (use !== "browse" && dirname(real) === real) return yield* refused(WHOLE);
      const kinds = known ?? (yield* guardedNow);
      let info: Stats | undefined;
      let inClones = false;
      for (let at = real; ; at = dirname(at)) {
        const here = yield* attempt(at, () => io.stat(at));
        info ??= here;
        const kind = kinds.get(identity(here));
        if (kind === "credentials") return yield* refused(credentials(real));
        if (kind === "clones") {
          if (use !== "session") return yield* refused(own(real));
          inClones = true;
        }
        if (kind === "own" && !inClones) return yield* refused(own(real));
        if (dirname(at) === at) break;
      }
      if (!info.isDirectory()) return yield* refused(`Not a folder: ${real}`);
      return { path: real, id: identity(info), info };
    }).pipe(
      Effect.timeoutOrElse({
        duration: FOLDER_DEADLINE,
        orElse: () => Effect.fail(refused(`${input} took too long to read on this machine.`)),
      }),
    );

  return { admit, guardedNow };
};

export type FolderGate = ReturnType<typeof folderGate>;

const browseOn = (
  gate: FolderGate,
  io: FolderIo,
  input: string,
  limit: number,
): Effect.Effect<FolderListing, NotFound | InvalidState> =>
  Effect.gen(function* () {
    const listed = Math.max(1, Math.min(limit, MAX_LISTED));
    const trimmed = input.trim() === "" ? "~/" : input.trim();
    const whole = trimmed === "~" || trimmed.endsWith("/") || trimmed.endsWith(sep);
    const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(sep));
    const listedIn = whole ? trimmed : cut >= 0 ? trimmed.slice(0, cut + 1) : "~/";
    const prefix = whole ? "" : trimmed.slice(cut + 1).toLowerCase();
    const guarded = yield* gate.guardedNow;
    const { path: folder } = yield* gate.admit(listedIn, "browse", guarded);

    const names: Array<string> = [];
    let scanned = 0;
    const dir = yield* Effect.tryPromise({
      try: () => io.opendir(folder),
      catch: (error) => folderError(error, folder),
    });
    yield* Effect.tryPromise({
      try: async () => {
        try {
          for await (const entry of dir) {
            if (++scanned > MAX_SCANNED) break;
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith(".") && !prefix.startsWith(".")) continue;
            if (entry.name.toLowerCase().startsWith(prefix)) names.push(entry.name);
          }
        } finally {
          await dir.close().catch(() => undefined);
        }
      },
      catch: (error) => folderError(error, folder),
    });
    const sorted = names.toSorted((a, b) => a.localeCompare(b));
    const shown = sorted.slice(0, listed);

    const entries = yield* Effect.forEach(
      shown,
      (name) =>
        Effect.gen(function* () {
          const path = join(folder, name);
          if (isCredentialFolder(path)) return [];
          const itself = yield* probe(io, path);
          if (itself._tag === "None" || guarded.has(identity(itself.value))) return [];
          const dotGit = yield* probe(io, join(path, ".git"));
          return [{ name, path, isGitRepo: dotGit._tag === "Some" }] satisfies Array<FolderEntry>;
        }),
      { concurrency: PROBES },
    );
    const gitHere = yield* probe(io, join(folder, ".git"));
    const parent = dirname(folder);
    return {
      path: folder,
      ...(parent === folder ? {} : { parent }),
      ...(gitHere._tag === "Some"
        ? { git: gitHere.value.isDirectory() ? ("repository" as const) : ("linked" as const) }
        : {}),
      entries: entries.flat(),
      truncated: scanned > MAX_SCANNED || sorted.length > listed,
    };
  }).pipe(
    Effect.timeoutOrElse({
      duration: FOLDER_DEADLINE,
      orElse: () => Effect.fail(refused(`${input} took too long to list on this machine.`)),
    }),
  );

/** The folders of the machine this runs on, every use through its gate. */
export const foldersOn = (
  proc: ProcShape,
  bounds: FolderBounds = boundsHere(),
  io: FolderIo = NODE_IO,
): HostFolders & { readonly gate: FolderGate } => {
  const gate = folderGate(bounds, io);
  return {
    gate,
    browse: (input, limit) => browseOn(gate, io, input, limit),
    check: (path) =>
      Effect.gen(function* () {
        const { path: real } = yield* gate.admit(path, "run");
        const branch = yield* git(real, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.map((out) => {
            const name = out.stdout.trim();
            return out.status === 0 && name !== "" && name !== "HEAD" ? name : undefined;
          }),
          Effect.orElseSucceed(() => undefined),
          Effect.provideService(Proc, proc),
        );
        return { path: real, ...(branch === undefined ? {} : { branch }) };
      }),
  };
};

/**
 * A joined machine's sessions, each opened only in a folder its gate lets through, checked every
 * time it opens (a restart opens it again, and is checked again). A guard against a mistake, as
 * the gate is: a folder swapped under a running check isn't chased, since the session could read
 * that folder from anywhere anyway.
 */
export const gatedSessions = (
  sessions: HostSessionsService,
  gate: FolderGate,
): HostSessionsService => ({
  ...sessions,
  open: (request) =>
    request.dreamFilesOnly === true
      ? sessions.open(request)
      : gate.admit(request.cwd, "session").pipe(
          Effect.mapError((error) => new HostFailed({ message: error.message })),
          Effect.andThen(sessions.open(request)),
        ),
});
