/**
 * The locks a machine's self-update takes, held by the kernel: a listening socket on a loopback
 * port of the host's own. Only one process can bind it, and it is free again the moment its holder
 * ends, however it ends, so there is never a stale lock to take over: nothing here deletes or
 * replaces a lock someone else holds. (A Unix socket's file outlives its holder, and clearing it
 * would bring back exactly that, so it is a port.)
 *
 * The ports are a pair drawn from a hash of the host folder's physical identity (its device and
 * inode), one per purpose, between 20000 and 29999: below Linux's and macOS's default ephemeral
 * ranges, which a machine can configure otherwise. Whoever holds one answers a connection with a greeting naming the lock,
 * so a port another program happens to use is told apart from a lock that is held.
 */

import { createHash } from "node:crypto";
import { connect, createServer, type Server, type Socket } from "node:net";
import { statSync } from "node:fs";
import { tryRealPathSync } from "@gram/git";

/** What each lock guards: one supervisor at a time, and one move of the plan's phase at a time. */
export type LockPurpose = "supervisor" | "plan";

const FIRST_PORT = 20_000;
/** Pairs of ports: a host folder's supervisor lock and its plan lock, side by side. */
const PAIRS = 5_000;
/** How long a connection to a lock may stay open: long enough to read the greeting. */
const CONNECTION_MS = 1_000;

/**
 * The host folder's physical identity: the device and inode of the folder every link in its path
 * leads to. Two spellings of one folder (a link in its path, a trailing slash, another case on a
 * Mac) are the same folder, and so the same lock. Undefined when it can't be read; then no lock is
 * taken, and nothing that needs one runs.
 */
const identityOf = (home: string): string | undefined => {
  const real = tryRealPathSync(home);
  if (real === undefined) return undefined;
  try {
    const stat = statSync(real);
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : undefined;
  } catch {
    return undefined;
  }
};

const digestOf = (identity: string) =>
  createHash("sha256").update(`gram-host-update\0${identity}`).digest();

const portOf = (identity: string, purpose: LockPurpose) =>
  FIRST_PORT + 2 * (digestOf(identity).readUInt32BE(0) % PAIRS) + (purpose === "plan" ? 1 : 0);

/**
 * The loopback port the lock for `purpose` in the host folder `home` is held on, or undefined when
 * the folder can't be identified. A folder's two locks are always on two ports side by side.
 */
export const lockPort = (home: string, purpose: LockPurpose): number | undefined => {
  const identity = identityOf(home);
  return identity === undefined ? undefined : portOf(identity, purpose);
};

const greetingOf = (identity: string, purpose: LockPurpose) =>
  `gram-host-update-lock ${purpose} ${digestOf(identity).toString("hex").slice(0, 16)}\n`;

/** A lock this process holds, until it releases it or ends. */
export interface HeldLock {
  readonly release: () => Promise<void>;
}

/**
 * Takes the lock, or answers undefined while any process holds it, another program holds its
 * port, or the folder can't be identified. Never waits and never takes a lock over. A connection
 * to it gets the greeting and is closed within `CONNECTION_MS`, whatever the peer does, so no peer
 * can hold up its release.
 */
export const takeUpdateLock = (home: string, purpose: LockPurpose): Promise<HeldLock | undefined> =>
  new Promise((done) => {
    const identity = identityOf(home);
    if (identity === undefined) return done(undefined);
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
      // Held for as long as this process wants it, without keeping the process alive for it.
      server.unref();
      let released: Promise<void> | undefined;
      done({
        release: () =>
          (released ??= new Promise<void>((closed) => {
            server.close(() => closed());
            for (const socket of open) socket.destroy();
          })),
      });
    });
  });

/**
 * Whether the lock is held now: `held` when its holder answers with its greeting, `foreign` when
 * something else answers on its port (or the folder can't be identified), `free` when nothing
 * does.
 */
export const updateLockState = (
  home: string,
  purpose: LockPurpose,
): Promise<"held" | "foreign" | "free"> =>
  new Promise((done) => {
    const identity = identityOf(home);
    if (identity === undefined) return done("foreign");
    const greeting = greetingOf(identity, purpose);
    const socket = connect({ host: "127.0.0.1", port: portOf(identity, purpose) });
    let said = "";
    let settled = false;
    const finish = (state: "held" | "foreign" | "free") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(state);
    };
    const timer = setTimeout(() => finish("foreign"), 2_000);
    socket.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
      if (said.length >= greeting.length) finish(said.startsWith(greeting) ? "held" : "foreign");
    });
    socket.on("end", () => finish(said === greeting ? "held" : "foreign"));
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" ? "free" : "foreign"),
    );
  });

/**
 * Why an update can't take the locks it needs here, or undefined when it can: the supervisor's
 * must be free, and the plan's free or held by this folder's own update for a moment. Asked before
 * anything changes, so a port another program holds refuses the update rather than stranding it.
 */
export const lockConflict = async (home: string): Promise<string | undefined> => {
  if (identityOf(home) === undefined)
    return "gram-host can't identify its own folder, so it can't lock an update.";
  const supervisor = await updateLockState(home, "supervisor");
  if (supervisor === "held") return "An update's supervisor is still running.";
  const plan = await updateLockState(home, "plan");
  for (const [purpose, state] of [
    ["supervisor", supervisor],
    ["plan", plan],
  ] as const)
    if (state === "foreign")
      return `Another program uses port ${lockPort(home, purpose)} on this machine, which gram-host's update needs to lock its ${purpose === "plan" ? "plan" : "supervisor"}.`;
  return undefined;
};
