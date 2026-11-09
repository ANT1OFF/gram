import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONNECT_SKEW_MS,
  fingerprintOf,
  generateHostKey,
  hostIdOf,
  privateKeyFrom,
  publicKeyFrom,
  signedConnectHeaders,
} from "./machine-keys.ts";
import {
  createPairedMachines,
  type DialNonce,
  fileMachineStore,
  fileNonceStore,
  JOIN_LIFETIME_MS,
  MAX_MACHINES,
  memoryMachineStore,
} from "./paired-machines.ts";

const ORIGIN = "https://main.example-tailnet.ts.net";

const codeOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("code")!;

const setup = () => {
  let time = 1_000_000;
  const clock = { now: () => time, advance: (ms: number) => (time += ms) };
  const machines = createPairedMachines(memoryMachineStore(), clock.now);
  const joinOne = (name = "box") => {
    const key = generateHostKey();
    const code = codeOf(machines.mint(ORIGIN).url);
    const result = machines.join(ORIGIN, { code, name, platform: "linux", ...key });
    return { key, result, id: hostIdOf(key.publicKey) };
  };
  return { clock, machines, joinOne };
};

describe("machine keys", () => {
  it("derives the id and fingerprint from the public key, and checks keys strictly", () => {
    const { publicKey } = generateHostKey();
    expect(hostIdOf(publicKey)).toMatch(/^m-[a-f0-9]{24}$/);
    expect(fingerprintOf(publicKey)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);
    expect(publicKeyFrom(publicKey)).toBeDefined();
    expect(publicKeyFrom("not a key")).toBeUndefined();
    expect(publicKeyFrom("A".repeat(43))).toBeDefined();
    expect(publicKeyFrom(`${publicKey}=`)).toBeUndefined();
  });
});

