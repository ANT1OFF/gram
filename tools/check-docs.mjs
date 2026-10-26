#!/usr/bin/env node
// Offline checks for this repository's authored Markdown subset; no provider/network access.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath, { dirname, join, resolve, win32 } from "node:path";
import { textBoundaryIssues } from "./scaffold-boundaries.mjs";

const withoutFences = (body) => {
  let fence;
  return body
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && !fence) fence = marker[0];
      else if (marker && marker[0] === fence) fence = undefined;
      else if (!fence) return line;
      return "";
    })
    .join("\n");
};

const anchors = (body) => {
  const found = new Set();
  const counts = new Map();
  for (const line of withoutFences(body).split("\n")) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line)?.[1];
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
  for (const match of withoutFences(body).matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) {
    found.add(match[1]);
  }
  return found;
};

const scriptFor = (root, workspace, name) => {
  const manifest = join(root, workspace ?? "", "package.json");
  if (!existsSync(manifest) || !isWithin(realpathSync(root), realpathSync(manifest))) return false;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (Object.hasOwn(pkg.scripts ?? {}, name)) return true;
  // These documented build/test executables are pinned workspace dependencies, not scripts.
  const bins = { playwright: "@playwright/test", "electron-builder": "electron-builder" };
  const dependency = bins[name];
  return (
    dependency !== undefined &&
    Object.hasOwn({ ...pkg.dependencies, ...pkg.devDependencies }, dependency)
  );
};

