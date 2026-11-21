// Gram's own git reaches a remote (fetch, push, pull, ls-remote, `remote update`, a submodule's or
// LFS's transfer, a clone) only through `remoteGit` in `@gram/git`, which asks the embedder's
// origin guard first: a folder's `origin` is anyone's to rewrite who works there, and a fetch or
// push that skipped the guard would follow the rewrite. This finds the arguments of such a git
// spelled out as an array, anywhere but in a call to `remoteGit` or to a `remote…` wrapper that
// runs it. Tests are left out; `.oxlintrc.json` scopes it to product sources.

import { relative } from "node:path";
import { REPO } from "./ast.mjs";

const OWNER = "packages/git/src/remote-git.ts";

/** Verbs that reach a remote, and for those that only do with a subcommand, which ones. */
const VERBS = {
  fetch: true,
  push: true,
  pull: true,
  "ls-remote": true,
  clone: true,
  submodule: new Set(["update", "sync", "foreach", "init", "add"]),
  lfs: new Set(["fetch", "pull", "push", "checkout", "fsck", "prune"]),
  remote: new Set(["update", "prune", "show", "set-head"]),
};
/** git's own options that take the next argument. */
const WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

const literal = (node) =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : node?.type === "TemplateLiteral" && node.expressions.length === 0
      ? (node.quasis[0]?.value.cooked ?? "")
      : undefined;

/** Whether an array spells git arguments that reach a remote: its subcommand after git's options. */
const spellsRemote = (array) => {
  const items = array.elements;
  let i = 0;
  for (; i < items.length; i++) {
    const item = items[i];
    if (item === null || item.type === "SpreadElement") continue;
    const value = literal(item);
    if (value === undefined || !value.startsWith("-")) break;
    if (WITH_VALUE.has(value)) i++;
  }
  const verb = literal(items[i]);
  const sub = verb === undefined ? undefined : VERBS[verb];
  if (sub === undefined || !Object.hasOwn(VERBS, verb)) return false;
  if (sub === true) return true;
  const next = items
    .slice(i + 1)
    .map(literal)
    .find((value) => !value?.startsWith("-"));
  return next !== undefined && sub.has(next);
};

const calleeName = (callee) =>
  callee.type === "Identifier"
    ? callee.name
    : callee.type === "MemberExpression" && !callee.computed
      ? callee.property.name
      : undefined;

/** Whether `name` runs git through `remoteGit`: `remoteGit` itself, or a `remote…` wrapper of it. */
const checked = (name) => name !== undefined && /^remote[A-Z]?/.test(name);

/** The call an array is an argument of, through spreads, conditionals and nested arrays. */
const argumentOf = (node) => {
  let at = node;
  for (let parent = at.parent; parent; at = parent, parent = parent.parent) {
    if (parent.type === "CallExpression" || parent.type === "NewExpression")
      return parent.arguments.includes(at) ? parent : undefined;
    if (
      parent.type !== "SpreadElement" &&
      parent.type !== "ConditionalExpression" &&
      parent.type !== "ArrayExpression" &&
      parent.type !== "LogicalExpression"
    )
      return undefined;
  }
  return undefined;
};

/** A schema's or set's list of words, never git's arguments. */
const NOT_GIT = new Set(["Literals", "Literal", "Set", "includes", "has"]);

export const remoteGitOnly = {
  meta: {
    type: "problem",
    docs: { description: "Run git that reaches a remote only through remoteGit in @gram/git" },
  },
  create(context) {
    const file = relative(REPO, context.filename).replaceAll("\\", "/");
    if (file === OWNER || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return {};
    return {
      ArrayExpression(node) {
        if (!spellsRemote(node)) return;
        const call = argumentOf(node);
        // A lone word kept as a value (`["push"]`, an action's name) is no command line.
        if (call === undefined && node.elements.length < 2) return;
        const name = call === undefined ? undefined : calleeName(call.callee);
        if (checked(name) || NOT_GIT.has(name)) return;
        context.report({
          node,
          message:
            "This git reaches a remote without the origin guard: a folder's origin is anyone's to rewrite who works there, and git would follow the rewrite. Run it through remoteGit from @gram/git (pass the arguments to it, or to a `remote…` wrapper that calls it), which asks the embedder's guard before git reaches origin.",
        });
      },
    };
  },
};
