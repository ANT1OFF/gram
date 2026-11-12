#!/usr/bin/env node
// Compares two results files of a headline performance spec and draws them: one row per
// scenario, the earlier run as a full-width track and the later run on the same scale.
//
//   node tools/perf/headline-chart.mjs <before.json> [<after.json>] [--out chart.svg]
//        [--title "…"] [--note "…"] [--light]
//
// With one file it draws that run alone. It always prints a markdown table, for a pull request.
// A scenario is matched by `id`; one that only a single file has is drawn without a comparison.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args.splice(at, 2)[1];
};
const flag = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
};
const out = option("--out");
const title = option("--title");
const note = option("--note");
const light = flag("--light");
const [beforeFile, afterFile] = args;
if (!beforeFile) {
  console.error("usage: headline-chart.mjs <before.json> [<after.json>] [--out chart.svg]");
  process.exit(1);
}
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const before = read(beforeFile);
const after = afterFile ? read(afterFile) : undefined;

const group = (n) => n.toLocaleString("en-US");
/** `2,230 ms`, `9.6 s`, `5.2 MB`: three significant figures at most, in the unit a person says. */
export const format = (value, unit) => {
  if (unit === "bytes") {
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    return `${group(Math.round(value / 1024))} KB`;
  }
  if (value >= 10_000) return `${(value / 1000).toFixed(1)} s`;
  if (value >= 100) return `${group(Math.round(value))} ms`;
  return `${Number(value.toPrecision(2))} ms`;
};
/** `72×`, `2.4×`; under 5% either way is `same`, since a run's noise is about that. */
export const factor = (from, to) => {
  if (!(from > 0) || !(to > 0)) return "";
  const ratio = from / to;
  if (Math.abs(ratio - 1) < 0.05) return "same";
  if (ratio < 1) return `${Number((1 / ratio).toPrecision(2))}× slower`;
  return `${ratio >= 10 ? Math.round(ratio) : Number(ratio.toPrecision(2))}×`;
};

const rows = before.scenarios.map((scenario) => ({
  ...scenario,
  after: after?.scenarios.find((other) => other.id === scenario.id),
}));
for (const scenario of after?.scenarios ?? []) {
  if (!rows.some((row) => row.id === scenario.id)) rows.push({ ...scenario, onlyAfter: true });
}

const table = [
  after
    ? `| Scenario | Before (${before.commit}) | After (${after.commit}) | Change |`
    : `| Scenario | ${before.commit} |`,
  after ? "| --- | ---: | ---: | ---: |" : "| --- | ---: |",
  ...rows.map((row) =>
    after
      ? `| ${row.label} | ${row.onlyAfter ? "" : format(row.value, row.unit)} | ${
          row.onlyAfter
            ? format(row.value, row.unit)
            : row.after
              ? format(row.after.value, row.unit)
              : ""
        } | ${row.after ? factor(row.value, row.after.value) : ""} |`
      : `| ${row.label} | ${format(row.value, row.unit)} |`,
  ),
].join("\n");
console.log(table);

