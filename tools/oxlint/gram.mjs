// Gram's fiber guardrail: callback work belongs to a Scope/FiberMap/FiberSet.
// Direct runners are reserved for deliberate entry points, documented with
// `// oxlint-disable-next-line gram/no-bare-fork -- <why>`.
//
// And no focused tests: a committed `.only` would let the full check pass with the rest of its
// file never run. Vitest's own `--allowOnly=false` refuses it too; this names it at lint time.
//
// And Gram's shared primitives: in the server and
// git packages, paths are resolved, compared and contained only through `@gram/git`'s path module,
// calendar days and day-long durations only through the server's `zone-time.ts`, and a lock per key
// only through `git/keyed-lock.ts`, which frees a key once nobody holds it.
// Each primitive's owner and the files not moved onto it yet are in `allowlists.mjs`; `.oxlintrc.json`
// scopes the rules to those packages, and test files are exempt.

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWLISTS } from "./allowlists.mjs";

const BARE_FORKS = new Set([
  "fork",
  "forkChild",
  "forkDetach",
  "forkDaemon",
  "runFork",
  "runForkWith",
]);
const RUNNERS = new Set(["runFork", "runForkWith"]);
/** What a test file calls its cases and groups, Vitest's and @effect/vitest's alike. */
const TEST_ROOTS = new Set(["it", "test", "describe", "suite", "bench"]);

const propertyName = (node) =>
  node.computed
    ? node.property.type === "Literal" && typeof node.property.value === "string"
      ? node.property.value
      : undefined
    : node.property.type === "Identifier"
      ? node.property.name
      : undefined;

/** The identifier a member/call chain like `it.effect.only` or `describe.skipIf(x).only` starts at. */
const chainRoot = (node) => {
  for (;;) {
    if (node.type === "MemberExpression") node = node.object;
    else if (node.type === "CallExpression") node = node.callee;
    else return node.type === "Identifier" ? node.name : undefined;
  }
};

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Whether `rule` doesn't apply to the file being linted: a test, the primitive's owner, or pending. */
const exempt = (rule, context) => {
  const file = relative(REPO, context.filename).replaceAll("\\", "/");
  if (/\.test\.[cm]?[jt]sx?$/.test(file)) return true;
  const list = ALLOWLISTS[rule];
  return list !== undefined && (list.owners.includes(file) || list.pending.includes(file));
};

const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const REALPATHS = new Set(["realpath", "realpathSync"]);

/** The import an identifier is bound to, as `{ module, name }` (`name` `*` for a namespace). */
const importOf = (sourceCode, node) => {
  if (node?.type !== "Identifier") return undefined;
  for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.variables.find((value) => value.name === node.name);
    if (!variable) continue;
    const definition = variable.defs.find((value) => value.type === "ImportBinding");
    if (!definition) return undefined;
    const specifier = definition.node;
    return {
      module: definition.parent.source.value,
      name:
        specifier.type === "ImportSpecifier"
          ? (specifier.imported.name ?? specifier.imported.value)
          : "*",
    };
  }
};

/** The identifier a member chain like `fs.promises.realpath` starts at. */
const memberRoot = (node) => {
  while (node.type === "MemberExpression") node = node.object;
  return node;
};

const stringStart = (node) =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : node?.type === "TemplateLiteral"
      ? node.quasis[0].value.cooked
      : node?.type === "BinaryExpression" && node.operator === "+"
        ? stringStart(node.left)
        : undefined;

const isSep = (node) =>
  (node.type === "Identifier" && node.name === "sep") ||
  (node.type === "MemberExpression" && propertyName(node) === "sep") ||
  (node.type === "Literal" && (node.value === "/" || node.value === "\\"));

/** `` `${root}/` ``, `` `${root}\\` `` or `` `${root}${sep}` ``: a spelling's prefix, not a folder. */
const separatorPrefix = (node) => {
  if (node?.type === "BinaryExpression" && node.operator === "+")
    return isSep(node.right) && stringStart(node.left) === undefined;
  if (node?.type !== "TemplateLiteral" || node.quasis[0].value.cooked !== "") return false;
  const last = node.quasis.at(-1).value.cooked;
  if (node.expressions.length === 1) return last === "/" || last === "\\";
  const sep = node.expressions.at(-1);
  return (
    node.expressions.length === 2 &&
    last === "" &&
    node.quasis[1].value.cooked === "" &&
    ((sep.type === "Identifier" && sep.name === "sep") ||
      (sep.type === "MemberExpression" && propertyName(sep) === "sep"))
  );
};