const isWithin = (root, candidate, pathApi = nodePath) => {
  const fromRoot = pathApi.relative(root, candidate);
  return (
    !pathApi.isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${pathApi.sep}`)
  );
};
const unescapeMarkdown = (value) =>
  value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, "$1");
const referenceKey = (value) => unescapeMarkdown(value).trim().replace(/\s+/g, " ").toLowerCase();

// Read angle destinations (including spaces) or balanced bare destinations. Keep
// the entire destination: dropping a second '#' can qualify a nonexistent anchor.
const destinationAt = (text, start) => {
  let index = start;
  while (/\s/.test(text[index] ?? "") && index < text.length) index++;
  const beginning = index;
  if (text[index] === "<") {
    index++;
    const valueStart = index;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index] === ">") {
        return { target: unescapeMarkdown(text.slice(valueStart, index)), end: index + 1 };
      } else if (text[index] === "\n" || text[index] === "<") break;
      else index++;
    }
    return undefined;
  }
  let depth = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") index += 2;
    else if (character === "(") {
      depth++;
      index++;
    } else if (character === ")") {
      if (!depth) break;
      depth--;
      index++;
    } else if (/\s/.test(character)) break;
    else index++;
  }
  if (depth) return undefined;
  return { target: unescapeMarkdown(text.slice(beginning, index)), end: index };
};

const linkEnd = (text, start, inline) => {
  let index = start;
  while (/\s/.test(text[index] ?? "") && index < text.length) index++;
  // Optional quoted/parenthesized title; it must be separated from a destination.
  if (index > start && ['"', "'", "("].includes(text[index])) {
    const closing = text[index] === "(" ? ")" : text[index];
    index++;
    while (index < text.length && text[index] !== closing) {
      index += text[index] === "\\" ? 2 : 1;
    }
    if (text[index] !== closing) return undefined;
    index++;
    while (/\s/.test(text[index] ?? "") && index < text.length) index++;
  }
  return inline
    ? text[index] === ")"
      ? index + 1
      : undefined
    : index === text.length
      ? index
      : undefined;
};

const documentLinks = (clean, fail) => {
  const targets = new Map();
  const links = [];
  const lineAt = (index) => clean.slice(0, index).split("\n").length;
  // Mask definitions after reading them, so their labels are not inline links.
  const inline = clean.replace(/^ {0,3}\[([^\]\n]+)\]:([^\n]*)/gm, (whole, label, rest, index) => {
    const destination = destinationAt(rest, 0);
    if (!destination || linkEnd(rest, destination.end, false) === undefined) {
      fail(lineAt(index), "malformed link reference destination");
    } else if (!targets.has(referenceKey(label))) {
      targets.set(referenceKey(label), destination.target);
      links.push({ target: destination.target, line: lineAt(index) });
    }
    return " ".repeat(whole.length);
  });
  for (let index = 0; index < inline.length; index++) {
    if (inline[index] === "\\") {
      index++;
      continue;
    }
    if (inline[index] !== "[") continue;
    const beginning = index;
    let depth = 1;
    while (++index < inline.length && depth) {
      if (inline[index] === "\\") index++;
      else if (inline[index] === "[") depth++;
      else if (inline[index] === "]") depth--;
    }
    if (depth) {
      index = beginning;
      continue;
    }
    const label = inline.slice(beginning + 1, index - 1);
    if (inline[index] === "(") {
      const destination = destinationAt(inline, index + 1);
      const end = destination && linkEnd(inline, destination.end, true);
      if (end === undefined) fail(lineAt(beginning), "malformed inline link destination");
      else {
        links.push({ target: destination.target, line: lineAt(beginning) });
        index = end - 1;
      }
    } else {
      let reference = label;
      if (inline[index] === "[") {
        const end = inline.indexOf("]", index + 1);
        if (end === -1) continue;
        reference = inline.slice(index + 1, end) || label;
        index = end;
        if (!targets.has(referenceKey(reference))) {
          fail(lineAt(beginning), `undefined link reference [${reference}]`);
          continue;
        }
      } else index--;
      // Defined reference destinations are checked once, at their definition.
    }
  }
  return links;
};

const checkDocument = (root, file, checkScripts = true, referenced = new Set()) => {
  const errors = [];
  const fail = (line, message) => errors.push(`${file}:${line}: ${message}`);
  const canonicalRoot = realpathSync(root);
  const document = resolve(root, file);
  // Check both lexical and canonical paths before reading any Markdown, including
  // the tracked input itself. A tracked symlink is not permission to read outside.
  let body;
  try {
    if (!isWithin(root, document) || !isWithin(canonicalRoot, realpathSync(document))) {
      fail(1, "document leaves repository");
      return errors;
    }
    body = readFileSync(document, "utf8");
  } catch (error) {
    fail(1, `cannot read document: ${error.code}`);
    return errors;
  }
  const clean = withoutFences(body).replace(/`[^`\n]*`/g, (value) => " ".repeat(value.length));
  for (const issue of textBoundaryIssues(body)) fail(issue.line, issue.message);
  const htmlImages = [...clean.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => ({
    target: match[1],
    line: clean.slice(0, match.index).split("\n").length,
  }));
  for (const { target, line } of [...documentLinks(clean, fail), ...htmlImages]) {
    if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(target)) continue;
    try {
      const fragment = target.indexOf("#");
      const path = decodeURIComponent(fragment === -1 ? target : target.slice(0, fragment));
      const hash = fragment === -1 ? "" : decodeURIComponent(target.slice(fragment + 1));
      const resolved = path ? resolve(root, dirname(file), path) : document;
      if (!isWithin(root, resolved)) {
        fail(line, `link leaves repository: ${target}`);
      } else if (!existsSync(resolved)) {
        fail(line, `missing local target: ${target}`);
      } else if (!isWithin(canonicalRoot, realpathSync(resolved))) {
        fail(line, `link leaves repository: ${target}`);
      } else {
        referenced.add(nodePath.relative(root, resolved));
        if (
          hash &&
          /\.mdx?$/i.test(resolved) &&
          !anchors(readFileSync(resolved, "utf8")).has(hash)
        ) {
          fail(line, `missing heading/anchor: ${target}`);
        }
      }
    } catch (error) {
      fail(line, `invalid local link ${target}: ${error.message}`);
    }
  }
  // Every document's Bun commands must match the manifests.
  if (checkScripts) {
    let cwd = "";
    for (const [index, line] of body.split("\n").entries()) {
      if (/^\s*(`{3,}|~{3,})/.test(line)) cwd = "";
      const cd = /^\s*cd (apps\/(?:web|desktop))\s*$/.exec(line)?.[1];
      if (cd) cwd = cd;
      for (const match of line.matchAll(
        /\bbun run (?:--filter (@gram\/(?:web|desktop)) )?([\w:.-]+)/g,
      )) {
        const workspace = match[1] ? `apps/${match[1].split("/")[1]}` : cwd;
        if (!scriptFor(root, workspace, match[2])) {
          fail(index + 1, `unknown Bun script/bin ${match[2]} in ${workspace || "root"}`);
        }
      }
    }
  }
  return errors;
};

// Results belong in pull request bodies, so these folders stay empty. Apps and packages hold
// product assets and test fixtures that code loads; any other committed image must be linked or
// embedded by a tracked Markdown file, and before/after pictures go in the pull request body.
const RETIRED_FOLDERS = ["docs/verification/", "docs/releases/"];
const IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;
const PRODUCT_TREES = ["apps/", "packages/"];

const repositoryIssues = (tracked, referenced) => [
  ...tracked
    .filter((path) => RETIRED_FOLDERS.some((folder) => path.startsWith(folder)))
    .map((path) => `${path}: results belong in the pull request body, not ${dirname(path)}/`),
  ...tracked
    .filter((path) => IMAGE.test(path) && !PRODUCT_TREES.some((tree) => path.startsWith(tree)))
    .filter((path) => !referenced.has(path))
    .map((path) => `${path}: image no Markdown file embeds; put it in the pull request body`),
];

const selfTest = () => {
  // Pure path semantics, not a native Windows filesystem or acceptance claim.
  assert.equal(isWithin("C:\\repo", "D:\\outside\\external.md", win32), false);
  assert.equal(isWithin("C:\\repo", "C:\\outside\\external.md", win32), false);
  assert.equal(isWithin("C:\\repo", "C:\\repo\\docs\\guide.md", win32), true);
  assert.equal(isWithin("C:\\repo", "C:\\repo", win32), true);
  const root = mkdtempSync(join(tmpdir(), "gram-docs-check-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { "check:docs": "node checker" } }),
    );
    writeFileSync(join(root, "target.md"), "# Repeat\n# Repeat\n# Consent & isolation\n");
    writeFileSync(
      join(root, "good.md"),
      "[valid](target.md#repeat-1)\n[ref][ok]\n[ok]: target.md#consent--isolation\n```md\n[example](absent.md)\n# Hidden\n```\n`[code](absent.md)`\nbun run check:docs\n",
    );
    assert.deepEqual(checkDocument(root, "good.md"), []);
    writeFileSync(join(root, "fragment.md"), "[broken](target.md#repeat#missing)\n");
    assert.deepEqual(checkDocument(root, "fragment.md"), [
      "fragment.md:1: missing heading/anchor: target.md#repeat#missing",
    ]);
    // Regression: valid Markdown destinations must not silently evade validation.
    writeFileSync(
      join(root, "parser-negative.md"),
      "[space](<missing target.md>)\n[angle escape](<../outside target.md>)\n[nested](missing(file).md)\n[fragment](target.md#repeat#missing)\n[reference][space]\n[space]: <missing reference.md>\n",
    );
    const parserErrors = checkDocument(root, "parser-negative.md");
    writeFileSync(join(root, "file (copy).md"), "# Visible\n");
    writeFileSync(
      join(root, "parser-positive.md"),
      '[angle](<file (copy).md#visible> "title")\n[balanced](file%20(copy).md#visible)\n[escaped](file%20\\(copy\\).md#visible)\n[nested [label]](target.md#repeat)\n[shortcut]\n[collapsed][]\n[shortcut]: target.md#repeat "title"\n[collapsed]: <file (copy).md#visible>\n',
    );
    assert.deepEqual(checkDocument(root, "parser-positive.md"), []);
    writeFileSync(
      join(root, "syntax-negative.md"),
      "[angle](<absent.md)\n[unbalanced](missing(file.md)\n[unused]: missing-unused.md\n[encoded](target.md#repeat%23absent)\nUnmatched [ plain text\n[still checked](absent-after-text.md)\n",
    );
    assert.deepEqual(checkDocument(root, "syntax-negative.md"), [
      "syntax-negative.md:1: malformed inline link destination",
      "syntax-negative.md:2: malformed inline link destination",
      "syntax-negative.md:3: missing local target: missing-unused.md",
      "syntax-negative.md:4: missing heading/anchor: target.md#repeat%23absent",
      "syntax-negative.md:6: missing local target: absent-after-text.md",
    ]);

    const outside = mkdtempSync(join(tmpdir(), "gram-docs-outside-"));
    try {
      writeFileSync(join(outside, "external.md"), `# Outside marker\n${["nb", "im"].join("")}\n`);
      symlinkSync(join(outside, "external.md"), join(root, "external.md"));
      symlinkSync(outside, join(root, "external-directory"));
      symlinkSync(join(root, "target.md"), join(root, "internal.md"));
      writeFileSync(
        join(root, "symlink.md"),
        "[outside](external.md#outside-marker)\n[directory](external-directory/external.md)\n",
      );
      writeFileSync(join(root, "internal-link.md"), "[inside](internal.md#repeat)\n");
      assert.deepEqual(checkDocument(root, "internal-link.md"), []);
      assert.deepEqual(checkDocument(root, "internal.md"), []);
      assert.deepEqual(checkDocument(root, "external-directory/external.md"), [
        "external-directory/external.md:1: document leaves repository",
      ]);
      assert.equal(checkDocument(root, "symlink.md").length, 2);
      assert(
        checkDocument(root, "symlink.md").some((error) => error.includes("leaves repository")),
        "linked symlink target must be refused",
      );
      assert.deepEqual(checkDocument(root, "external.md"), [
        "external.md:1: document leaves repository",
      ]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    assert.equal(parserErrors.length, 5, "every broken destination must be diagnosed");
    assert(
      parserErrors.includes(
        "parser-negative.md:4: missing heading/anchor: target.md#repeat#missing",
      ),
    );
    assert(
      parserErrors.some((error) => error.includes("link leaves repository: ../outside target.md")),
    );
    writeFileSync(
      join(root, "bad.md"),
      "[missing](absent.md)\n[heading](target.md#wrong)\n[escape](../outside.md)\n[ref][unknown]\nbun run check:typo\n",
    );
    const errors = checkDocument(root, "bad.md");
    assert.equal(errors.length, 5);
    for (const message of [
      "missing local",
      "missing heading",
      "leaves repository",
      "undefined link",
      "unknown Bun",
    ]) {
      assert(
        errors.some((error) => error.includes(message)),
        message,
      );
    }
    assert.deepEqual(checkDocument(root, "bad.md", false).length, 4);
    assert(!anchors(readFileSync(join(root, "good.md"), "utf8")).has("hidden"));
    mkdirSync(join(root, "apps/web"), { recursive: true });
    writeFileSync(
      join(root, "apps/web/package.json"),
      JSON.stringify({
        scripts: { e2e: "playwright test" },
        devDependencies: { "@playwright/test": "1.0.0" },
      }),
    );
    writeFileSync(
      join(root, "workspace.md"),
      "```sh\ncd apps/web\nbun run e2e\nbun run playwright install chromium\n```\nbun run --filter @gram/web e2e\n",
    );
    assert.deepEqual(checkDocument(root, "workspace.md"), []);
    assert(errors.some((error) => error.startsWith("bad.md:5: unknown Bun")));
    const syntheticIdentifier = ["nb", "im"].join("");
    const syntheticToken = ["gh", "p_", "a".repeat(30)].join("");
    writeFileSync(
      join(root, "boundary.md"),
      `Historical prose\n${syntheticIdentifier}\n${syntheticToken}\n`,
    );
    const boundaryErrors = checkDocument(root, "boundary.md", false);
    assert.deepEqual(boundaryErrors, [
      "boundary.md:2: internal organization reference",
      "boundary.md:3: possible embedded credential",
    ]);
    assert(boundaryErrors.every((error) => !error.includes(syntheticToken)));
    writeFileSync(join(root, "shot.png"), "");
    writeFileSync(join(root, "logo.png"), "");
    writeFileSync(join(root, "loose.png"), "");
    writeFileSync(
      join(root, "pictures.md"),
      '![Shot](shot.png)\n<img src="logo.png" alt="Logo">\n`![code](loose.png)`\n',
    );
    const referenced = new Set();
    assert.deepEqual(checkDocument(root, "pictures.md", true, referenced), []);
    assert.deepEqual(
      repositoryIssues(
        [
          "shot.png",
          "logo.png",
          "loose.png",
          "apps/web/public/icon.png",
          "docs/verification/old.md",
          "docs/releases/1.0.0.md",
          "docs/design/notes.md",
        ],
        referenced,
      ),
      [
        "docs/verification/old.md: results belong in the pull request body, not docs/verification/",
        "docs/releases/1.0.0.md: results belong in the pull request body, not docs/releases/",
        "loose.png: image no Markdown file embeds; put it in the pull request body",
      ],
    );
    console.log(
      "Docs verifier fixtures passed (destination syntax, complete fragments, input/target realpath containment, anchors, examples, workspace commands, value-free text boundaries, committed images and retired folders).",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

if (process.argv.includes("--self-test")) selfTest();
else {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const files = execFileSync("git", ["ls-files", "-z", "--", "*.md", "*.mdx"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const referenced = new Set();
  const errors = files.flatMap((file) => checkDocument(root, file, true, referenced));
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  errors.push(...repositoryIssues(tracked, referenced));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      `Docs links, anchors, text boundaries, Bun commands and committed images passed (${files.length} tracked Markdown files).`,
    );
}
