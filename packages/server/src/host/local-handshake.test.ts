import { createHmac, randomBytes } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { macFramed } from "./local-handshake.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Two connected sockets: `a` and `b`. */
const pair = () =>
  new Promise<{ a: Socket; b: Socket }>((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "gram-frames-"));
    dirs.push(dir);
    const path = join(dir, "s");
    const server = createServer((b) => {
      server.close();
      resolve({ a, b });
    });
    let a: Socket;
    server.listen(path, () => {
      a = createConnection(path);
    });
  });

/** A frame as `from` would send it under `key`, numbered `seq`. */
const frame = (key: Buffer, from: "app" | "host", seq: bigint, payload: Buffer) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(payload.length);
  const n = Buffer.alloc(8);
  n.writeBigUInt64BE(seq);
  const mac = createHmac("sha256", key).update(from).update(n).update(payload).digest();
  return Buffer.concat([head, mac, payload]);
};

const closedWith = (stream: NodeJS.EventEmitter) =>
  new Promise<string>((resolve) => {
    stream.once("error", (error: Error) => resolve(error.message));
    stream.once("close", () => resolve("closed"));
  });

describe("frames after the handshake", () => {
  it("carry what was written, both ways", async () => {
    const key = randomBytes(32);
    const { a, b } = await pair();
    const app = macFramed(a, key, "app");
    const host = macFramed(b, key, "host");
    const heard = new Promise<string>((resolve) => host.once("data", (d) => resolve(String(d))));
    app.write('{"_tag":"Request"}\n');
    expect(await heard).toBe('{"_tag":"Request"}\n');
    const back = new Promise<string>((resolve) => app.once("data", (d) => resolve(String(d))));
    host.write("ok\n");
    expect(await back).toBe("ok\n");
    app.destroy();
    host.destroy();
  });

  it.each([
    [
      "unframed bytes, as a relay injects them",
      (_key: Buffer) => Buffer.from('{"_tag":"Request","tag":"host.sessions.respond"}\n'),
    ],
    ["a frame under another key", () => frame(randomBytes(32), "app", 0n, Buffer.from("x\n"))],
    [
      "a frame sent back the other way",
      (key: Buffer) => frame(key, "host", 0n, Buffer.from("x\n")),
    ],
    ["a frame out of sequence", (key: Buffer) => frame(key, "app", 5n, Buffer.from("x\n"))],
  ])("refuse %s, and close the connection unread", async (_name, make) => {
    const key = randomBytes(32);
    const { a, b } = await pair();
    const host = macFramed(b, key, "host");
    const read: Array<string> = [];
    host.on("data", (d) => read.push(String(d)));
    const ended = closedWith(host);
    a.write(make(key));
    expect(await ended).not.toBe("");
    expect(read).toEqual([]);
    a.destroy();
  });

  it("refuse a frame replayed after the one it copied", async () => {
    const key = randomBytes(32);
    const { a, b } = await pair();
    const host = macFramed(b, key, "host");
    const read: Array<string> = [];
    host.on("data", (d) => read.push(String(d)));
    const ended = closedWith(host);
    const first = frame(key, "app", 0n, Buffer.from("approve\n"));
    a.write(Buffer.concat([first, first]));
    await ended;
    expect(read).toEqual(["approve\n"]);
    a.destroy();
  });
});
