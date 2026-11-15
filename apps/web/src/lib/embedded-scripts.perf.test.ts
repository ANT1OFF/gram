import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canHighlightCode, highlightCode, type TokenizedCode } from "./code-highlighting";
import { paintEmbedded } from "./command-tokens";
import { embeddedScripts } from "./embedded-scripts";

// What colouring the scripts inside a shell command costs on the main thread: reading the command
// for its scripts and painting their tokens over the command's own run during render, and Shiki's
// tokenizing of each script runs beside it. Commands are at the size bound `canHighlightCode`
// allows (16 kB, 500 lines), the largest a command card ever reads. Opt in with
// GRAM_PERF_HIGHLIGHT=1; `GRAM_PERF_OUT` names the JSON results file, which
// `tools/perf/headline-chart.mjs` compares. `GRAM_PERF_REPEATS` sets the samples behind each median.
const PERF = process.env["GRAM_PERF_HIGHLIGHT"] === "1";
const OUT_FILE = process.env["GRAM_PERF_OUT"] ?? join(tmpdir(), "gram-perf-highlight.json");
const REPEATS = Number(process.env["GRAM_PERF_REPEATS"] ?? 15);

interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly unit: "ms";
  readonly value: number;
  readonly samples: readonly number[];
  readonly detail?: Readonly<Record<string, number | string>>;
}
const scenarios: Scenario[] = [];
const median = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const round = (n: number) => Number(n.toFixed(2));

const time = (run: () => void) => {
  run();
  const samples: number[] = [];
  for (let index = 0; index < REPEATS; index += 1) {
    const started = performance.now();
    run();
    samples.push(round(performance.now() - started));
  }
  return samples;
};

const tokenized = (code: string, language: string) =>
  new Promise<TokenizedCode>((resolve) => {
    const cached = highlightCode(code, language as never, resolve);
    if (cached) resolve(cached);
  });

const pythonLines = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `    total += values[${index}] * weight  # step ${index} of the fold`,
  );

/** Commands at the bound, each shaped like one the reader handles differently. */
const COMMANDS: Readonly<Record<string, { label: string; command: string }>> = {
  heredoc: {
    label: "a 16 kB python here-doc",
    command: [
      "python3 - <<'PY'",
      "values = list(range(1000))",
      "total = 0",
      "for weight in range(3):",
      ...pythonLines(240),
      "print(total)",
      "PY",
    ].join("\n"),
  },
  nested: {
    label: "a command nested four levels deep",
    command: [
      `zsh -lc "ssh build-host 'cd /srv && python3 - <<PY`,
      ...pythonLines(200),
      `PY'"`,
    ].join("\n"),
  },
  many: {
    label: "32 inline scripts on one command line each",
    command: Array.from(
      { length: 120 },
      (_, index) =>
        `node -e "console.log(${index} + process.argv.length)" && python3 -c 'print(${index} * 2)'`,
    ).join("\n"),
  },
  written: {
    label: "a 500-line file written with cat",
    command: [
      "cat > src/generated.ts <<'EOF'",
      ...Array.from(
        { length: 498 },
        (_, index) => `export const value${index} = ${index}; // line ${index}`,
      ),
      "EOF",
    ]
      .join("\n")
      .slice(0, 16_000),
  },
  unterminated: {
    label: "unterminated quotes and substitutions",
    command: Array.from(
      { length: 400 },
      (_, index) => `echo "$(cat <<X ${index} 'open \`tick $(( ${index}`,
    ).join("\n"),
  },
};

describe.skipIf(!PERF)("embedded scripts in commands", () => {
  afterAll(() => {
    writeFileSync(OUT_FILE, `${JSON.stringify({ scenarios }, null, 2)}\n`);
    console.log(`wrote ${OUT_FILE}`);
  });

  for (const [id, { label, command }] of Object.entries(COMMANDS)) {
    it(`reads and paints ${label}`, async () => {
      expect(canHighlightCode(command)).toBe(true);
      const read = time(() => embeddedScripts(command));
      const scripts = embeddedScripts(command);

      const started = performance.now();
      const outer = await tokenized(command, "shellscript");
      const layers = await Promise.all(
        scripts.map(async (script) => ({
          script,
          tokens: await tokenized(script.text, script.language),
        })),
      );
      const tokenizeMs = round(performance.now() - started);
      const paint = time(() => paintEmbedded(command, outer, layers));

      const detail = {
        kilobytes: round(command.length / 1024),
        scripts: scripts.length,
        firstTokenizeMs: tokenizeMs,
      };
      scenarios.push({
        id: `read-${id}`,
        label: `Read ${label} for its scripts`,
        unit: "ms",
        value: round(median(read)),
        samples: read,
        detail,
      });
      scenarios.push({
        id: `paint-${id}`,
        label: `Paint the scripts in ${label}`,
        unit: "ms",
        value: round(median(paint)),
        samples: paint,
        detail,
      });
      console.log(
        `${label}: read ${median(read)} ms, paint ${median(paint)} ms, ${JSON.stringify(detail)}`,
      );
    }, 120_000);
  }
});
