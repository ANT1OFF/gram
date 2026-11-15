import { expect, it } from "vitest";

import { failedFiles, flakyReport, RERUN_LIMIT, shouldRerun } from "./rerun.mjs";

const report = {
  testResults: [
    { name: "/repo/a.test.ts", status: "passed", assertionResults: [{ status: "passed" }] },
    {
      name: "/repo/b.test.ts",
      status: "failed",
      assertionResults: [
        { status: "passed", fullName: "b keeps" },
        { status: "failed", fullName: "b > races, sometimes" },
      ],
    },
    { name: "/repo/c.test.ts", status: "failed", assertionResults: [] },
  ],
};

it("lists the failed files with their failed tests, relative to the checkout", () => {
  expect(failedFiles(report, "/repo")).toEqual([
    { path: "/repo/b.test.ts", file: "b.test.ts", tests: ["b > races, sometimes"] },
    { path: "/repo/c.test.ts", file: "c.test.ts", tests: [] },
  ]);
});

it("reruns a few failed files, and never many: that is a break", () => {
  const one = { path: "/x", file: "x", tests: [] };
  expect(shouldRerun([])).toBe(false);
  expect(shouldRerun([one])).toBe(true);
  expect(shouldRerun(Array.from({ length: RERUN_LIMIT }, () => one))).toBe(true);
  expect(shouldRerun(Array.from({ length: RERUN_LIMIT + 1 }, () => one))).toBe(false);
});

it("names each flaky test as a warning on its file, escaped for the workflow command", () => {
  const { lines, summary } = flakyReport(failedFiles(report, "/repo"));
  expect(lines).toEqual([
    "::warning file=b.test.ts,title=Flaky test::b > races, sometimes failed, then passed when its file ran again",
    "::warning file=c.test.ts,title=Flaky test::(the file itself) failed, then passed when its file ran again",
  ]);
  expect(summary).toContain("- `b.test.ts` › b > races, sometimes");
  expect(flakyReport([{ file: "d,e.ts", tests: ["50%\nlater"] }]).lines[0]).toBe(
    "::warning file=d%2Ce.ts,title=Flaky test::50%25%0Alater failed, then passed when its file ran again",
  );
});
