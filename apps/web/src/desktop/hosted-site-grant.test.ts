import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignedTurnGrant } from "@gram/contracts";
import { HOSTED_SITE_GRANT_WAIT_MS, hostedSiteGrant } from "./hosted-site-grant";

// A message sent from a hosted server's site in the desktop app carries the grant the app signed
// for it, so its turn may ask the person's computer. When the app gives none, refuses or doesn't
// answer, the message still goes, without one.

const grant = { grant: { thread: "t1" }, signature: "s".repeat(86) } as unknown as SignedTurnGrant;

afterEach(() => vi.useRealTimers());

describe("the grant a hosted site's message carries", () => {
  it("is the one the app signed for that thread", async () => {
    const asked: string[] = [];
    const site = {
      turnGrant: async (threadId: string) => {
        asked.push(threadId);
        return grant;
      },
    };
    expect(await hostedSiteGrant("t1", site)).toBe(grant);
    expect(asked).toEqual(["t1"]);
  });

  it("is none outside the app's window, when it refuses, and when it doesn't answer", async () => {
    expect(await hostedSiteGrant("t1", undefined)).toBeUndefined();
    expect(await hostedSiteGrant("t1", { turnGrant: async () => null })).toBeUndefined();
    expect(
      await hostedSiteGrant("t1", { turnGrant: () => Promise.reject(new Error("gone")) }),
    ).toBeUndefined();
    vi.useFakeTimers();
    const waiting = hostedSiteGrant("t1", { turnGrant: () => new Promise(() => undefined) });
    await vi.advanceTimersByTimeAsync(HOSTED_SITE_GRANT_WAIT_MS);
    expect(await waiting).toBeUndefined();
  });
});
