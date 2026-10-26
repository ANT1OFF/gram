import { describe, expect, it } from "vitest";

import { autoUpdateCheckEnabled } from "./policy.ts";

describe("autoUpdateCheckEnabled", () => {
  const repoConfigured = true;

  it("checks in packaged builds outside CI", () => {
    expect(autoUpdateCheckEnabled({ packaged: true, smoke: false, repoConfigured, env: {} })).toBe(
      true,
    );
    expect(
      autoUpdateCheckEnabled({ packaged: true, smoke: false, repoConfigured, env: { CI: "true" } }),
    ).toBe(false);
    expect(autoUpdateCheckEnabled({ packaged: false, smoke: false, repoConfigured, env: {} })).toBe(
      false,
    );
  });

  it("never checks in a smoke run, even when forced", () => {
    const env = { GRAM_UPDATE_CHECK: "1" };
    expect(autoUpdateCheckEnabled({ packaged: true, smoke: true, repoConfigured, env })).toBe(
      false,
    );
  });

  it("never checks without a releases repo, even when forced", () => {
    const env = { GRAM_UPDATE_CHECK: "1" };
    expect(
      autoUpdateCheckEnabled({ packaged: true, smoke: false, repoConfigured: false, env }),
    ).toBe(false);
  });

  it("honours the override", () => {
    expect(
      autoUpdateCheckEnabled({
        packaged: false,
        smoke: false,
        repoConfigured,
        env: { GRAM_UPDATE_CHECK: "1" },
      }),
    ).toBe(true);
    expect(
      autoUpdateCheckEnabled({
        packaged: true,
        smoke: false,
        repoConfigured,
        env: { GRAM_UPDATE_CHECK: "0" },
      }),
    ).toBe(false);
  });
});
