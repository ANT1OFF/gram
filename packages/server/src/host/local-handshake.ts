// How the host kept running after Gram quits and the app prove themselves to each other before a
// byte of the host protocol crosses its socket. The socket's folder is this user's alone, but any
// process of this user could still connect to it, and the connection that is served answers the
// agents' approvals and sets their permission modes. So each side proves it holds the install's
// secret, a file in Gram's data folder only this user can read, which the app made and the host is
// pointed at: the host by an HMAC over a nonce it chose, then the app by one over the app's.
// Neither sends the secret. A connection that doesn't prove itself is closed before it is served,
// and never displaces the app that is.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { dirname } from "node:path";

/** How long either side waits for the other's line before it closes the connection. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** The longest handshake line either side reads. */
const LINE_MAX = 1_024;

const HEX = /^[0-9a-f]{64}$/;

const proof = (secret: string, role: "app" | "host", nonce: string) =>
  createHmac("sha256", secret).update(`gram-local-host:${role}:${nonce}`).digest("hex");

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The install's secret in `file`, made now (32 random bytes, hex) when there is none. Readable by
 * this user alone, in a folder only they can open.
 */
export const ensureLocalSecret = (file: string): string => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    const kept = readFileSync(file, "utf8").trim();
    if (HEX.test(kept)) {
      chmodSync(file, 0o600);
      return kept;
    }
  } catch {
    // None yet.
  }
  const made = randomBytes(32).toString("hex");
  writeFileSync(file, `${made}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return made;
};

/** The secret in `file`, or undefined when it is missing or isn't one. */
export const readLocalSecret = (file: string): string | undefined => {
  try {
    const kept = readFileSync(file, "utf8").trim();
    return HEX.test(kept) ? kept : undefined;
  } catch {
    return undefined;
  }
};

/**
 * One line of JSON from `socket`, the rest of what arrived handed back to the stream. Rejects on a
 * close, an error, a line too long or the timeout.
 */
const readLine = (socket: Socket, timeoutMs: number): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const done = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(0x0a);
      if (end === -1) {
        if (buffered.length > LINE_MAX) done(new Error("handshake line too long"));
        return;
      }
      const rest = buffered.subarray(end + 1);
      socket.pause();
      if (rest.length > 0) socket.unshift(rest);
      try {
        const value: unknown = JSON.parse(buffered.subarray(0, end).toString("utf8"));
        if (typeof value !== "object" || value === null) throw new Error("not an object");
        done(undefined, value as Record<string, unknown>);
      } catch {
        done(new Error("handshake line isn't JSON"));
      }
    };
    const onClose = () => done(new Error("closed during the handshake"));
    const onError = (error: Error) => done(error);
    const timer = setTimeout(() => done(new Error("handshake timed out")), timeoutMs);
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
    socket.resume();
  });

const send = (socket: Socket, value: Record<string, unknown>) =>
  socket.write(`${JSON.stringify(value)}\n`);

/**
 * The host's side: true once the app on `socket` proved it holds `secret`, which the host then
 * proves back. False (the socket left to the caller to close) for anyone else.
 */
export const admitApp = async (
  socket: Socket,
  secret: string | undefined,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
): Promise<boolean> => {
  if (secret === undefined) return false;
  const nonce = randomBytes(32).toString("hex");
  send(socket, { gramLocalHost: 1, nonce });
  try {
    const answer = await readLine(socket, timeoutMs);
    const given = answer["proof"];
    const theirs = answer["nonce"];
    if (typeof given !== "string" || typeof theirs !== "string" || !HEX.test(theirs)) return false;
    if (!same(given, proof(secret, "app", nonce))) return false;
    send(socket, { proof: proof(secret, "host", theirs) });
    return true;
  } catch {
    return false;
  }
};

/**
 * The app's side: resolves once it proved itself to the host on `socket` and the host proved
 * itself back; rejects otherwise, so the app never serves a host that doesn't hold the secret.
 */
export const proveToHost = async (
  socket: Socket,
  secret: string,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
): Promise<void> => {
  const hello = await readLine(socket, timeoutMs);
  const theirs = hello["nonce"];
  if (hello["gramLocalHost"] !== 1 || typeof theirs !== "string" || !HEX.test(theirs))
    throw new Error("The socket isn't a kept-running host's.");
  const nonce = randomBytes(32).toString("hex");
  send(socket, { proof: proof(secret, "app", theirs), nonce });
  const back = await readLine(socket, timeoutMs);
  const given = back["proof"];
  if (typeof given !== "string" || !same(given, proof(secret, "host", nonce)))
    throw new Error("The kept-running host didn't prove it holds this install's secret.");
};
