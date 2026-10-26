import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

/** Small successful-run artifact: file durations only, with failed/retried attempts included. */
export default class E2eTimings {
  files = new Map();

  onBegin(config) {
    this.root = config.rootDir;
  }

  onTestEnd(test, result) {
    const file = relative(this.root, test.location.file).split("\\").join("/");
    this.files.set(file, (this.files.get(file) ?? 0) + result.duration);
  }

  onEnd(result) {
    const files = Object.fromEntries([...this.files].toSorted(([a], [b]) => a.localeCompare(b)));
    const output = resolve(process.env.GRAM_E2E_TIMINGS_FILE ?? "test-results/spec-timings.json");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
      output,
      `${JSON.stringify({ version: 1, status: result.status, wallMs: result.duration, files }, null, 2)}\n`,
    );
    console.log("\nSlowest e2e specs (test/hook time, including retries):");
    for (const [file, ms] of [...this.files].toSorted((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${(ms / 1000).toFixed(1).padStart(6)}s  ${file}`);
    }
  }
}