if (out) {
  const ink = light
    ? { surface: "#ffffff", primary: "#111111", muted: "#6b6b6b", track: "#d4d4d4", rule: "#e6e6e6" }
    : { surface: "#000000", primary: "#ffffff", muted: "#8a8a8a", track: "#3a3a3a", rule: "#1f1f1f" };
  const W = 1240;
  const PAD = 32;
  const ROW = 64;
  const HEAD = 96;
  const FOOT = 64;
  const H = HEAD + rows.length * ROW + FOOT;
  const BAR_X = 500;
  const BAR_W = 280;
  const VALUE_X = BAR_X + BAR_W + 28;
  const escape = (text) =>
    String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const font = "font-family=\"Inter, 'Helvetica Neue', Arial, sans-serif\"";
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(title ?? "Performance, before and after")}">`,
    `<rect width="${W}" height="${H}" fill="${ink.surface}"/>`,
    `<text x="${PAD}" y="60" ${font} font-size="34" font-weight="600" fill="${ink.primary}">${escape(
      title ?? (after ? "Before and after" : "Baseline"),
    )}</text>`,
    note
      ? `<text x="${W - PAD}" y="60" text-anchor="end" ${font} font-size="16" fill="${ink.muted}">${escape(note)}</text>`
      : "",
  ];
  rows.forEach((row, index) => {
    const top = HEAD + index * ROW;
    const middle = top + ROW / 2;
    const from = row.onlyAfter ? undefined : row.value;
    const to = row.onlyAfter ? row.value : row.after?.value;
    const scale = Math.max(from ?? 0, to ?? 0) || 1;
    parts.push(`<rect x="${PAD}" y="${top}" width="${W - 2 * PAD}" height="1" fill="${ink.rule}"/>`);
    parts.push(
      `<text x="${PAD}" y="${middle + 7}" ${font} font-size="20" fill="${ink.primary}">${escape(row.label)}</text>`,
    );
    if (from !== undefined) {
      const width = Math.max(4, (from / scale) * BAR_W);
      parts.push(
        `<rect x="${BAR_X}" y="${middle - (to === undefined ? 3 : 9)}" width="${width}" height="5" rx="2.5" fill="${after ? ink.track : ink.primary}"/>`,
      );
    }
    if (to !== undefined) {
      const width = Math.max(4, (to / scale) * BAR_W);
      parts.push(
        `<rect x="${BAR_X}" y="${middle + (from === undefined ? -3 : 3)}" width="${width}" height="5" rx="2.5" fill="${ink.primary}"/>`,
      );
    }
    const values =
      from !== undefined && to !== undefined
        ? `<tspan fill="${ink.muted}">${escape(format(from, row.unit))} → </tspan><tspan fill="${ink.primary}" font-weight="600">${escape(format(to, row.unit))}</tspan>`
        : `<tspan fill="${ink.primary}" font-weight="600">${escape(format(from ?? to, row.unit))}</tspan>`;
    parts.push(`<text x="${VALUE_X}" y="${middle + 6}" ${font} font-size="17">${values}</text>`);
    if (from !== undefined && to !== undefined) {
      parts.push(
        `<text x="${W - PAD}" y="${middle + 9}" text-anchor="end" ${font} font-size="26" font-weight="600" fill="${ink.primary}">${escape(factor(from, to))}</text>`,
      );
    }
  });
  const base = HEAD + rows.length * ROW;
  parts.push(`<rect x="${PAD}" y="${base}" width="${W - 2 * PAD}" height="1" fill="${ink.rule}"/>`);
  if (after) {
    parts.push(
      `<rect x="${PAD}" y="${base + 30}" width="26" height="5" rx="2.5" fill="${ink.track}"/>`,
      `<text x="${PAD + 36}" y="${base + 38}" ${font} font-size="14" fill="${ink.muted}">before (${escape(before.commit)})</text>`,
      `<rect x="${PAD + 190}" y="${base + 30}" width="26" height="5" rx="2.5" fill="${ink.primary}"/>`,
      `<text x="${PAD + 226}" y="${base + 38}" ${font} font-size="14" fill="${ink.muted}">now (${escape(after.commit)}), each row drawn to its own scale</text>`,
    );
  } else {
    parts.push(
      `<text x="${PAD}" y="${base + 38}" ${font} font-size="14" fill="${ink.muted}">medians at ${escape(before.commit)}; each row is its own measure</text>`,
    );
  }
  parts.push(
    `<text x="${W - PAD}" y="${base + 38}" text-anchor="end" ${font} font-size="14" fill="${ink.muted}">${escape((after ?? before).machine ?? "")}</text>`,
    "</svg>",
  );
  writeFileSync(out, `${parts.filter(Boolean).join("\n")}\n`);
  console.error(`chart written to ${out}`);
}
