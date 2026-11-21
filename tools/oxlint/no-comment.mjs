// `gram/no-comment`: product code says what it means in code. A comment goes stale the day the
// code under it changes, people skim past it, and an agent reaches for one to explain away a
// shortcut instead of fixing its cause. What stays: directives, a license header, and a `/** … */`
// doc on an exported declaration or one of its members, which is the API's documentation.
//
// The rule holds what a change adds. Each file the change touches is compared with where it left
// the base (GRAM_COMMENTS_BASE, default origin/main; `comments-base.mjs` writes it before oxlint
// runs): a refused comment whose source text the file
// did not have there is new. Comments already on the base wait to be cleared without a list, so
// parallel pull requests and cleanups never fail each other. Moving a comment is not adding one;
// rewording one is. Without that file, as in an editor, the rule checks nothing.
// GRAM_CHECK_ALL_COMMENTS=1 checks every file, for counting what is left.

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const COMMENTS_BASE_PATH = resolve(REPO, "node_modules/.cache/gram/comments-base.json");

let touched;
/** Each product file changed since the merge base, with its text there (null when new); null when unknown. */
const touchedFiles = () => {
  if (touched !== undefined) return touched;
  if (!existsSync(COMMENTS_BASE_PATH)) return (touched = null);
  const { files } = JSON.parse(readFileSync(COMMENTS_BASE_PATH, "utf8"));
  return (touched = files === null ? null : new Map(Object.entries(files)));
};

/** The refused comments whose source text `before` holds fewer times than `text` does. */
export const addedComments = (refused, text, before) => {
  const left = new Map();
  return refused.filter(({ comment }) => {
    const raw = text.slice(comment.range[0], comment.range[1]);
    if (!left.has(raw)) left.set(raw, before === undefined ? 0 : before.split(raw).length - 1);
    const count = left.get(raw);
    left.set(raw, count - 1);
    return count <= 0;
  });
};

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
    const files = process.env.GRAM_CHECK_ALL_COMMENTS ? new Map([[file, null]]) : touchedFiles();
    if (!files?.has(file)) return {};
    const before = files.get(file) ?? undefined;
    return {
      Program(program) {
        const refused = refusedComments(context.sourceCode, program);
        for (const { comment, message } of addedComments(refused, context.sourceCode.text, before))
          context.report({ loc: comment.loc, message });
      },
    };
  },
};
