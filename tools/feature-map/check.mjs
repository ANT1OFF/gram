#!/usr/bin/env node
// Holds docs/features.json to the tree, so the map agents start from cannot rot silently. Each
// feature's `code`, `tests` and `docs` globs must match at least one file in the repository, and a
// docs path written `file.md#heading` must name a heading that file still has. Source folders no
// feature owns (each package and app, and each folder of the web app's and the server's `src`)
// are reported, not failed.
//
//   node tools/feature-map/check.mjs
//
// Globs are relative to the repository root: `*` and `?` stay inside one path segment, `**` crosses
// them, `{a,b}` is either. A path with no wildcard matches that file or anything under that folder.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAP = "docs/features.json";
const SOURCE_FOLDERS = [
  /^((?:apps|packages)\/[^/]+)\//,
  /^((?:apps\/web|packages\/server)\/src\/[^/]+)\//,
];

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: REPO,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter(Boolean);

/** @param {string} glob */
const globPattern = (glob) => {
  if (!/[*?{]/.test(glob)) {
    const plain = glob.replace(/\/$/, "");
    return { test: (/** @type {string} */ file) => file === plain || file.startsWith(`${plain}/`) };
  }
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") {
        i += 1;
        source += "(?:.*/)?";
      } else source += ".*";
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "{") source += "(?:";
    else if (char === "}") source += ")";
    else if (char === ",") source += "|";
    else source += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
};

// Headings as GitHub slugs them, as tools/check-docs.mjs reads them.
/** @param {string} body */
const headings = (body) => {
  const found = new Set();
  const counts = new Map();
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? undefined : /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const slug = heading
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .replace(/\s/g, "-");
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    found.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return found;
};

/** @type {{ features: Array<{ name: string, purpose: string, code?: string[], tests?: string[], docs?: string[] }> }} */
const map = JSON.parse(readFileSync(join(REPO, MAP), "utf8"));

const problems = [];
const names = new Set();
const owned = new Set();
for (const feature of map.features) {
  const where = `"${feature.name}"`;
  if (names.has(feature.name)) problems.push(`${where}: listed twice; merge the two entries.`);
  names.add(feature.name);
  if (!feature.name || !feature.purpose) {
    problems.push(`${where}: needs a name and a one-line purpose, in the app's own words.`);
  }
  for (const field of /** @type {const} */ (["code", "tests", "docs"])) {
    const globs = feature[field] ?? [];
    if (field !== "tests" && globs.length === 0) {
      problems.push(`${where}: lists no ${field}; name at least one path.`);
    }
    for (const entry of globs) {
      const [glob, anchor] = entry.split("#");
      const pattern = globPattern(glob);
      const matched = files.filter((file) => pattern.test(file));
      if (matched.length === 0) {
        problems.push(
          `${where}: ${field} "${glob}" matches no file. The code moved or was removed: point the glob at where it lives now, or drop it.`,
        );
        continue;
      }
      if (anchor && !headings(readFileSync(join(REPO, glob), "utf8")).has(anchor)) {
        problems.push(
          `${where}: ${glob} has no heading #${anchor}. The section was renamed or moved: use its current heading's slug.`,
        );
      }
      if (field === "code") for (const file of matched) owned.add(file);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(
    `\n${problems.length} stale entr(y/ies) in ${MAP}. The feature map is where agents start to find the code, tests and docs for a feature, so a path that matches nothing sends them nowhere: fix the entry in the same change that moved the code.`,
  );
  process.exit(1);
}

const folders = new Set();
for (const file of files) {
  for (const level of SOURCE_FOLDERS) {
    const folder = level.exec(file)?.[1];
    if (folder) folders.add(folder);
  }
}
const unowned = [...folders].filter(
  (folder) => ![...owned].some((file) => file.startsWith(`${folder}/`)),
);
console.log(`Feature map: ${map.features.length} features, every path matches.`);
if (unowned.length > 0) {
  console.log(
    `  Owned by no feature (add an entry if agents will ask for it): ${unowned.join(", ")}`,
  );
}