const DAY_MS = 86_400_000;
const DAY_S = 86_400;

/** The factors of a `*` chain, or `undefined` when one isn't a number literal. */
const literalFactors = (node) => {
  if (node.type === "BinaryExpression" && node.operator === "*") {
    const left = literalFactors(node.left);
    const right = literalFactors(node.right);
    return left && right ? [...left, ...right] : undefined;
  }
  return node.type === "Literal" && typeof node.value === "number" ? [node.value] : undefined;
};

/** `24 * 60 * 60 * 1000`, `8 * 24 * 60 * 60_000` or `60 * 60 * 24`: whole days spelled out. */
const daysSpelledOut = (factors) => {
  if (factors.some((factor) => factor === DAY_MS || factor === DAY_S)) return false;
  const product = factors.reduce((a, b) => a * b, 1);
  return product % DAY_MS === 0 || (factors.includes(24) && product % DAY_S === 0);
};

/** A type reference naming `Semaphore` or `….Semaphore`. */
const namesSemaphore = (type) =>
  type?.type === "TSTypeReference" &&
  ((type.typeName.type === "Identifier" && type.typeName.name === "Semaphore") ||
    (type.typeName.type === "TSQualifiedName" && type.typeName.right.name === "Semaphore"));

const MAPS = new Set(["Map", "WeakMap", "ReadonlyMap"]);

