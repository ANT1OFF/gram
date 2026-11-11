import { DEVICE_GRANT_TTL_MS } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { GRANTS_MOST, makeGrantLedger } from "./grants.ts";
import { devicePrivateKeyFrom, generateDeviceKey, mintTurnGrant } from "./keys.ts";

const to = { origin: "https://gram.example.com", workspace: "w1", thread: "t1" };
const START = 1_800_000_000_000;

const ledger = () => {
  const key = devicePrivateKeyFrom(generateDeviceKey().privateKeyPem);
  const clock = { now: START, elapsed: 0 };
  return {
    key,
    clock,
    grants: makeGrantLedger(
      key,
      () => clock.now,
      () => clock.elapsed,
    ),
  };
};

describe("the grants a device still honours", () => {
  it("holds a grant it minted, for its own thread, for ten minutes", () => {
    const { grants, clock } = ledger();
    const signed = grants.mint(to);
    expect(grants.holds(signed, to)).toBe(true);
    expect(grants.holds(signed, { ...to, thread: "t2" })).toBe(false);
    expect(grants.holds(signed, { ...to, workspace: "w2" })).toBe(false);
    expect(grants.holds(signed, { ...to, origin: "https://other.example.com" })).toBe(false);
    clock.now = START + DEVICE_GRANT_TTL_MS - 1;
    clock.elapsed = DEVICE_GRANT_TTL_MS - 1;
    expect(grants.holds(signed, to)).toBe(true);
    clock.now = START + DEVICE_GRANT_TTL_MS;
    clock.elapsed = DEVICE_GRANT_TTL_MS;
    expect(grants.holds(signed, to)).toBe(false);
    expect(grants.size()).toBe(0);
  });

  it("refuses a grant the same key signed in another run of the app", () => {
    const { grants, key } = ledger();
    // Signed by the device's own key, and so valid by its signature, but never minted here.
    const earlier = mintTurnGrant(key, to, START);
    expect(grants.holds(earlier, to)).toBe(false);
  });

  it("refuses a minted grant rewritten for another thread under the same nonce", () => {
    const { grants } = ledger();
    const signed = grants.mint(to);
    const moved = { ...signed, grant: { ...signed.grant, thread: "t2" } };
    expect(grants.holds(moved, { ...to, thread: "t2" })).toBe(false);
    expect(grants.holds({ ...signed, signature: "A".repeat(86) }, to)).toBe(false);
  });

  it("takes grants back by thread, by workspace and all at once", () => {
    const { grants } = ledger();
    const one = grants.mint(to);
    const two = grants.mint({ ...to, thread: "t2" });
    const other = grants.mint({ ...to, workspace: "w2" });
    grants.withdraw({ ...to });
    expect(grants.holds(one, to)).toBe(false);
    expect(grants.holds(two, { ...to, thread: "t2" })).toBe(true);
    grants.withdraw({ workspace: "w1" });
    expect(grants.holds(two, { ...to, thread: "t2" })).toBe(false);
    expect(grants.holds(other, { ...to, workspace: "w2" })).toBe(true);
    grants.withdraw({});
    expect(grants.size()).toBe(0);
  });

  it("answers no for something that isn't a grant", () => {
    const { grants } = ledger();
    for (const junk of [undefined, null, {}, { grant: null }, { grant: { nonce: 5 } }])
      expect(grants.holds(junk as never, to)).toBe(false);
  });

  it("keeps no more than its most, the oldest going first", () => {
    const { grants } = ledger();
    const first = grants.mint(to);
    for (let index = 0; index < GRANTS_MOST; index += 1)
      grants.mint({ ...to, thread: `x${index}` });
    expect(grants.size()).toBe(GRANTS_MOST);
    expect(grants.holds(first, to)).toBe(false);
  });

  it("ends a grant after ten minutes even when the wall clock is set back", () => {
    const { grants, clock } = ledger();
    const signed = grants.mint(to);
    clock.elapsed = DEVICE_GRANT_TTL_MS;
    // Set back nine minutes: by the wall clock the grant has time left.
    clock.now = START + DEVICE_GRANT_TTL_MS - 9 * 60_000;
    expect(grants.holds(signed, to)).toBe(false);
  });

  it("checks the thread a grant was minted for, not only what its signature covers", () => {
    const { grants } = ledger();
    const signed = grants.mint(to);
    grants.withdraw({ origin: "https://other.example.com" });
    expect(grants.holds(signed, to)).toBe(true);
    grants.withdraw({ origin: to.origin });
    expect(grants.holds(signed, to)).toBe(false);
  });
});
