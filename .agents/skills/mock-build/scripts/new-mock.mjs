#!/usr/bin/env node
// Scaffolds a mock folder and keeps its mock.json, the record of versions and status. Dependency-free.
//
//   node .agents/skills/mock-build/scripts/new-mock.mjs <slug> [--title "…"] [--template options] [--root docs/design/mocks]
//   node .agents/skills/mock-build/scripts/new-mock.mjs <slug> --next      records the next version
//   node .agents/skills/mock-build/scripts/new-mock.mjs <slug> --status in-review
//   node .agents/skills/mock-build/scripts/new-mock.mjs <slug> --approve <n>
//
// It never writes the version pages. The agent writes each vN.html with its Write tool, from the
// template this script names, so the page lands in the workspace's Files view; see ../SKILL.md.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const skill = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const TEMPLATES = ["app-screen", "flow", "options", "components", "landing"];
export const STATUSES = ["draft", "in-review", "approved"];

/** Today's date as YYYY-MM-DD, in local time. */
const today = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** A fresh mock.json record. */
export const newRecord = ({ slug, title, template, date = today() }) => ({
  title,
  slug,
  status: "draft",
  template,
  current: 1,
  approved: null,
  versions: [{ n: 1, file: "v1.html", created: date }],
});

/** `record` with one more version, which becomes current; back to draft unless already approved. */
export const nextVersion = (record, date = today()) => {
  const n = Math.max(0, ...record.versions.map((v) => v.n)) + 1;
  return {
    ...record,
    status: record.status === "approved" ? "approved" : "draft",
    current: n,
    versions: [...record.versions, { n, file: `v${n}.html`, created: date }],
  };
};

/** `record` with version `n` approved. Throws if there is no such version. */
export const approve = (record, n) => {
  if (!record.versions.some((v) => v.n === n)) throw new Error(`No version ${n} in mock.json`);
  return { ...record, status: "approved", approved: n };
};

/** `record` with a new status. */
export const withStatus = (record, status) => {
  if (!STATUSES.includes(status)) throw new Error(`Status must be one of ${STATUSES.join(", ")}`);
  return {
    ...record,
    status,
    approved: status === "approved" ? (record.approved ?? record.current) : record.approved,
  };
};

/** A lowercase, dash-separated folder name. */
export const isSlug = (value) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

/** The tokens.css a new mock copies: the workspace's own when it has one, else the kit's fallback. */
export const tokensSource = (root) => {
  const own = join(root, "tokens.css");
  return existsSync(own) ? own : join(skill, "kit", "tokens.css");
};

const option = (args, name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const stub = (title) => `# ${title}

Written by the design-brief skill before the first version. Keep it short; it is what the mock is
checked against.

## Problem

## Who and where

## Must show

## Out of scope

## Open questions
`;

const decisionsStub = (title) => `# ${title}: decisions

One line per review round: what was asked, what changed, in which version. The mock-review skill
keeps this; the build reads it with the approved version.
`;

/** A path as the user would type it from here. */
const show = (path) => relative(process.cwd(), path) || ".";

const main = (argv) => {
  const args = argv.slice(2);
  const valued = new Set(["--title", "--template", "--root", "--status", "--approve"]);
  const slug = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
  if (slug === undefined || !isSlug(slug)) {
    console.error(
      "Usage: new-mock.mjs <slug> [--title …] [--template …] [--root …] | --next | --status … | --approve <n>",
    );
    return 2;
  }
  const root = resolve(option(args, "--root") ?? "docs/design/mocks");
  const folder = join(root, slug);
  const recordPath = join(folder, "mock.json");
  const save = (record) => writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  const update = args.includes("--next") || args.includes("--status") || args.includes("--approve");
  if (update) {
    if (!existsSync(recordPath)) {
      console.error(`No mock at ${show(folder)}; create it first.`);
      return 1;
    }
    let record = JSON.parse(readFileSync(recordPath, "utf8"));
    if (args.includes("--next")) {
      const previous = record.versions.find((v) => v.n === record.current);
      record = nextVersion(record);
      const file = join(folder, `v${record.current}.html`);
      if (existsSync(file)) throw new Error(`${show(file)} already exists`);
      save(record);
      console.log(
        `Recorded v${record.current}. Read ${show(join(folder, previous?.file ?? "v1.html"))}, then Write ${show(file)} with your changes; never edit an earlier version.`,
      );
      return 0;
    }
    if (args.includes("--approve")) {
      const n = Number.parseInt(option(args, "--approve") ?? "", 10);
      record = approve(record, Number.isNaN(n) ? record.current : n);
    } else {
      record = withStatus(record, option(args, "--status") ?? "");
    }
    save(record);
    console.log(
      `${show(recordPath)}: ${record.status}${record.approved ? `, v${record.approved} approved` : ""}.`,
    );
    return 0;
  }

  const template = option(args, "--template") ?? "app-screen";
  if (!TEMPLATES.includes(template)) {
    console.error(`Template must be one of ${TEMPLATES.join(", ")}`);
    return 2;
  }
  if (existsSync(recordPath)) {
    console.error(`${show(folder)} already exists; use --next for a new version.`);
    return 1;
  }
  const title =
    option(args, "--title") ?? slug.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  mkdirSync(join(folder, "kit"), { recursive: true });
  copyFileSync(tokensSource(root), join(folder, "kit", "tokens.css"));
  for (const file of ["kit.css", "kit.js"])
    copyFileSync(join(skill, "kit", file), join(folder, "kit", file));
  save(newRecord({ slug, title, template }));
  for (const [name, text] of [
    ["brief.md", stub(title)],
    ["decisions.md", decisionsStub(title)],
  ]) {
    if (!existsSync(join(folder, name))) writeFileSync(join(folder, name), text);
  }
  console.log(
    [
      `Created ${show(folder)} with kit/ (tokens from ${show(tokensSource(root))}), mock.json, brief.md and decisions.md.`,
      `Next: Read ${show(join(skill, "templates", `${template}.html`))}, then Write ${show(join(folder, "v1.html"))} from it`,
      `and open it with show_panel preview at ${join(folder, "v1.html")}.`,
    ].join("\n"),
  );
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
