import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteAccess, remoteCookieName, SESSION_LIFETIME_MS } from "./remote-access.ts";
import { fileRemoteSessionStore } from "./remote-sessions.ts";

const origin = "https://device.tail123.ts.net:9443";
const port = 4321;
const request = {
  method: "POST",
  url: "/remote/claim",
  headers: { host: new URL(origin).host, origin },
  cookies: {},
};
const directories: string[] = [];
const directory = () => {
  const value = mkdtempSync(join(tmpdir(), "gram-remote-sessions-"));
  directories.push(value);
  return value;
};
const pair = (access: ReturnType<typeof createRemoteAccess>) =>
  access.claim(
    request,
    new URLSearchParams(new URL(access.mint().url).hash.slice(1)).get("pair")!,
  )!;
const authorized = (access: ReturnType<typeof createRemoteAccess>, token: string) =>
  access.authorize({
    ...request,
    method: "GET",
    url: "/t/invented",
    cookies: { [remoteCookieName(port)]: token },
  });
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("durable remote pairing", () => {
  it("keeps paired browsers across reconstruction, persists only hashes, and revokes across restarts", () => {
    const dataDir = directory();
    const store = () => fileRemoteSessionStore(dataDir, origin, port);
    const first = createRemoteAccess(origin, port, Date.now, store());
    const token = pair(first);
    const file = join(dataDir, "remote-access", readdirSync(join(dataDir, "remote-access"))[0]!);
    expect(readFileSync(file, "utf8")).not.toContain(token);
    const restarted = createRemoteAccess(origin, port, Date.now, store());
    expect(authorized(restarted, token)).toEqual({ kind: "pass" });
    const invitation = new URLSearchParams(new URL(restarted.mint().url).hash.slice(1)).get(
      "pair",
    )!;
    // Offline reset is performed only after the owning server stops, closing its sockets.
    rmSync(join(dataDir, "remote-access"), { recursive: true });
    const reset = createRemoteAccess(origin, port, Date.now, store());
    expect(authorized(reset, token)).toMatchObject({ status: 401 });
    expect(reset.claim(request, invitation)).toBeUndefined();
    expect(authorized(createRemoteAccess(origin, port, Date.now, store()), token)).toMatchObject({
      status: 401,
    });
  });

  it("does not persist invitations, binds sessions to origin and port, expires and frees capacity", () => {
    let now = 1_000;
    const dataDir = directory();
    const store = () => fileRemoteSessionStore(dataDir, origin, port);
    const first = createRemoteAccess(origin, port, () => now, store());
    const tokens = Array.from({ length: 8 }, () => pair(first));
    const invitation = new URLSearchParams(new URL(first.mint().url).hash.slice(1)).get("pair")!;
    const restarted = createRemoteAccess(origin, port, () => now, store());
    expect(restarted.claim(request, invitation)).toBeUndefined();
    expect(pair(restarted)).toBeUndefined();
    expect(
      authorized(
        createRemoteAccess(
          origin,
          port + 1,
          () => now,
          fileRemoteSessionStore(dataDir, origin, port + 1),
        ),
        tokens[0]!,
      ),
    ).toMatchObject({ status: 401 });
    const other = "https://other.tail123.ts.net:9443";
    expect(fileRemoteSessionStore(dataDir, other, port).read()).toEqual([]);
    now += SESSION_LIFETIME_MS;
    expect(authorized(restarted, tokens[0]!)).toMatchObject({ status: 401 });
    expect(pair(restarted)).toMatch(/^[a-f0-9]{64}$/);
    expect(store().read()).toHaveLength(1);
  });

  it("fails closed on corrupt, overlarge, insecure, foreign-scope and symlinked files", () => {
    const dataDir = directory();
    const store = fileRemoteSessionStore(dataDir, origin, port);
    store.write([]);
    const folder = join(dataDir, "remote-access");
    const file = join(folder, readdirSync(folder)[0]!);
    for (const content of [
      "{",
      "x".repeat(4097),
      JSON.stringify({ version: 1, origin: "https://other.tail123.ts.net", port, sessions: [] }),
    ]) {
      writeFileSync(file, content, { mode: 0o600 });
      expect(() => store.read()).toThrow();
      expect(() => store.write([])).toThrow();
    }
    writeFileSync(file, JSON.stringify({ version: 1, origin, port, sessions: [] }));
    if (process.platform !== "win32") {
      chmodSync(file, 0o644);
      expect(() => store.read()).toThrow("private");
      chmodSync(file, 0o600);
      const target = join(dataDir, "symlink-target");
      writeFileSync(target, readFileSync(file), { mode: 0o600 });
      rmSync(file);
      symlinkSync(target, file);
      expect(() => store.read()).toThrow();
      expect(() => store.write([])).toThrow();
      rmSync(file);
      chmodSync(folder, 0o755);
      expect(() => fileRemoteSessionStore(dataDir, origin, port)).toThrow("private");
    }
  });

  it("never authenticates a new session when durable commit fails", () => {
    const access = createRemoteAccess(origin, port, Date.now, {
      read: () => [],
      write: () => {
        throw new Error("write refused");
      },
    });
    expect(() => pair(access)).toThrow("write refused");
    expect(authorized(access, "a".repeat(64))).toMatchObject({ status: 401 });
  });
});
