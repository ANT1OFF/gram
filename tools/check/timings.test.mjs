import { expect, it } from "vitest";

import { slowFiles } from "./timings.mjs";

it("reports file wall time including hooks, rather than summed assertions", () => {
  const report = {
    testResults: [
      { name: "/repo/fast.test.ts", startTime: 100, endTime: 120 },
      {
        name: "/repo/slow.test.ts",
        startTime: 200,
        endTime: 500,
        assertionResults: [{ duration: 1 }],
      },
    ],
  };
  expect(slowFiles(report, "/repo", 1)).toEqual([{ file: "slow.test.ts", ms: 300 }]);
});
