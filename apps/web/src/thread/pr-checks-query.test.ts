import type { PrChecksResult, PrStatus, ThreadId } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Api } from "@/api/types";

import { keepSamePrChecks, prChecksQuery } from "./pr-checks-query";

const T = "t-1" as ThreadId;
const badge = {
  number: 4,
  url: "https://github.com/example/api/pull/4",
  updatedAt: "2026-09-19T10:00:00Z",
  checks: "failing",
} as PrStatus;
const git = { origin: "example/api", pr: badge };
const api = { prChecks: vi.fn(async () => ({ checks: [] })) } as unknown as Api;

describe("prChecksQuery", () => {
  it("asks for the checks alone", async () => {
    await prChecksQuery(api, T, git, undefined).queryFn();
    expect(api.prChecks).toHaveBeenCalledWith(T);
  });

  it("is a new query when the badge's checks or update time change", () => {
    const key = prChecksQuery(api, T, git, undefined).queryKey;
    for (const pr of [
      { ...badge, checks: "passing" as const },
      { ...badge, updatedAt: "2026-09-19T10:05:00Z" },
    ]) {
      const next = prChecksQuery(api, T, { ...git, pr }, undefined).queryKey;
      expect(next).not.toEqual(key);
      expect(next[2]).toBe(key[2]);
    }
  });

  it("names the bound PR over the branch's", () => {
    const bound = { repo: "EXAMPLE/infra", number: 88, monitor: false };
    expect(prChecksQuery(api, T, git, bound).queryKey[2]).toBe("example/infra#88");
    expect(prChecksQuery(api, T, undefined, undefined).queryKey[2]).toBeNull();
  });
});

describe("keepSamePrChecks", () => {
  const previous: PrChecksResult = { checks: [{ name: "lint", status: "failing", link: "" }] };
  const key = prChecksQuery(api, T, git, undefined).queryKey;

  it("keeps the last checks across a refetch of the same PR", () => {
    const refetched = prChecksQuery(
      api,
      T,
      { ...git, pr: { ...badge, checks: "pending" } },
      undefined,
    );
    expect(keepSamePrChecks(refetched.queryKey)(previous, { queryKey: key })).toBe(previous);
  });

  it("drops them for another PR, another thread, or no PR", () => {
    const bound = { repo: "example/infra", number: 4, monitor: false };
    const rebound = prChecksQuery(api, T, git, bound).queryKey;
    expect(keepSamePrChecks(rebound)(previous, { queryKey: key })).toBeUndefined();
    const other = prChecksQuery(api, "t-2" as ThreadId, git, undefined).queryKey;
    expect(keepSamePrChecks(other)(previous, { queryKey: key })).toBeUndefined();
    const none = prChecksQuery(api, T, undefined, undefined).queryKey;
    expect(keepSamePrChecks(none)(previous, { queryKey: none })).toBeUndefined();
    expect(keepSamePrChecks(key)(previous, undefined)).toBeUndefined();
  });
});
