#!/usr/bin/env node
// Canonical offline entry point. No agent CLI, SDK, network, HOME or account config.
// Regenerate: node packages/agents/scripts/generate-fixtures.mjs
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

// PR #20 owns the five already-invented errors. Reuse their generator unchanged.
await import("./generate-error-fixtures.mjs");

const sources = new URL("./scenarios/", import.meta.url);
const locate = (row, path) => {
  let parent = row;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(parent, key)) throw new Error(`Missing fixture path: ${path.join(".")}`);
    parent = parent[key];
  }
  return [parent, path.at(-1)];
};

for (const name of readdirSync(sources)
  .filter((entry) => entry.endsWith(".jsonl"))
  .toSorted()) {
  const rows = [];
  for (const line of readFileSync(new URL(name, sources), "utf8").trimEnd().split("\n")) {
    const source = JSON.parse(line);
    if (source.copy === undefined) {
      rows.push(source);
      continue;
    }
    if (!Number.isInteger(source.copy) || source.copy < 0 || source.copy >= rows.length) {
      throw new Error(`Invalid fixture copy in ${name}: ${source.copy}`);
    }
    const row = structuredClone(rows[source.copy]);
    for (const [path, index, from] of source.link ?? []) {
      if (!Number.isInteger(index) || index < 0 || index >= rows.length) {
        throw new Error(`Invalid fixture link in ${name}: ${index}`);
      }
      const [parent, key] = locate(row, path);
      const [origin, field] = locate(rows[index], from);
      parent[key] = structuredClone(origin[field]);
    }
    for (const path of source.remove ?? []) {
      const [parent, key] = locate(row, path);
      delete parent[key];
    }
    for (const [path, value] of source.set) {
      const [parent, key] = locate(row, path);
      parent[key] = value;
    }
    rows.push(row);
  }
  const [adapter, fixture] = name.split("--");
  writeFileSync(
    new URL(`../fixtures/${adapter}/${fixture}`, import.meta.url),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}
