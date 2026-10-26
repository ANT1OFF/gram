import type { PrDetailResult, PrStatus } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { keepSamePr, prDetailStamp } from "./pr-detail-query";

const badge = {
  number: 4,
  url: "https://github.com/example/api/pull/4",
  updatedAt: "2026-09-19T10:00:00Z",
  checks: "failing",
} as PrStatus;
const git = { origin: "example/api", pr: badge };

describe("prDetailStamp", () => {
  it("is null without a badge or a bound PR, so nothing is fetched", () => {
    expect(prDetailStamp(undefined, undefined)).toBeNull();
    expect(prDetailStamp({ origin: "example/api" }, undefined)).toBeNull();
  });

  it("changes with the badge", () => {
    expect(prDetailStamp(git, undefined)).not.toBe(
      prDetailStamp({ ...git, pr: { ...badge, checks: "passing" } }, undefined),
    );
  });

  it("changes on every bind, rebind and unbind, even under the same badge", () => {
    const stamps = [
      prDetailStamp(git, undefined),
      prDetailStamp(git, { repo: "example/api", number: 412, monitor: false }),
      prDetailStamp(git, { repo: "example/infra", number: 88, monitor: false }),
      prDetailStamp(git, { repo: "example/infra", number: 4, monitor: false }),
    ];
    expect(new Set(stamps).size).toBe(stamps.length);
    expect(
      prDetailStamp(undefined, { repo: "example/infra", number: 88, monitor: true }),
    ).not.toBeNull();
  });

  it("doesn't carry the branch badge's stamp into a PR bound elsewhere", () => {
    const bound = { repo: "example/infra", number: 88, monitor: false };
    expect(prDetailStamp(git, bound)).toBe(
      prDetailStamp({ ...git, pr: { ...badge, checks: "passing" } }, bound),
    );
  });
});

describe("keepSamePr", () => {
  const previous = {
    available: true,
    detail: { number: 4, url: "https://github.com/example/infra/pull/4" },
  } as PrDetailResult;

  it("keeps the last detail across a refetch of the same PR", () => {
    expect(keepSamePr({ repo: "EXAMPLE/infra", number: 4 })(previous)).toBe(previous);
  });

  it("drops it once the thread targets another PR, so its actions can't hit the wrong one", () => {
    expect(keepSamePr({ repo: "example/infra", number: 88 })(previous)).toBeUndefined();
    expect(keepSamePr({ repo: "example/api", number: 4 })(previous)).toBeUndefined();
    expect(keepSamePr(undefined)(previous)).toBeUndefined();
    expect(keepSamePr({ repo: "example/infra", number: 4 })({ available: true })).toBeUndefined();
  });

  it("drops it after unbinding onto a same-numbered branch PR with no recorded origin", () => {
    // The target comes from the branch badge's URL, so it names example/api even without `origin`.
    expect(keepSamePr({ repo: "example/api", number: 4 }, undefined)(previous)).toBeUndefined();
  });
});