export default {
  meta: { name: "gram" },
  rules: {
    "no-adhoc-lock": {
      meta: {
        type: "problem",
        docs: {
          description: "Keep a lock per key only through makeKeyedLock (git/keyed-lock.ts)",
        },
      },
      create(context) {
        if (exempt("no-adhoc-lock", context)) return {};
        const report = (node) =>
          context.report({
            node,
            message:
              "A map of semaphores keeps every key's lock for the server's lifetime and is easy to key by the wrong thing. Use makeKeyedLock (or makeAdmission for a cap) from git/keyed-lock.ts, keyed by the resource itself.",
          });
        return {
          NewExpression(node) {
            if (node.callee.type === "Identifier" && MAPS.has(node.callee.name))
              if (namesSemaphore(node.typeArguments?.params[1])) report(node);
          },
          TSTypeReference(node) {
            if (node.typeName.type === "Identifier" && MAPS.has(node.typeName.name))
              if (namesSemaphore(node.typeArguments?.params[1])) report(node);
          },
        };
      },
    },
    "no-day-math": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Work out calendar days and day-long durations only through the server's zone-time.ts",
        },
      },
      create(context) {
        if (exempt("no-day-math", context)) return {};
        const message =
          "Days through zone-time.ts: `DAY_MS` for a duration (a window, a lifetime), `plusDays`/`localDayOf` for a calendar day, which is 23 or 25 hours across a daylight-saving change.";
        return {
          Literal(node) {
            if (node.value === DAY_MS || node.value === DAY_S) context.report({ node, message });
          },
          BinaryExpression(node) {
            if (node.operator !== "*") return;
            const parent = node.parent;
            if (parent?.type === "BinaryExpression" && parent.operator === "*") return;
            const factors = literalFactors(node);
            if (factors !== undefined && factors.length > 1 && daysSpelledOut(factors))
              context.report({ node, message });
          },
          CallExpression(node) {
            const callee = node.callee;
            if (callee.type !== "MemberExpression") return;
            const name = propertyName(callee);
            if (name === "getTimezoneOffset" || name === "setHours")
              context.report({
                node,
                message: `${name} assumes one offset for the day or a local midnight that exists; use zone-time.ts (localDayOf, zoned, plusDays).`,
              });
          },
        };
      },
    },
    "no-raw-path": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Resolve, compare and contain paths only through @gram/git's path module (paths.ts)",
        },
      },
      create(context) {
        if (exempt("no-raw-path", context)) return {};
        const sourceCode = context.sourceCode;
        const resolving = (node) =>
          context.report({
            node,
            message:
              "Resolve paths through @gram/git (realPath, tryRealPath, realPathOrOwned, physicalPath…): one native realpath, so case and links resolve the same everywhere.",
          });
        const containing = (node, message) =>
          context.report({
            node,
            message: `${message} Use isInside, isStrictlyInside or relativeInside from @gram/git.`,
          });
        return {
          ImportDeclaration(node) {
            if (!FS_MODULES.has(node.source.value)) return;
            for (const specifier of node.specifiers) {
              const name =
                specifier.type === "ImportSpecifier"
                  ? (specifier.imported.name ?? specifier.imported.value)
                  : undefined;
              if (REALPATHS.has(name)) resolving(specifier);
            }
          },
          VariableDeclarator(node) {
            if (node.id.type !== "ObjectPattern" || node.init == null) return;
            const root = importOf(sourceCode, memberRoot(node.init));
            if (root === undefined || !FS_MODULES.has(root.module)) return;
            for (const property of node.id.properties)
              if (
                property.type === "Property" &&
                REALPATHS.has(propertyName({ ...property, property: property.key }))
              )
                resolving(property);
          },
          MemberExpression(node) {
            if (!REALPATHS.has(propertyName(node))) return;
            const root = importOf(sourceCode, memberRoot(node.object));
            if (root !== undefined && FS_MODULES.has(root.module)) resolving(node);
          },
          CallExpression(node) {
            const callee = node.callee;
            if (callee.type !== "MemberExpression" || propertyName(callee) !== "startsWith") return;
            const [argument] = node.arguments;
            if (stringStart(argument)?.startsWith(".."))
              containing(
                node,
                "A `..` prefix isn't leaving a folder: `..build` is a name inside it.",
              );
            else if (separatorPrefix(argument))
              containing(
                node,
                "A spelling's prefix isn't a folder: a link, `/tmp` for `/private/tmp` or `a//b` defeat it.",
              );
          },
        };
      },
    },
    "no-focused-tests": {
      meta: {
        type: "problem",
        docs: { description: "Disallow `.only` on tests and suites, which skips everything else" },
      },
      create(context) {
        return {
          MemberExpression(node) {
            if (propertyName(node) !== "only" || !TEST_ROOTS.has(chainRoot(node.object))) return;
            context.report({
              node,
              message: "A focused test skips the rest of its file; remove `.only` before checking.",
            });
          },
        };
      },
    },
    "no-bare-fork": {
      meta: {
        type: "problem",
        docs: {
          description: "Disallow fiber runners that bypass Scope/FiberMap/FiberSet supervision",
        },
      },
      create(context) {
        const sourceCode = context.sourceCode;
        const candidates = new Set();
        const imported = (node) => {
          if (node.type !== "Identifier" || !candidates.has(node.name)) return;
          for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
            const variable = scope.variables.find((value) => value.name === node.name);
            if (!variable) continue;
            const definition = variable.defs.find((value) => value.type === "ImportBinding");
            if (!definition) return;
            const specifier = definition.node;
            const module = definition.parent.source.value;
            const name =
              specifier.type === "ImportSpecifier"
                ? (specifier.imported.name ?? specifier.imported.value)
                : "*";
            return { module, name };
          }
        };
        const namespace = (node) => {
          const binding = imported(node);
          if (binding?.module === "effect/Effect" && binding.name === "*") return "Effect";
          if (binding?.module === "effect/Runtime" && binding.name === "*") return "Runtime";
          if (binding?.module === "effect" && ["Effect", "Runtime"].includes(binding.name))
            return binding.name;
          if (node.type === "MemberExpression") {
            const object = imported(node.object);
            const name = propertyName(node);
            if (
              object?.module === "effect" &&
              object.name === "*" &&
              ["Effect", "Runtime"].includes(name)
            )
              return name;
          }
        };
        const report = (node, module, name) =>
          context.report({
            node,
            message: `${module}.${name} starts an unsupervised fiber; use Effect.forkScoped, Effect.forkIn or a FiberMap/FiberSet runtime.`,
          });
        return {
          Program(node) {
            for (const statement of node.body) {
              if (
                statement.type === "ImportDeclaration" &&
                ["effect", "effect/Effect", "effect/Runtime"].includes(statement.source.value)
              ) {
                for (const specifier of statement.specifiers) candidates.add(specifier.local.name);
              }
            }
          },
          MemberExpression(node) {
            const name = propertyName(node);
            if (!BARE_FORKS.has(name)) return;
            const module = namespace(node.object);
            if (module && (module === "Effect" ? BARE_FORKS : RUNNERS).has(name))
              report(node, module, name);
          },
          Identifier(node) {
            const binding = imported(node);
            if (!binding) return;
            // Import declarations and property names are not references to the runner.
            let referenced = false;
            for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
              if (scope.references.some((reference) => reference.identifier === node)) {
                referenced = true;
                break;
              }
            }
            if (!referenced) return;
            if (binding?.module === "effect/Effect" && BARE_FORKS.has(binding.name))
              report(node, "Effect", binding.name);
            if (binding?.module === "effect/Runtime" && RUNNERS.has(binding.name))
              report(node, "Runtime", binding.name);
          },
        };
      },
    },
  },
};
