import { describe, expect, it } from "vitest";

import { driversCovering, parseVerifyRecipe, pathMatches } from "./verify-recipe.ts";

const recipe = (drivers: unknown) => JSON.stringify({ drivers });

describe("parseVerifyRecipe", () => {
  it("reads drivers, trimming commands and keeping only what is given", () => {
    expect(
      parseVerifyRecipe(
        recipe([
          { name: "unit", run: "  bun run test  " },
          {
            name: "shots",
            run: "bun run shots",
            covers: ["apps/web/**"],
            kind: "shots",
            required: true,
            timeoutMinutes: 20,
          },
        ]),
      ),
    ).toEqual({
      drivers: [
        { name: "unit", run: "bun run test" },
        {
          name: "shots",
          run: "bun run shots",
          covers: ["apps/web/**"],
          kind: "shots",
          required: true,
          timeoutMinutes: 20,
        },
      ],
    });
  });

  it.each([
    ["{", "isn't valid JSON"],
    ["{}", 'has no "drivers" list'],
    [recipe([{ name: "unit" }]), 'needs a "name" and a "run"'],
    [recipe([{ name: "Unit Tests", run: "x" }]), "lowercase"],
    [
      recipe([
        { name: "a", run: "x" },
        { name: "a", run: "y" },
      ]),
      "already a driver named a",
    ],
    [recipe([{ name: "a", run: "x\ny" }]), "on one line"],
    [recipe([{ name: "a", run: "x", covers: ["../outside/**"] }]), "inside the repository"],
    [recipe([{ name: "a", run: "x", covers: ["/abs/**"] }]), "relative to the repository"],
    [recipe([{ name: "a", run: "x", kind: "smoke" }]), '"kind" is one of'],
    [recipe([{ name: "a", run: "x", timeoutMinutes: 0 }]), '"timeoutMinutes"'],
    [recipe([{ name: "a", run: "x", timeoutMinutes: 121 }]), '"timeoutMinutes"'],
  ])("refuses %s", (text, message) => {
    const parsed = parseVerifyRecipe(text);
    expect("error" in parsed && parsed.error).toContain(message);
  });
});

describe("pathMatches", () => {
  it.each([
    ["apps/web/**", "apps/web/src/a.tsx", true],
    ["apps/web/**", "apps/webby/a.ts", false],
    ["apps/web/", "apps/web/src/a.tsx", true],
    ["src/**/a.ts", "src/a.ts", true],
    ["src/**/a.ts", "src/x/y/a.ts", true],
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", false],
    ["**/*.md", "docs/README.md", true],
    ["a.b", "axb", false],
  ])("%s against %s is %s", (pattern, path, expected) => {
    expect(pathMatches(pattern, path)).toBe(expected);
  });
});

describe("driversCovering", () => {
  const drivers = [
    { name: "unit", run: "t" },
    { name: "shots", run: "s", covers: ["apps/web/**"] },
    { name: "rust", run: "r", covers: ["services/**", "Cargo.toml"] },
  ];

  it("picks drivers by their patterns, and those without patterns for any change", () => {
    expect(driversCovering(drivers, ["apps/web/src/a.tsx"]).map((d) => d.name)).toEqual([
      "unit",
      "shots",
    ]);
    expect(driversCovering(drivers, ["Cargo.toml"]).map((d) => d.name)).toEqual(["unit", "rust"]);
  });

  it("covers nothing when nothing changed", () => {
    expect(driversCovering(drivers, [])).toEqual([]);
  });
});
