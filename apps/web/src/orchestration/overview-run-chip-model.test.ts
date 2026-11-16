import { describe, expect, it } from "vitest";

import { runChipOf } from "./overview-run-chip-model";

describe("runChipOf", () => {
  it("draws nothing for no runs", () => {
    expect(runChipOf([])).toBeUndefined();
  });

  it("names one run on its hover and opens it, by its id when the watch has no link", () => {
    const run = { repo: "acme/app", runId: 4411, name: "Application checks: fix the parser" };
    expect(runChipOf([{ ...run, url: "https://github.com/acme/app/actions/runs/4411" }])).toEqual({
      count: 1,
      label:
        "Watching a workflow run: Application checks: fix the parser (acme/app #4411), running",
      hint: "Watching a workflow run · running\nApplication checks: fix the parser (acme/app #4411)",
      url: "https://github.com/acme/app/actions/runs/4411",
    });
    expect(runChipOf([{ repo: "acme/app", runId: 7 }])).toMatchObject({
      hint: "Watching a workflow run · running\nWorkflow run (acme/app #7)",
      url: "https://github.com/acme/app/actions/runs/7",
    });
  });

  it("folds several into one chip with a count, a line each on its hover", () => {
    const chip = runChipOf([
      { repo: "acme/app", runId: 1, name: "Build: linux" },
      { repo: "acme/app", runId: 2, name: "Build: macOS" },
    ]);
    expect(chip).toMatchObject({
      count: 2,
      hint: "Watching 2 workflow runs · running\nBuild: linux (acme/app #1)\nBuild: macOS (acme/app #2)",
      // One repo's: its Actions page, where both are.
      url: "https://github.com/acme/app/actions",
    });
    // In two repos: the first's own page.
    expect(
      runChipOf([
        { repo: "acme/app", runId: 1, url: "https://github.com/acme/app/actions/runs/1" },
        { repo: "acme/api", runId: 2 },
      ])?.url,
    ).toBe("https://github.com/acme/app/actions/runs/1");
  });
});
