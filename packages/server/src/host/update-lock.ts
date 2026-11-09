/**
 * The locks a machine's self-update takes, held by the kernel: a listening socket on a loopback
 * port of the host's own. Only one process can bind it, and it is free again the moment its holder
 * ends, however it ends, so there is never a stale lock to take over: nothing here deletes or
 * replaces a lock someone else holds. (A Unix socket's file outlives its holder, and clearing it
 * would bring back exactly that, so it is a port.)
 *
 * The port is drawn from a hash of the host's folder and the lock's purpose, below the ephemeral
 * ranges of Linux and macOS. Whoever holds it answers a connection with a greeting naming the lock,
 * so a port another program happens to use is told apart from a lock that is held.
 */

import { createHash } from "node:crypto";
import { connect, createServer, type Server } from "node:net";
import { resolve } from "node:path";

/** What each lock guards: one supervisor at a time, and one move of the plan's phase at a time. */
export type LockPurpose = "supervisor" | "plan";

const FIRST_PORT = 20_000;
const PORTS = 10_000;

const digestOf = (home: string, purpose: LockPurpose) =>
  createHash("sha256")
    .update(`gram-host-update\0${resolve(home)}\0${purpose}`)
    .digest();

/** The loopback port the lock for `purpose` in the host folder `home` is held on. */
export const lockPort = (home: string, purpose: LockPurpose): number =>
  FIRST_PORT + (digestOf(home, purpose).readUInt32BE(0) % PORTS);

const greetingOf = (home: string, purpose: LockPurpose) =>
  `gram-host-update-lock ${purpose} ${digestOf(home, purpose).toString("hex").slice(0, 16)}\n`;

/** A lock this process holds, until it releases it or ends. */
export interface HeldLock {
  readonly release: () => Promise<void>;
}

/**
 * Takes the lock, or answers undefined while any process holds it (or another program holds its
 * port). Never waits and never takes a lock over.
 */
export const takeUpdateLock = (home: string, purpose: LockPurpose): Promise<HeldLock | undefined> =>
  new Promise((done) => {
    const greeting = greetingOf(home, purpose);
    const server: Server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.end(greeting);
    });
    server.once("error", () => done(undefined));
    server.listen({ host: "127.0.0.1", port: lockPort(home, purpose) }, () => {
      // Held for as long as this process wants it, without keeping the process alive for it.
      server.unref();
      let released: Promise<void> | undefined;
      done({
        release: () =>
          (released ??= new Promise<void>((closed) => {
            server.close(() => closed());
          })),
      });
    });
  });

/**
 * Whether the lock is held now: `held` when its holder answers with its greeting, `foreign` when
 * something else answers on its port, `free` when nothing does.
 */
export const updateLockState = (
  home: string,
  purpose: LockPurpose,
): Promise<"held" | "foreign" | "free"> =>
  new Promise((done) => {
    const greeting = greetingOf(home, purpose);
    const socket = connect({ host: "127.0.0.1", port: lockPort(home, purpose) });
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
