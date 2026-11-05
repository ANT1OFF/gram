#!/usr/bin/env node
// Design-token drift check for the web UI (DESIGN.md → Tokens).
//
// Flags, in apps/web/src: text sizes outside the type scale (Tailwind's own `text-xs` … `text-9xl`
// and arbitrary `text-[13px]`), raw arbitrary spacing (`p-[7px]`, `gap-[2px]`), raw radii
// (`rounded-[6px]`, Tailwind's literal `rounded`, `rounded-2xl` and up), Tailwind's own shadows
// (`shadow-md`), and colours that skip the palette (`#hex`, `bg-[rgb(…)]`, `bg-black/75`).
// Arbitrary values built from tokens (`p-[max(--spacing(2),var(--x))]`) pass.
//
// Existing violations are counted per file and token in `allowlist.json`; only what goes beyond
// those counts is reported. The allowlist only shrinks: when a file has fewer than its count, the
// check says so, and `--write` records the current counts. Its `mode` is `warn` (report, exit 0)
// or `error` (exit 1 on anything new or stale).
//
//   node tools/design-tokens/check.mjs          check
//   node tools/design-tokens/check.mjs --write  record the current counts (review the diff)

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ALLOWLIST = join(REPO, "tools/design-tokens/allowlist.json");
const ROOT = "apps/web/src/";

// A class token starts after whitespace, a quote, a variant's colon, `!`, or an opening bracket, and
// ends at whitespace, a quote, a closing bracket, a comma or an opacity/line-height `/`.
const B = String.raw`(?<=^|[\s"'\x60:!{(,])`;
const E = String.raw`(?=$|[\s"'\x60}),/])`;
const LENGTH = String.raw`-?\d*\.?\d+(?:px|rem|em)`;
const SIDES = "(?:-(?:t|r|b|l|s|e|x|y|tl|tr|br|bl|ss|se|es|ee))?";
const SPACING =
  "(?:-?(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|right|bottom|left|start|end))";
const COLOR_UTILS =
  "(?:text|bg|border(?:-[trblxyse])?|ring|ring-offset|outline|fill|stroke|from|via|to|decoration|divide|accent|caret|placeholder|shadow)";
const TW_PALETTE =
  "(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3})";

/** Each rule: an id, what it matches in a class string, and what to use instead. */
export const RULES = [
  {
    id: "text-size",
    pattern: new RegExp(
      String.raw`${B}text-(?:xs|sm|base|lg|[2-9]?xl|\[${LENGTH}\]|\(length:[^)]*\))${E}`,
      "g",
    ),
    hint: (token) =>
      ({
        "text-xs": "text-meta (12/16)",
        "text-sm": "text-reading (14/20) for content, text-body (13/20) for UI",
        "text-base": "text-title (16/24)",
        "text-lg": "text-title or text-heading",
        "text-xl": "text-heading (20/28)",
      })[token] ??
      "a type step: text-caption, -meta, -body, -body-strong, -reading, -title, -heading",
  },
  {
    id: "spacing",
    pattern: new RegExp(String.raw`${B}${SPACING}-\[${LENGTH}\]${E}`, "g"),
    hint: () => "a 4 px step (p-1 is 4 px) or a named one: tight, inset, list, section",
  },
  {
    id: "radius",
    pattern: new RegExp(String.raw`${B}rounded${SIDES}(?:-\[${LENGTH}\]|-(?:[2-4]xl))?${E}`, "g"),
    hint: () => "a radius token: rounded-2xs (4), -xs (8), -sm (12), -md (14), -lg, -xl, -full",
  },
  {
    id: "shadow",
    pattern: new RegExp(
      String.raw`${B}shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|card|popover))?${E}|${B}shadow-\[[^\]\s]*(?:rgb|hsl|#)[^\]\s]*\]${E}`,
      "g",
    ),
    hint: () => "an elevation: shadow-raised, shadow-overlay or shadow-composer",
  },
  {
    id: "color",
    pattern: new RegExp(
      String.raw`${B}${COLOR_UTILS}-\[(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch)\()[^\]\s]*\]${E}|${B}${COLOR_UTILS}-${TW_PALETTE}${E}|["'\x60]#[0-9a-fA-F]{3,8}["'\x60]`,
      "g",
    ),
    hint: () => "a palette token (fg, fg-muted, surface-*, accent, status colours)",
  },
];

/**
 * Hex colours written in stylesheets; the generated theme is where they belong. A mask layer's
 * `linear-gradient(#fff 0 0)` is exempt: only its alpha counts, so it is no colour at all.
 */
