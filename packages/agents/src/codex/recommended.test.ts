import { readFileSync } from "node:fs";
import { RECOMMENDED, TIERS, tierEffort } from "@gram/contracts";
import { describe, expect, it } from "vitest";
import { parseCatalog } from "./catalog.ts";
import { CODEX_CLI_VERSION } from "./version.ts";

// `codex debug models --bundled` from the pinned Codex, with its long strings cut short.
const bundled = parseCatalog(
  readFileSync(
    new URL(
      `../../fixtures/codex-catalog/debug-models-bundled-${CODEX_CLI_VERSION.replace(/\.0$/, "")}.json`,
      import.meta.url,
    ),
    "utf8",
  ),
)!;

describe("the recommended Codex models", () => {
  it("are listed, current models of the pinned CLI at their tier's effort", () => {
    for (const tier of TIERS) {
      const pick = RECOMMENDED.tiers[tier].codex;
      // A newly released account model can precede the pinned CLI's bundled catalogue. Its
      // first available fallback must still be a current model that supports the tier's effort.
      const first = pick.models
        .map((slug) => bundled.models.find((entry) => entry.slug === slug))
        .find(Boolean);
      expect(first, `${tier}: ${pick.models[0]}`).toMatchObject({
        visibility: "list",
        upgrade: null,
      });
      for (const slug of pick.models) {
        const entry = bundled.models.find((candidate) => candidate.slug === slug);
        if (entry === undefined) {
          // Released after 0.166.0's bundle; an account's live catalogue supplies these.
          expect(["gpt-6.2-sol", "gpt-6.2-astra"], `${tier}: ${slug}`).toContain(slug);
          continue;
        }
        const levels = (
          entry!["supported_reasoning_levels"] as ReadonlyArray<{ effort: string }>
        ).map((level) => level.effort);
        expect(levels, `${tier}: ${slug}`).toContain(tierEffort(RECOMMENDED, tier, "codex"));
      }
    }
  });
});