describe("joined machines", () => {
  it("takes one join per link, only with its code, only before it expires", () => {
    const { clock, machines } = setup();
    const code = codeOf(machines.mint(ORIGIN).url);
    const key = generateHostKey();
    const attempt = (c: string, origin = ORIGIN) =>
      machines.join(origin, { code: c, name: "box", platform: "linux", ...key }).kind;
    expect(attempt("f".repeat(64))).toBe("refused");
    expect(attempt(code, "https://other.example-tailnet.ts.net")).toBe("refused");
    clock.advance(JOIN_LIFETIME_MS);
    expect(attempt(code)).toBe("refused");
    const fresh = codeOf(machines.mint(ORIGIN).url);
    expect(attempt(fresh)).toBe("joined");
    expect(attempt(fresh)).toBe("refused");
    expect(machines.joinOpen()).toBeUndefined();
  });

  it("refuses a bad name or key, a second join of one machine, and more than the most", () => {
    const { machines, joinOne } = setup();
    const code = codeOf(machines.mint(ORIGIN).url);
    const key = generateHostKey();
    expect(machines.join(ORIGIN, { code, name: "a\nb", platform: "linux", ...key })).toMatchObject({
      kind: "refused",
      status: 400,
    });
    expect(
      machines.join(ORIGIN, { code, name: "box", platform: "linux", publicKey: "x" }),
    ).toMatchObject({ kind: "refused", status: 400 });
    const first = joinOne();
    expect(
      machines.join(ORIGIN, {
        code: codeOf(machines.mint(ORIGIN).url),
        name: "again",
        platform: "linux",
        publicKey: first.key.publicKey,
      }),
    ).toMatchObject({ kind: "refused", status: 409 });
    for (let i = 1; i < MAX_MACHINES; i++) expect(joinOne().result.kind).toBe("joined");
    expect(joinOne().result).toMatchObject({ kind: "refused", status: 409 });
  });

  it("lets a machine dial in only once confirmed, with a fresh dial signed by its own key", () => {
    const { clock, machines, joinOne } = setup();
    const { key, id } = joinOne();
    const own = privateKeyFrom(key.privateKeyPem);
    const dial = (k = own, origin = ORIGIN, at = clock.now()) =>
      machines.authorizeConnect(ORIGIN, signedConnectHeaders(k, origin, id, at));
    expect(dial()).toMatchObject({ kind: "refused", status: 403 });
    machines.confirm(id);
    expect(dial().kind).toBe("ok");
    expect(dial(privateKeyFrom(generateHostKey().privateKeyPem))).toMatchObject({ status: 401 });
    expect(dial(own, "https://other.example-tailnet.ts.net")).toMatchObject({ status: 401 });
    expect(dial(own, ORIGIN, clock.now() - CONNECT_SKEW_MS - 1)).toMatchObject({ status: 401 });
    const headers = signedConnectHeaders(own, ORIGIN, id, clock.now());
    expect(machines.authorizeConnect(ORIGIN, headers).kind).toBe("ok");
    expect(machines.authorizeConnect(ORIGIN, headers)).toMatchObject({
      message: "unauthorized: dial replayed",
    });
    expect(machines.authorizeConnect(ORIGIN, {})).toMatchObject({ status: 401 });
    machines.remove(id);
    expect(dial()).toMatchObject({ message: "unauthorized: machine not joined" });
  });

  // Joined-machines audit A2: a dial's signed headers replayed after the main Gram restarted,
  // within their two minutes, were taken as a new dial, as the nonces lived only in memory.
  it("refuses a dial replayed after the main Gram restarts within its window", () => {
    let time = 1_000_000;
    const now = () => time;
    const store = memoryMachineStore();
    let kept: ReadonlyArray<DialNonce> = [];
    const nonces = {
      read: () => [...kept],
      write: (next: ReadonlyArray<DialNonce>) => (kept = next),
    };
    const before = createPairedMachines(store, now, nonces);
    const key = generateHostKey();
    const id = hostIdOf(key.publicKey);
    before.join(ORIGIN, {
      code: codeOf(before.mint(ORIGIN).url),
      name: "box",
      platform: "linux",
      ...key,
    });
    before.confirm(id);
    const own = privateKeyFrom(key.privateKeyPem);
    const headers = signedConnectHeaders(own, ORIGIN, id, time);
    expect(before.authorizeConnect(ORIGIN, headers).kind).toBe("ok");
    expect(before.authorizeConnect(ORIGIN, headers)).toMatchObject({
      message: "unauthorized: dial replayed",
    });

    time += 30_000;
    const after = createPairedMachines(store, now, nonces);
    expect(after.authorizeConnect(ORIGIN, headers)).toMatchObject({
      kind: "refused",
      message: "unauthorized: dial replayed",
    });
    // A fresh dial still gets in, and nonces past their window aren't kept.
    expect(after.authorizeConnect(ORIGIN, signedConnectHeaders(own, ORIGIN, id, time)).kind).toBe(
      "ok",
    );
    time += 2 * CONNECT_SKEW_MS;
    createPairedMachines(store, now, nonces).authorizeConnect(
      ORIGIN,
      signedConnectHeaders(own, ORIGIN, id, time),
    );
    expect(kept).toHaveLength(1);
  });

  it("refuses dials while it can't know which were accepted before it restarted", () => {
    let time = 1_000_000;
    const now = () => time;
    const store = memoryMachineStore();
    const first = createPairedMachines(store, now);
    const key = generateHostKey();
    const id = hostIdOf(key.publicKey);
    first.join(ORIGIN, {
      code: codeOf(first.mint(ORIGIN).url),
      name: "box",
      platform: "linux",
      ...key,
    });
    first.confirm(id);
    const own = privateKeyFrom(key.privateKeyPem);
    let saved: ReadonlyArray<DialNonce> = [];
    const unreadable = {
      read: (): DialNonce[] => {
        throw new Error("Dial nonce storage is invalid");
      },
      write: (next: ReadonlyArray<DialNonce>) => (saved = next),
    };
    const machines = createPairedMachines(store, now, unreadable);
    const dial = () =>
      machines.authorizeConnect(ORIGIN, signedConnectHeaders(own, ORIGIN, id, time));
    expect(dial()).toMatchObject({ kind: "refused", status: 503 });
    time += 2 * CONNECT_SKEW_MS - 1;
    expect(dial()).toMatchObject({ kind: "refused", status: 503 });
    time += 1;
    expect(dial().kind).toBe("ok");
    expect(saved).toHaveLength(1);

    // A nonce that can't be saved refuses its dial, and its replay in this run too.
    const unsaved = createPairedMachines(store, now, {
      read: () => [],
      write: () => {
        throw new Error("disk full");
      },
    });
    const headers = signedConnectHeaders(own, ORIGIN, id, time);
    expect(unsaved.authorizeConnect(ORIGIN, headers)).toMatchObject({ status: 503 });
    expect(unsaved.authorizeConnect(ORIGIN, headers)).toMatchObject({
      message: "unauthorized: dial replayed",
    });
  });

  it("keeps accepted dials' nonces in a private file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-machines-"));
    try {
      const machines = createPairedMachines(fileMachineStore(dir), Date.now, fileNonceStore(dir));
      const key = generateHostKey();
      const id = hostIdOf(key.publicKey);
      machines.join(ORIGIN, {
        code: codeOf(machines.mint(ORIGIN).url),
        name: "box",
        platform: "linux",
        ...key,
      });
      machines.confirm(id);
      const headers = signedConnectHeaders(privateKeyFrom(key.privateKeyPem), ORIGIN, id);
      expect(machines.authorizeConnect(ORIGIN, headers).kind).toBe("ok");
      const again = createPairedMachines(fileMachineStore(dir), Date.now, fileNonceStore(dir));
      expect(again.authorizeConnect(ORIGIN, headers)).toMatchObject({
        message: "unauthorized: dial replayed",
      });
      expect(statSync(join(dir, "remote-access", "dial-nonces.json")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the machines in a private file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-machines-"));
    try {
      const store = fileMachineStore(dir);
      const machines = createPairedMachines(store);
      const code = new URLSearchParams(new URL(machines.mint(ORIGIN).url).hash.slice(1)).get(
        "code",
      )!;
      const key = generateHostKey();
      machines.join(ORIGIN, { code, name: "box", platform: "darwin", ...key });
      const again = createPairedMachines(fileMachineStore(dir));
      expect(again.list()).toEqual([
        expect.objectContaining({ id: hostIdOf(key.publicKey), name: "box", platform: "darwin" }),
      ]);
      expect(statSync(join(dir, "remote-access", "machines.json")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
