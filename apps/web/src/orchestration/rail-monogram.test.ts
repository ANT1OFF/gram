import { describe, expect, it } from "vitest";

import { monograms } from "./rail-monogram";

describe("monograms", () => {
  it("gives each workspace its first letter while none shares it", () => {
    expect(monograms(["billing-api", "Gram", "web", "docs-site"])).toEqual(["B", "G", "W", "D"]);
  });

  it("takes two letters only for the names that share a first letter", () => {
    expect(monograms(["billing-api", "backend", "web"])).toEqual(["BA", "BC", "W"]);
    expect(monograms(["billing-api", "billingWeb", "gram"])).toEqual(["BA", "BW", "G"]);
  });

  it("falls back to a name's second letter when it is one word", () => {
    expect(monograms(["gram", "gateway"])).toEqual(["GR", "GA"]);
  });

  it("keeps one letter for a one-letter name and marks a name with none", () => {
    expect(monograms(["g", "gram", "---"])).toEqual(["G", "GR", "·"]);
  });
});
