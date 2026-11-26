import { errnoCode, fieldsOf } from "@gram/contracts";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { DatabaseSync as Database } from "node:sqlite";
import { tryRealPathSync } from "@gram/git";
import { setTimeout as sleep } from "node:timers/promises";

let sqlite: typeof Database | undefined;
const databaseSync = () =>
  (sqlite ??=
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `require` is untyped; node:sqlite is the module its declarations describe
    (createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof Database })
      .DatabaseSync);

/** What each lock guards: one supervisor at a time, and one move of the plan's phase at a time. */
export type LockPurpose = "supervisor" | "plan";

const FILES: Readonly<Record<LockPurpose, string>> = {
  supervisor: ".update-supervisor.lock",
  plan: ".update-plan.lock",
};

const folderOf = (
  home: string,
): { readonly path: string; readonly identity: string } | undefined => {
  const real = tryRealPathSync(home);
  if (real === undefined) return undefined;
  try {
    const stat = statSync(real);
    if (!stat.isDirectory()) return undefined;
    if (
      process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    )
      return undefined;
    return { path: real, identity: `${stat.dev}:${stat.ino}` };
  } catch {
    return undefined;
  }
};

/** Whether the update's locks can be taken in `home` at all: it is this user's own folder. */
export const lockableFolder = (home: string): boolean => folderOf(home) !== undefined;

const errstrOf = (error: unknown) => {
  const errstr = fieldsOf(error).get("errstr");
  return typeof errstr === "string" ? errstr : "";
};

const busy = (error: unknown) =>
  /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(
    `${errnoCode(error) ?? ""} ${errstrOf(error)} ${String(error)}`,
  );

const TAKE_WAIT_MS = 250;

const takeFileLock = (path: string, waitMs: number): Database | undefined => {
  let db: Database | undefined;
  try {
    db = new (databaseSync())(path, { timeout: waitMs });
    db.exec("PRAGMA journal_mode = MEMORY;");
    db.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
    return db;
  } catch (error) {
    try {
      db?.close();
    } catch (_alreadyClosed) {}
    if (busy(error)) return undefined;
    throw error;
  }
};

const FIRST_PORT = 20_000;
const PAIRS = 5_000;
const CONNECTION_MS = 1_000;
const LEGACY_MS = 1_000;

const digestOf = (identity: string) =>
  createHash("sha256").update(`gram-host-update\0${identity}`).digest();

const portOf = (identity: string, purpose: LockPurpose) =>
  FIRST_PORT + 2 * (digestOf(identity).readUInt32BE(0) % PAIRS) + (purpose === "plan" ? 1 : 0);

const greetingOf = (identity: string, purpose: LockPurpose) =>
  `gram-host-update-lock ${purpose} ${digestOf(identity).toString("hex").slice(0, 16)}\n`;

const bindLegacy = (
  identity: string,
  purpose: LockPurpose,
): Promise<(() => Promise<void>) | undefined> =>
  new Promise((done) => {
    const greeting = greetingOf(identity, purpose);
    const open = new Set<Socket>();
    const server: Server = createServer((socket) => {
      open.add(socket);
      socket.on("close", () => open.delete(socket));
      socket.on("error", () => undefined);
      socket.setTimeout(CONNECTION_MS, () => socket.destroy());
      socket.end(greeting, () => socket.destroy());
    });
    server.once("error", () => done(undefined));
    server.listen({ host: "127.0.0.1", port: portOf(identity, purpose) }, () => {
      server.unref();
      done(
        () =>
          new Promise<void>((closed) => {
            server.close(() => closed());
            for (const socket of open) socket.destroy();
          }),
      );
    });
  });

/** The old port for `purpose` in `home`, or undefined when no lock can be taken there. */
export const legacyLockPort = (home: string, purpose: LockPurpose): number | undefined => {
  const folder = folderOf(home);
  return folder === undefined ? undefined : portOf(folder.identity, purpose);
};

const legacyHeld = (identity: string, purpose: LockPurpose): Promise<boolean> =>
  new Promise((done) => {
    const greeting = greetingOf(identity, purpose);
    const socket = connect({ host: "127.0.0.1", port: portOf(identity, purpose) });
    let said = "";
    let settled = false;
    const finish = (held: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(held);
    };
    const timer = setTimeout(() => finish(false), 2_000);
    socket.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
      if (said.length >= greeting.length) finish(said.startsWith(greeting));
    });
    socket.on("end", () => finish(said === greeting));
    socket.on("error", () => finish(false));
  });

const takeLegacy = async (identity: string, purpose: LockPurpose) => {
  const until = Date.now() + LEGACY_MS;
  for (;;) {
    const release = await bindLegacy(identity, purpose);
    if (release !== undefined || Date.now() >= until) return release;
    await sleep(20);
  }
};

const held = new Set<Database>();

/** A lock this process holds, until it releases it or ends. */
export interface HeldLock {
  readonly release: () => Promise<void>;
}

/**
 * Takes the lock, or answers undefined while any process holds it or the folder isn't this user's
 * own. Waits only out a moment's probe (`TAKE_WAIT_MS`) and never takes a lock over.
 */
export const takeUpdateLock = async (
  home: string,
  purpose: LockPurpose,
): Promise<HeldLock | undefined> => {
  const folder = folderOf(home);
  if (folder === undefined) return undefined;
  const db = takeFileLock(join(folder.path, FILES[purpose]), TAKE_WAIT_MS);
  if (db === undefined) return undefined;
  held.add(db);
  const legacy = await takeLegacy(folder.identity, purpose);
  let released: Promise<void> | undefined;
  return {
    release: () =>
      (released ??= (async () => {
        held.delete(db);
        try {
          db.close();
        } finally {
          await legacy?.();
        }
      })()),
  };
};

/**
 * Whether the lock is held now: `held` when a process holds it (an old release's included),
 * `free` when none does, `unusable` when the folder isn't this user's own, so no lock can be
 * taken there.
 */
export const updateLockState = async (
  home: string,
  purpose: LockPurpose,
): Promise<"held" | "free" | "unusable"> => {
  const folder = folderOf(home);
  if (folder === undefined) return "unusable";
  const db = takeFileLock(join(folder.path, FILES[purpose]), 0);
  if (db === undefined) return "held";
  db.close();
  return (await legacyHeld(folder.identity, purpose)) ? "held" : "free";
};

/**
 * Why an update can't take the locks it needs here, or undefined when it can: the folder must be
 * this user's own and the supervisor's lock free. Asked before anything changes.
 */
export const lockConflict = async (home: string): Promise<string | undefined> => {
  const supervisor = await updateLockState(home, "supervisor");
  if (supervisor === "unusable")
    return "gram-host's folder must be its own user's alone (mode 700) to lock an update.";
  if (supervisor === "held") return "An update's supervisor is still running.";
  return undefined;
};
