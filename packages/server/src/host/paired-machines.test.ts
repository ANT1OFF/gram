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
  fileMachineStore,
  JOIN_LIFETIME_MS,
  machineView,
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

  it("records when a machine took a Claude token, a time and nothing else, across a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-machines-"));
    try {
      const machines = createPairedMachines(fileMachineStore(dir), () => 5_000);
      const code = codeOf(machines.mint(ORIGIN).url);
      const key = generateHostKey();
      const joined = machines.join(ORIGIN, { code, name: "box", platform: "linux", ...key });
      if (joined.kind !== "joined") throw new Error("didn't join");
      machines.tokenSent(joined.machine.id, true);
      const again = createPairedMachines(fileMachineStore(dir));
      expect(again.get(joined.machine.id)?.claudeTokenSetAt).toBe(5_000);
      again.tokenSent(joined.machine.id, false);
      expect(createPairedMachines(fileMachineStore(dir)).get(joined.machine.id)).not.toHaveProperty(
        "claudeTokenSetAt",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps why each signed dial was refused, and never a forged one's clock", () => {
    const { clock, machines, joinOne } = setup();
    const { key, id } = joinOne();
    const own = privateKeyFrom(key.privateKeyPem);
    const dial = (k = own, at = clock.now()) =>
      machines.authorizeConnect(ORIGIN, signedConnectHeaders(k, ORIGIN, id, at));
    expect(machines.problemOf(id)).toBeUndefined();

    // Not confirmed yet.
    dial();
    expect(machines.problemOf(id)).toEqual({ kind: "unconfirmed", at: clock.now() });
    machines.confirm(id);
    // It came online, which clears that.
    machines.note(id, undefined);

    // Signed by another key, or for another address.
    clock.advance(1000);
    dial(privateKeyFrom(generateHostKey().privateKeyPem));
    expect(machines.problemOf(id)).toEqual({ kind: "bad-signature", at: clock.now() });

    // Its own signed time, three minutes ahead or behind.
    clock.advance(1000);
    dial(own, clock.now() + 3 * 60_000);
    expect(machines.problemOf(id)).toEqual({ kind: "clock", at: clock.now(), skewMs: 180_000 });
    dial(own, clock.now() - 4 * 60_000);
    expect(machines.problemOf(id)).toMatchObject({ kind: "clock", skewMs: -240_000 });
    // An out-of-date dial another key signed says nothing about its clock.
    clock.advance(1000);
    dial(privateKeyFrom(generateHostKey().privateKeyPem), clock.now() + 10 * 60_000);
    expect(machines.problemOf(id)).toMatchObject({ kind: "clock", skewMs: -240_000 });

    // A bad signature anyone could send doesn't replace a reason its own key stood behind.
    dial(privateKeyFrom(generateHostKey().privateKeyPem));
    expect(machines.problemOf(id)).toMatchObject({ kind: "clock" });

    // A dial with no signature at all is nobody's.
    machines.authorizeConnect(ORIGIN, {});
    expect(machines.problemOf(id)).toMatchObject({ kind: "clock" });

    // Online again clears it; removing the machine forgets it.
    machines.note(id, undefined);
    expect(machines.problemOf(id)).toBeUndefined();
    machines.note(id, { kind: "lost", at: clock.now() });
    machines.remove(id);
    expect(machines.problemOf(id)).toBeUndefined();
    machines.note(id, { kind: "lost", at: clock.now() });
    expect(machines.problemOf(id)).toBeUndefined();
  });

  it("says why a machine is offline, and its release while it says one", () => {
    const { clock, machines, joinOne } = setup();
    const { id } = joinOne();
    machines.confirm(id);
    const machine = machines.get(id)!;
    expect(machineView(machine, undefined).offline).toEqual({ kind: "never" });
    expect(machineView(machine, undefined, { tailscale: false }).offline).toEqual({
      kind: "tailscale-off",
    });
    const lost = { kind: "lost", at: clock.now() } as const;
    expect(machineView(machine, undefined, { problem: lost, tailscale: true }).offline).toEqual(
      lost,
    );
    const online = machineView(machine, { since: 5, release: "1.15.2" }, { problem: lost });
    expect(online).toMatchObject({ onlineSince: 5, release: "1.15.2" });
    expect(online).not.toHaveProperty("offline");
    const mismatch = machineView(machine, undefined, {
      problem: { kind: "mismatch", at: 1, protocol: 3, release: "1.17.0" },
    });
    expect(mismatch).toMatchObject({
      offline: { kind: "mismatch", protocol: 3 },
      release: "1.17.0",
    });
    // No key and nothing from a dial: only what the page shows.
    expect(Object.keys(machineView(machine, undefined)).toSorted()).toEqual(
      ["confirmed", "fingerprint", "id", "joinedAt", "name", "offline", "platform"].toSorted(),
    );
  });

  it("keeps where Gram installed a machine over SSH, and only a host to SSH to", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-machines-"));
    try {
      const machines = createPairedMachines(fileMachineStore(dir));
      const key = generateHostKey();
      const code = codeOf(machines.mint(ORIGIN).url);
      machines.join(ORIGIN, { code, name: "box", platform: "linux", ...key });
      const id = hostIdOf(key.publicKey);
      machines.installedOverSsh(id, "-oProxyCommand=evil");
      expect(machines.get(id)).not.toHaveProperty("sshTarget");
      machines.installedOverSsh(id, "me@build-box");
      expect(createPairedMachines(fileMachineStore(dir)).get(id)).toMatchObject({
        sshTarget: "me@build-box",
      });
      expect(machineView(machines.get(id)!, undefined)).toMatchObject({
        sshTarget: "me@build-box",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