const CSS_HEX = /(?<![\w&-])(?<!linear-gradient\()#[0-9a-fA-F]{3,8}\b/g;

const isScanned = (file) =>
  file.startsWith(ROOT) &&
  /\.(tsx?|css)$/.test(file) &&
  !/\.test\.tsx?$/.test(file) &&
  // Mock data (seeded label colours, fixture SVGs) is not UI.
  !file.startsWith(`${ROOT}api/mock`) &&
  !/\/mock(?:-[\w-]+)?\.tsx?$/.test(file) &&
  !file.startsWith(`${ROOT}styles/generated/`) &&
  !file.endsWith("routeTree.gen.ts");

/** Line comments and block comments, blanked so a token named in prose isn't counted. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\/|(?<![:"'\x60\w])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));

/** Every violation in one file's source: `{ rule, token, line }`. */
export function scan(source, file = "x.tsx") {
  const text = stripComments(source);
  const found = [];
  const lineAt = (index) => text.slice(0, index).split("\n").length;
  const rules = file.endsWith(".css")
    ? [{ id: "color", pattern: CSS_HEX }]
    : RULES.map(({ id, pattern }) => ({ id, pattern }));
  for (const { id, pattern } of rules) {
    for (const match of text.matchAll(pattern)) {
      found.push({
        rule: id,
        token: match[0].replace(/^["'\x60]|["'\x60]$/g, ""),
        line: lineAt(match.index),
      });
    }
  }
  return found;
}

const key = (v) => `${v.rule} ${v.token}`;

function tally(violations) {
  const counts = {};
  for (const v of violations) counts[key(v)] = (counts[key(v)] ?? 0) + 1;
  return counts;
}

/** Compares a tree's violations with the allowlist: what's new and what can come off it. */
export function compare(byFile, allowed) {
  const added = [];
  const stale = [];
  const files = new Set([...Object.keys(byFile), ...Object.keys(allowed)]);
  for (const file of [...files].toSorted()) {
    const counts = tally(byFile[file] ?? []);
    const limits = allowed[file] ?? {};
    for (const [k, n] of Object.entries(counts)) {
      const limit = limits[k] ?? 0;
      if (n > limit) {
        for (const v of byFile[file].filter((x) => key(x) === k))
          added.push({ file, ...v, n, limit });
      }
    }
    for (const [k, limit] of Object.entries(limits)) {
      if ((counts[k] ?? 0) < limit) stale.push({ file, key: k, n: counts[k] ?? 0, limit });
    }
  }
  return { added, stale };
}

function scanTree() {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", ROOT],
    {
      cwd: REPO,
      encoding: "utf8",
    },
  )
    .split("\n")
    .filter(isScanned);
  const byFile = {};
  for (const file of files) {
    let source;
    try {
      source = readFileSync(join(REPO, file), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    const found = scan(source, file);
    if (found.length) byFile[file] = found;
  }
  return byFile;
}

function main() {
  const list = JSON.parse(readFileSync(ALLOWLIST, "utf8"));
  const byFile = scanTree();
  if (process.argv.includes("--write")) {
    const files = {};
    for (const file of Object.keys(byFile).toSorted()) {
      const counts = tally(byFile[file]);
      files[file] = Object.fromEntries(
        Object.entries(counts).toSorted(([a], [b]) => a.localeCompare(b)),
      );
    }
    writeFileSync(ALLOWLIST, `${JSON.stringify({ ...list, files }, null, 2)}\n`);
    const total = Object.values(files).reduce(
      (s, c) => s + Object.values(c).reduce((a, b) => a + b, 0),
      0,
    );
    console.log(
      `design tokens: recorded ${total} allowlisted uses in ${Object.keys(files).length} files`,
    );
    return;
  }
  const { added, stale } = compare(byFile, list.files ?? {});
  const strict = list.mode === "error";
  const label = strict ? "error" : "warning";
  for (const v of added) {
    const rule = RULES.find((r) => r.id === v.rule);
    const hint = rule ? rule.hint(v.token) : "a palette token";
    console.log(`${v.file}:${v.line}: ${label} design-tokens/${v.rule}: ${v.token} (use ${hint})`);
  }
  for (const s of stale) {
    console.log(
      `${s.file}: ${label} design-tokens: ${s.key} is allowlisted ${s.limit}× but used ${s.n}×; run \`node tools/design-tokens/check.mjs --write\``,
    );
  }
  if (added.length || stale.length) {
    console.log(
      `design tokens: ${added.length} new, ${stale.length} stale allowlist entries (${list.mode} mode; DESIGN.md → Tokens)`,
    );
  }
  if (strict && (added.length || stale.length)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
