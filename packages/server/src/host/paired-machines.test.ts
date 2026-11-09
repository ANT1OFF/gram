import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
  type DialNonces,
  fileMachineStore,
  fileNonceStore,
  JOIN_LIFETIME_MS,
  machineView,
  MAX_MACHINES,
  memoryMachineStore,
  memoryNonceStore,
  NO_DIALS,
  type PairedMachines,
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

/** A machine joined to `machines` and confirmed, with the key it signs with. */
const confirmedMachine = (machines: PairedMachines) => {
  const key = generateHostKey();
  const id = hostIdOf(key.publicKey);
  const code = codeOf(machines.mint(ORIGIN).url);
  machines.join(ORIGIN, { code, name: "box", platform: "linux", ...key });
  machines.confirm(id);
  return { id, own: privateKeyFrom(key.privateKeyPem) };
};

/** One machine store and clock across restarts, with the nonces the runs share. */
const restartable = () => {
  let time = 1_000_000;
  const clock = { now: () => time, advance: (ms: number) => (time += ms) };
  return { clock, store: memoryMachineStore(), nonces: memoryNonceStore() };
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

  it("refuses reserved local aliases without consuming the invitation", () => {
    const { machines } = setup();
    const code = codeOf(machines.mint(ORIGIN).url);
    const key = generateHostKey();
    for (const name of ["local", "LOCAL", " local ", "this machine", "This Machine"]) {
      expect(machines.join(ORIGIN, { code, name, platform: "linux", ...key })).toMatchObject({
        kind: "refused",
        status: 400,
        message: expect.stringContaining("reserved"),
      });
      expect(machines.list()).toEqual([]);
    }
    expect(machines.join(ORIGIN, { code, name: "build box", platform: "linux", ...key }).kind).toBe(
      "joined",
    );
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
    const { clock, store, nonces } = restartable();
    const before = createPairedMachines(store, clock.now, nonces);
    const { id, own } = confirmedMachine(before);
    const headers = signedConnectHeaders(own, ORIGIN, id, clock.now());
    expect(before.authorizeConnect(ORIGIN, headers).kind).toBe("ok");
    expect(before.authorizeConnect(ORIGIN, headers)).toMatchObject({
      message: "unauthorized: dial replayed",
    });

    clock.advance(30_000);
    const after = createPairedMachines(store, clock.now, nonces);
    expect(after.authorizeConnect(ORIGIN, headers)).toMatchObject({
      kind: "refused",
      message: "unauthorized: dial replayed",
    });
    // A fresh dial still gets in, and nonces past their window aren't kept.
    expect(
      after.authorizeConnect(ORIGIN, signedConnectHeaders(own, ORIGIN, id, clock.now())).kind,
    ).toBe("ok");
    clock.advance(2 * CONNECT_SKEW_MS);
    createPairedMachines(store, clock.now, nonces).authorizeConnect(
      ORIGIN,
      signedConnectHeaders(own, ORIGIN, id, clock.now()),
    );
    expect(nonces.read().nonces).toHaveLength(1);
  });

  // Review of #324: the skew check takes a dial exactly two minutes old, but its nonce was let
  // go at that moment, in memory and on a restart.
  it("refuses a replay at the last moment of its window, restarted or not", () => {
    const { clock, store, nonces } = restartable();
    const machines = createPairedMachines(store, clock.now, nonces);
    const { id, own } = confirmedMachine(machines);
    const headers = signedConnectHeaders(own, ORIGIN, id, clock.now());
    expect(machines.authorizeConnect(ORIGIN, headers).kind).toBe("ok");
    clock.advance(CONNECT_SKEW_MS);
    expect(machines.authorizeConnect(ORIGIN, headers)).toMatchObject({ kind: "refused" });
    const again = createPairedMachines(store, clock.now, nonces);
    expect(again.authorizeConnect(ORIGIN, headers)).toMatchObject({ kind: "refused" });
  });

  // Review of #324: with the clock moved forward a nonce was let go; set back, its dial was in
  // its window again and was taken, before and after a restart.
  it("refuses a replay a clock set back brings into its window again", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-machines-"));
    try {
      let time = 1_000_000;
      const now = () => time;
      const machines = createPairedMachines(fileMachineStore(dir), now, fileNonceStore(dir));
      const key = generateHostKey();
      const id = hostIdOf(key.publicKey);
      const code = codeOf(machines.mint(ORIGIN).url);
      machines.join(ORIGIN, { code, name: "box", platform: "linux", ...key });
      machines.confirm(id);
      const own = privateKeyFrom(key.privateKeyPem);
      const headers = signedConnectHeaders(own, ORIGIN, id, time);
      expect(machines.authorizeConnect(ORIGIN, headers).kind).toBe("ok");
      time += CONNECT_SKEW_MS + 1;
      expect(
        machines.authorizeConnect(ORIGIN, signedConnectHeaders(own, ORIGIN, id, time)).kind,
      ).toBe("ok");
      time = 1_000_000 + 30_000;
      expect(machines.authorizeConnect(ORIGIN, headers)).toMatchObject({ kind: "refused" });
      const again = createPairedMachines(fileMachineStore(dir), now, fileNonceStore(dir));
      expect(again.authorizeConnect(ORIGIN, headers)).toMatchObject({ kind: "refused" });
      // A fresh dial gets in again once the clock is past every nonce it let go.
      time = 1_000_000 + CONNECT_SKEW_MS + 2;
      expect(again.authorizeConnect(ORIGIN, signedConnectHeaders(own, ORIGIN, id, time)).kind).toBe(
        "ok",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses dials signed before it can know which were accepted, when it can't read them", () => {
    const { clock, store } = restartable();
    const first = createPairedMachines(store, clock.now);
    const { id, own } = confirmedMachine(first);
    // Taken by the run before, signed as far ahead as the skew allows.
    const ahead = signedConnectHeaders(own, ORIGIN, id, clock.now() + CONNECT_SKEW_MS);
    expect(first.authorizeConnect(ORIGIN, ahead).kind).toBe("ok");
    const saved = memoryNonceStore();
    const lastSeen = clock.now();
    const unreadable = {
      read: (): DialNonces => {
        throw new Error("Dial nonce storage is invalid");
      },
      write: saved.write,
      lastSeen: () => lastSeen,
    };
    const machines = createPairedMachines(store, clock.now, unreadable);
    const dial = () =>
      machines.authorizeConnect(ORIGIN, signedConnectHeaders(own, ORIGIN, id, clock.now()));
    expect(dial()).toMatchObject({ kind: "refused" });
    clock.advance(CONNECT_SKEW_MS);
    expect(dial()).toMatchObject({ kind: "refused" });
    // The other edge of that dial's window: it is still refused.
    clock.advance(CONNECT_SKEW_MS);
    expect(machines.authorizeConnect(ORIGIN, ahead)).toMatchObject({ kind: "refused" });
    expect(dial().kind).toBe("ok");
    expect(saved.read().nonces).toHaveLength(1);

    // A nonce that can't be saved refuses its dial, and its replay in this run too.
    const unsaved = createPairedMachines(store, clock.now, {
      read: () => NO_DIALS,
      write: () => {
        throw new Error("disk full");
      },
    });
    const headers = signedConnectHeaders(own, ORIGIN, id, clock.now());
    expect(unsaved.authorizeConnect(ORIGIN, headers)).toMatchObject({ status: 503 });
    expect(unsaved.authorizeConnect(ORIGIN, headers)).toMatchObject({
      message: "unauthorized: dial replayed",
    });
  });

  // Re-review of #324: the skew check and the pruning each read the clock; a millisecond between
  // them let the replayed dial's nonce go and took the dial, restarted or not.
  it("checks a dial against one reading of the clock, however it moves meanwhile", () => {
    const { clock, store, nonces } = restartable();
    const machines = createPairedMachines(store, clock.now, nonces);
    const { id, own } = confirmedMachine(machines);
    const signed = clock.now();
    const headers = signedConnectHeaders(own, ORIGIN, id, signed);
    expect(machines.authorizeConnect(ORIGIN, headers).kind).toBe("ok");
    /** The last moment of the dial's window. */
    const atExpiry = () => clock.advance(signed + CONNECT_SKEW_MS - clock.now());
    /** A clock a millisecond on at each reading. */
    const ticking = () => {
      const at = clock.now();
      clock.advance(1);
      return at;
    };
    atExpiry();
    const live = createPairedMachines(store, ticking, nonces);
    expect(live.authorizeConnect(ORIGIN, headers)).toMatchObject({ kind: "refused" });
    atExpiry();
    const restarted = createPairedMachines(store, ticking, nonces);
    expect(restarted.authorizeConnect(ORIGIN, headers)).toMatchObject({ kind: "refused" });
  });

  // Re-review of #324: with its history unreadable, the floor came from the clock now, so a clock
  // set back even a millisecond took a dial the last run had accepted.
  it("bounds an unreadable history by the latest time it was written, not the clock now", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-machines-"));
    try {
      let time = 1_000_000;
      const now = () => time;
      const machines = createPairedMachines(fileMachineStore(dir), now, fileNonceStore(dir));
      const { id, own } = confirmedMachine(machines);
      const ahead = signedConnectHeaders(own, ORIGIN, id, time + CONNECT_SKEW_MS);
      expect(machines.authorizeConnect(ORIGIN, ahead).kind).toBe("ok");
      // Its content lost, as a disk fault would, the file's time kept.
      const file = join(dir, "remote-access", "dial-nonces.json");
      const { mtime } = statSync(file);
      writeFileSync(file, "{");
      utimesSync(file, mtime, mtime);
      time -= 1;
      const after = createPairedMachines(fileMachineStore(dir), now, fileNonceStore(dir));
      time += 1;
      expect(after.authorizeConnect(ORIGIN, ahead)).toMatchObject({ kind: "refused" });
      time += 2 * CONNECT_SKEW_MS;
      expect(after.authorizeConnect(ORIGIN, ahead)).toMatchObject({ kind: "refused" });
      // Fresh dials get in once past every dial the lost history could hold.
      time = 1_000_000 + CONNECT_SKEW_MS + 1001;
      expect(after.authorizeConnect(ORIGIN, signedConnectHeaders(own, ORIGIN, id, time)).kind).toBe(
        "ok",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes no dial when it can't bound the history it can't read", () => {
    const { clock, store } = restartable();
    const machines = createPairedMachines(store, clock.now, {
      read: () => {
        throw new Error("Dial nonce storage is invalid");
      },
      write: () => {},
    });
    const { id, own } = confirmedMachine(machines);
    const dial = () =>
      machines.authorizeConnect(ORIGIN, signedConnectHeaders(own, ORIGIN, id, clock.now()));
    expect(dial()).toMatchObject({ kind: "refused" });
    clock.advance(10 * CONNECT_SKEW_MS);
    expect(dial()).toMatchObject({ kind: "refused", status: 503 });
  });

  // Third re-check of #324: storage that couldn't be read or bounded at the start refused every
  // dial until a restart, even once it was put right.
  it("loads the history again once it can, rather than refuse dials until a restart", () => {
    const { clock, store } = restartable();
    const kept = memoryNonceStore();
    let broken = true;
    let reads = 0;
    const flaky = {
      read: () => {
        reads += 1;
        if (broken) throw new Error("Dial nonce storage is invalid");
        return kept.read();
      },
      write: kept.write,
      lastSeen: () => undefined,
    };
    const machines = createPairedMachines(store, clock.now, flaky);
    const { id, own } = confirmedMachine(machines);
    const dial = (from = machines) =>
      from.authorizeConnect(ORIGIN, signedConnectHeaders(own, ORIGIN, id, clock.now()));
    expect(dial()).toMatchObject({ status: 503 });
    broken = false;
    clock.advance(1);
    expect(dial().kind).toBe("ok");

    // Only a confirmed machine's signed dial makes it read the storage again.
    broken = true;
    const blind = createPairedMachines(store, clock.now, flaky);
    const before = reads;
    const stranger = privateKeyFrom(generateHostKey().privateKeyPem);
    blind.authorizeConnect(ORIGIN, signedConnectHeaders(stranger, ORIGIN, id, clock.now()));
    expect(reads).toBe(before);
    expect(dial(blind)).toMatchObject({ status: 503 });
    expect(reads).toBe(before + 1);
  });

  // Review of #324: a machine not confirmed yet could fill the dials' room, and have each of its
  // refused dials written to disk.
  it("keeps no nonce for a machine not confirmed yet", () => {
    const { clock, store } = restartable();
    let writes = 0;
    const kept = memoryNonceStore();
    const nonces = {
      read: kept.read,
      write: (next: DialNonces) => {
        writes += 1;
        kept.write(next);
      },
    };
    const machines = createPairedMachines(store, clock.now, nonces);
    const { id: trusted, own: trustedKey } = confirmedMachine(machines);
    const key = generateHostKey();
    const id = hostIdOf(key.publicKey);
    const code = codeOf(machines.mint(ORIGIN).url);
    machines.join(ORIGIN, { code, name: "new box", platform: "linux", ...key });
    const own = privateKeyFrom(key.privateKeyPem);
    for (let i = 0; i < 4096; i++)
      expect(
        machines.authorizeConnect(ORIGIN, signedConnectHeaders(own, ORIGIN, id, clock.now())),
      ).toMatchObject({ status: 403 });
    expect(writes).toBe(0);
    expect(
      machines.authorizeConnect(
        ORIGIN,
        signedConnectHeaders(trustedKey, ORIGIN, trusted, clock.now()),
      ).kind,
    ).toBe("ok");
  });

  it("keeps accepted dials' nonces in a private file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-machines-"));
    try {
      const machines = createPairedMachines(fileMachineStore(dir), Date.now, fileNonceStore(dir));
      const key = generateHostKey();
      const id = hostIdOf(key.publicKey);
      const code = codeOf(machines.mint(ORIGIN).url);
      machines.join(ORIGIN, { code, name: "box", platform: "linux", ...key });
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
