// `gram/no-comment`: product code says what it means in code. A comment goes stale the day the
// code under it changes, people skim past it, and an agent reaches for one to explain away a
// shortcut instead of fixing its cause. What stays: directives, a license header, and a `/** … */`
// doc on an exported declaration or one of its members, which is the API's documentation. The
// files not cleared yet are in `comments-baseline.json` with how many comments each may keep. A file
// below its count is not an error: nearly every change touches comments, and parallel pull requests
// would otherwise fail main on each other's cleanups. `comments-baseline.mjs` lowers the entries.

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
export const BASELINE_PATH = resolve(HERE, "comments-baseline.json");
const baseline = () => JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

const isTestFile = (file) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
  /(^|\/)(e2e[^/]*|test|tests|__tests__|fixtures?)\//.test(file);

const DIRECTIVE =
  /^[\s*]*(?:(?:oxlint|eslint)-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck|check)|@vitest-environment|@vite-ignore|@jsx(?:ImportSource|Runtime)?\b|[#@]__(?:PURE|NO_SIDE_EFFECTS)__|webpack[A-Z]\w*:|(?:c8|v8|istanbul) ignore|prettier-ignore|oxfmt-ignore|renovate:|global\s)/;
const TRIPLE_SLASH = /^\/\s*<(?:reference|amd-module)\b/;
const LICENSE = /SPDX-License-Identifier|copyright|license/i;

/** Members whose doc block documents the exported declaration they belong to. */
const MEMBERS = new Set([
  "TSPropertySignature",
  "TSMethodSignature",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSIndexSignature",
  "TSEnumMember",
  "MethodDefinition",
  "PropertyDefinition",
  "TSAbstractMethodDefinition",
  "TSAbstractPropertyDefinition",
  "AccessorProperty",
  "Property",
  "TSDeclareFunction",
]);

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node === null || typeof node !== "object" || typeof node.type !== "string") return;
  visit(node);
  for (const key in node)
    if (key !== "parent" && key !== "loc" && key !== "range") walk(node[key], visit);
};

/** Where a doc block may sit: the start of every export, and of every member inside one. */
const documentable = (program) => {
  const starts = new Set();
  for (const statement of program.body) {
    if (
      statement.type !== "ExportNamedDeclaration" &&
      statement.type !== "ExportDefaultDeclaration"
    )
      continue;
    starts.add(statement.range[0]);
    const declaration = statement.declaration;
    if (!declaration) continue;
    starts.add(declaration.range[0]);
    walk(declaration, (node) => {
      if (MEMBERS.has(node.type)) starts.add(node.range[0]);
    });
  }
  return starts;
};

/** The first position after `at` that isn't white space or another comment. */
const nextCode = (text, comments, index) => {
  let at = comments[index].range[1];
  for (let next = index + 1; ; next++) {
    while (at < text.length && /\s/.test(text[at])) at++;
    if (next < comments.length && comments[next].range[0] === at) at = comments[next].range[1];
    else return at;
  }
};

export const COMMENT_FIX =
  "No explanatory comments in product code: they go stale, nobody reads them, and they excuse shortcuts. Say it in code: a name for the value or function, a type that rules out the wrong case, a test, or a lint rule whose message names the fix. If the comment explains a workaround, fix the cause instead. Documentation for an exported API is a `/** … */` directly on the export or its member. Kept: directives with their reason (`oxlint-disable … -- why`, `@ts-expect-error why`) and license headers.";
export const DOC_FIX =
  "A `/** … */` documents an exported declaration or one of its members. This one sits on something private: give it a name that needs no doc, or export it if it really is API.";

/** Each comment in `sourceCode` the rule refuses, as `{ comment, message }`. */
export const refusedComments = (sourceCode, program) => {
  const { text } = sourceCode;
  const comments = sourceCode.getAllComments();
  const starts = documentable(program);
  const firstCode = program.body[0]?.range[0] ?? text.length;
  const refused = [];
  comments.forEach((comment, index) => {
    const value = comment.value;
    if (DIRECTIVE.test(value) || (comment.type === "Line" && TRIPLE_SLASH.test(value))) return;
    if (comment.range[1] <= firstCode && LICENSE.test(value)) return;
    const doc = comment.type === "Block" && value.startsWith("*") && !value.startsWith("**");
    if (doc && starts.has(nextCode(text, comments, index))) return;
    refused.push({ comment, message: doc ? DOC_FIX : COMMENT_FIX });
  });
  return refused;
};

export const noComment = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow explanatory comments in product code; keep directives, license headers and docs on exports",
    },
  },
  create(context) {
    const file = relative(REPO, context.filename).replaceAll("\\", "/");
    if (isTestFile(file) || file.endsWith(".d.ts")) return {};
    const allowed = process.env.GRAM_COUNT_COMMENTS ? 0 : (baseline()[file] ?? 0);
    return {
      Program(program) {
        const refused = refusedComments(context.sourceCode, program);
        if (refused.length <= allowed) return;
        const note =
          allowed > 0
            ? ` (${file} may keep ${allowed} in tools/oxlint/comments-baseline.json, which only shrinks; it has ${refused.length}. Clear the new ones, or the ones you touched.)`
            : "";
        for (const { comment, message } of refused)
          context.report({ loc: comment.loc, message: message + note });
      },
    };
  },
};
