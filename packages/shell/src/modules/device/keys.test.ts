import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
  DEVICE_CLOCK_SKEW_MS,
  DEVICE_GRANT_TTL_MS,
  type SignedTurnGrant,
  type TurnGrant,
  turnGrantBytes,
} from "@gram/contracts";
import { describe, expect, it } from "vitest";
import {
  approvalHash,
  deviceDialHolds,
  deviceDialTime,
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

const signedBy = (key: KeyObject, grant: TurnGrant): SignedTurnGrant => ({
  grant,
  signature: sign(null, turnGrantBytes(grant), key).toString("base64url"),
});

describe("what the code review asked to hold", () => {
  it("refuses a grant when the clock isn't a number", () => {
    const me = device();
    const signed = mintTurnGrant(me.key, to, NOW);
    for (const now of [Number.NaN, undefined, Number.POSITIVE_INFINITY, "1800000000000", 1.5])
      expect(turnGrantHolds(me.public, signed, to, now as number), String(now)).toBe(false);
  });

  it("refuses a grant the device's own key signed with another lifetime or version", () => {
    const me = device();
    const { grant } = mintTurnGrant(me.key, to, NOW);
    expect(turnGrantHolds(me.public, signedBy(me.key, grant), to, NOW)).toBe(true);
    const longer = { ...grant, expiresAt: grant.expiresAt + 60 * 60_000 };
    expect(turnGrantHolds(me.public, signedBy(me.key, longer), to, NOW)).toBe(false);
    const other = { ...grant, v: 2 } as unknown as TurnGrant;
    expect(turnGrantHolds(me.public, signedBy(me.key, other), to, NOW)).toBe(false);
    const fraction = { ...grant, issuedAt: NOW + 0.5, expiresAt: NOW + 0.5 + DEVICE_GRANT_TTL_MS };
    expect(turnGrantHolds(me.public, signedBy(me.key, fraction), to, NOW + 1)).toBe(false);
  });

  it("takes one spelling of a signature, not the sixteen that decode alike", () => {
    const me = device();
    const signed = mintTurnGrant(me.key, to, NOW);
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(signed.signature.at(-1) ?? "");
    let held = 0;
    for (let spare = 0; spare < 16; spare += 1) {
      const signature = signed.signature.slice(0, -1) + alphabet[(last & 0x30) | spare];
      if (turnGrantHolds(me.public, { ...signed, signature }, to, NOW)) held += 1;
    }
    expect(held).toBe(1);
  });

  it("refuses a key of small order, which would verify anything", () => {
    const identity = Buffer.from(`01${"00".repeat(31)}`, "hex").toString("base64url");
    expect(devicePublicKeyFrom(identity)).toBeUndefined();
    for (const hex of [
      "00".repeat(32),
      `ec${"ff".repeat(30)}7f`,
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    ])
      expect(devicePublicKeyFrom(Buffer.from(hex, "hex").toString("base64url")), hex).toBe(
        undefined,
      );
  });

  it("gives an id only to a key in its one spelling", () => {
    const me = device();
    expect(deviceIdOf(me.publicKey)).toBe(me.deviceId);
    for (const text of ["garbage", `${me.publicKey}=`, ` ${me.publicKey}`, ""])
      expect(() => deviceIdOf(text), text).toThrow();
    // The last character has two spare bits: the other spellings of the same bytes are refused.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(me.publicKey.at(-1) ?? "");
    const respelled = me.publicKey.slice(0, -1) + alphabet[last ^ 1];
    expect(devicePublicKeyFrom(respelled)).toBeUndefined();
  });

  it("refuses a dial that names another device than the key's, or a time that isn't a number", () => {
    const me = device();
    const other = device();
    const dial = dialOf(other.deviceId);
    expect(deviceDialHolds(me.public, dial, signDeviceDial(me.key, dial), NOW)).toBe(false);
    const mine = dialOf(me.deviceId);
    const signature = signDeviceDial(me.key, mine);
    for (const time of ["1800000000000", [NOW], Number.NaN])
      expect(
        deviceDialHolds(me.public, { ...mine, time: time as number }, signature, NOW),
        String(time),
      ).toBe(false);
    expect(deviceDialHolds(me.public, mine, signature, Number.NaN)).toBe(false);
  });

  it("reads a dial's time from thirteen digits and nothing else", () => {
    expect(deviceDialTime("1800000000000")).toBe(NOW);
    for (const header of ["1800000000000 ", "1.8e12", "", "18000000000000", [NOW], NOW, undefined])
      expect(deviceDialTime(header), String(header)).toBeUndefined();
  });

  it("refuses a private key that isn't Ed25519", () => {
    const { privateKey } = generateKeyPairSync("ed448");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => devicePrivateKeyFrom(pem)).toThrow();
  });

  it("compares only text", () => {
    expect(sameHash("ab", "ab")).toBe(true);
    expect(sameHash(["a"] as unknown as string, ["a"] as unknown as string)).toBe(false);
    expect(sameHash(undefined as unknown as string, "a")).toBe(false);
  });
});
