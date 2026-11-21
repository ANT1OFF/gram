// git, `gh` and npm start only through `@gram/git`'s `Proc`, which neutralises what a checkout's
// own config and hooks would run, for git and for the git `gh` starts. A child started any other
// way runs a repository's `core.fsmonitor`, filters and hooks as the server. Owners and the files
// not moved yet are in `allowlists.mjs`; `.oxlintrc.json` scopes it to product sources.

import { relative } from "node:path";
import { ALLOWLISTS } from "./allowlists.mjs";
import { REPO } from "./ast.mjs";

const GUARDED = /^(?:git|gh|npm)(?:\.exe|\.cmd)?(?:\s|$)/;
const SPAWNERS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
  "make",
]);

const named = (callee) =>
  callee.type === "Identifier"
    ? callee.name
    : callee.type === "MemberExpression" && !callee.computed
      ? callee.property.name
      : undefined;

/** The program a call starts, when its first argument spells it out. */
const programOf = (node) => {
  const arg = node.arguments[0];
  if (arg?.type === "Literal" && typeof arg.value === "string") return arg.value;
  if (arg?.type === "TemplateLiteral") return arg.quasis[0]?.value.cooked ?? "";
  return undefined;
};

export const noRawGit = {
  meta: {
    type: "problem",
    docs: { description: "Start git, gh and npm only through @gram/git's Proc, which guards them" },
  },
  create(context) {
    const file = relative(REPO, context.filename).replaceAll("\\", "/");
    const list = ALLOWLISTS["no-raw-git"];
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return {};
    if (list.owners.includes(file) || list.pending.includes(file)) return {};
    return {
      CallExpression(node) {
        const name = named(node.callee);
        if (name === undefined || !SPAWNERS.has(name)) return;
        const program = programOf(node);
        if (program === undefined || !GUARDED.test(program)) return;
        context.report({
          node,
          message:
            "git, gh and npm run here as the server, in folders agents write: started like this, a checkout's own fsmonitor, filters and hooks run too. Run them through Proc from @gram/git (`git`, `gh` helpers or `Proc.run`), which neutralises that config.",
        });
      },
    };
  },
};
