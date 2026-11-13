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
import { Duplex } from "node:stream";
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
): Promise<Buffer | undefined> => {
  if (secret === undefined) return undefined;
  const nonce = randomBytes(32).toString("hex");
  send(socket, { gramLocalHost: 1, nonce });
  try {
    const answer = await readLine(socket, timeoutMs);
    const given = answer["proof"];
    const theirs = answer["nonce"];
    if (typeof given !== "string" || typeof theirs !== "string" || !HEX.test(theirs))
      return undefined;
    if (!same(given, proof(secret, "app", nonce))) return undefined;
    send(socket, { proof: proof(secret, "host", theirs) });
    return connectionKey(secret, nonce, theirs);
  } catch {
    return undefined;
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
): Promise<Buffer> => {
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
  return connectionKey(secret, theirs, nonce);
};

/**
 * The key of one connection: from the secret and both sides' nonces, so it is new each time and
 * known only to the two that proved themselves. Every frame after the handshake carries a MAC
 * under it (`macFramed`), so a process relaying the handshake can't add one of its own.
 */
const connectionKey = (secret: string, hostNonce: string, appNonce: string): Buffer =>
  createHmac("sha256", secret).update(`gram-local-host:conn:${hostNonce}:${appNonce}`).digest();

/** The most bytes one frame may carry. */
const FRAME_MAX = 32 * 1024 * 1024;
const MAC_BYTES = 32;

const frameMac = (key: Buffer, from: "app" | "host", seq: bigint, payload: Buffer) => {
  const header = Buffer.alloc(8);
  header.writeBigUInt64BE(seq);
  return createHmac("sha256", key).update(from).update(header).update(payload).digest();
};

/**
 * `raw` after a handshake, as a stream whose every chunk crosses as a frame: its length, a MAC over
 * who sent it, its number in that direction and its bytes, then the bytes. A frame whose MAC
 * doesn't hold (forged, altered, replayed, reordered, or sent back the other way) closes the
 * connection before any of it is read.
 */
export const macFramed = (raw: Socket, key: Buffer, role: "app" | "host"): Duplex => {
  const theirs = role === "app" ? "host" : "app";
  let sent = 0n;
  let received = 0n;
  let buffered = Buffer.alloc(0);
  const framed: Duplex = new Duplex({
    read() {
      raw.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const head = Buffer.alloc(4);
      head.writeUInt32BE(payload.length);
      raw.write(Buffer.concat([head, frameMac(key, role, sent++, payload), payload]), callback);
    },
    final(callback) {
      raw.end();
      callback();
    },
    destroy(error, callback) {
      raw.destroy();
      callback(error);
    },
  });
  raw.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4 + MAC_BYTES) {
      const length = buffered.readUInt32BE(0);
      if (length > FRAME_MAX) {
        framed.destroy(new Error("a frame too large"));
        return;
      }
      if (buffered.length < 4 + MAC_BYTES + length) break;
      const mac = buffered.subarray(4, 4 + MAC_BYTES);
      const payload = Buffer.from(buffered.subarray(4 + MAC_BYTES, 4 + MAC_BYTES + length));
      buffered = buffered.subarray(4 + MAC_BYTES + length);
      if (!timingSafeEqual(mac, frameMac(key, theirs, received, payload))) {
        framed.destroy(new Error("a frame that doesn't carry this connection's MAC"));
        return;
      }
      received += 1n;
      if (!framed.push(payload)) raw.pause();
    }
  });
  raw.on("end", () => framed.push(null));
  raw.on("close", () => {
    if (!framed.destroyed) framed.destroy();
  });
  raw.on("error", (error) => framed.destroy(error));
  return framed;
};
