import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import E2eTimings from "./e2e-timings.mjs";

it("retains failed attempts in per-file timing and reports the actual run status", () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-e2e-timings-"));
  const output = join(dir, "output", "timings.json");
  const previous = process.env.GRAM_E2E_TIMINGS_FILE;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.GRAM_E2E_TIMINGS_FILE = output;
  try {
    const reporter = new E2eTimings();
    reporter.onBegin({ rootDir: "/invented/e2e" });
    const a = { location: { file: "/invented/e2e/a.spec.ts" } };
    const b = { location: { file: "/invented/e2e/nested/b.spec.ts" } };
    reporter.onTestEnd(a, { duration: 30, status: "failed" });
    reporter.onTestEnd(a, { duration: 20, status: "passed" });
    reporter.onTestEnd(b, { duration: 10, status: "passed" });
    reporter.onEnd({ status: "failed", duration: 100 });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
      version: 1,
      status: "failed",
      wallMs: 100,
      files: { "a.spec.ts": 50, "nested/b.spec.ts": 10 },
    });
    expect(log.mock.calls[1][0]).toContain("a.spec.ts");
  } finally {
    log.mockRestore();
    if (previous === undefined) delete process.env.GRAM_E2E_TIMINGS_FILE;
    else process.env.GRAM_E2E_TIMINGS_FILE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
