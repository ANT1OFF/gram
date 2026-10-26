import { relative } from "node:path";

/** Slow files from the complete JSON report, including hooks, with checkout-relative names. */
export function slowFiles(report, root, limit = 10) {
  return report.testResults
    .map((file) => ({
      file: relative(root, file.name).split("\\").join("/"),
      ms: Math.max(0, file.endTime - file.startTime),
    }))
    .toSorted((a, b) => b.ms - a.ms || a.file.localeCompare(b.file))
    .slice(0, limit);
}
