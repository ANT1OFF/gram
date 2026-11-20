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
//
// And no sleeping to synchronise: a fixed wait (`page.waitForTimeout`, a hand-rolled
// `new Promise((r) => setTimeout(r, ms))`) races the thing it waits for, so it flakes when the
// machine is slow and wastes time when it's fast. Tests wait on the condition; product code that
// does mean real time (backoff, polling) uses the one shared helper. The files not moved yet are
// in `allowlists.mjs` with how many each may keep.
//
// And every `oxlint-disable` (or `eslint-disable`) directive says why after ` -- `: an exception
// with its reason reads as a decision, one without reads as a silenced bug. The files not given
// their reasons yet are in `allowlists.mjs`.
//
// And a file-size ceiling: a file's lines of code (blank and comment-only lines aside) stay under
// `MAX_LINES` in `allowlists.mjs`, and the files already over it may only shrink.
//
// And no relative path from one workspace package's sources into another's: `../../server/src/x`
// would skip the package's declared exports and every import fence in `.oxlintrc.json`.
//
// And one optical stroke for Lucide icons: the `lucide` class sets it per size (styles/base.css),
// so a `strokeWidth` on the icon is outranked and does nothing.
//
// And no raw React effects in product code: see `no-raw-effect.mjs`.
//
// And a 24-hour clock in the web app: a time formatted with `hour` or `timeStyle` and no
// `hourCycle: "h23"` reads `2:05 PM` wherever the locale's default is 12-hour.//
// And no imperative timers in the web app: `setTimeout`, `setInterval`, `requestAnimationFrame` and
// `requestIdleCallback` are mostly reached for to paper over an ordering problem (wait for a render,
// a focus, a measurement), and many short-lived timers churn the garbage collector into jank. Real
// time goes through the named helpers in `apps/web/src/lib/timers.ts` and its neighbours; the files
// not moved yet are in `allowlists.mjs` with how many each may keep.
//
// And no explanatory comments in product source (`gram/no-comment`, in `no-comment.mjs`): directives,
// license headers and docs on exports stay, and only what a change adds is checked.

import { dirname, relative, resolve } from "node:path";
import { ALLOWLISTS, MAX_LINES } from "./allowlists.mjs";
import { importOf, isFunction, isTestFile, propertyName, REPO, soleExpression } from "./ast.mjs";
import { noRawEffect } from "./no-raw-effect.mjs";
import { noComment } from "./no-comment.mjs";
import { noTimer } from "./no-timer.mjs";

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

/** The identifier a member/call chain like `it.effect.only` or `describe.skipIf(x).only` starts at. */
const chainRoot = (node) => {
  for (;;) {
    if (node.type === "MemberExpression") node = node.object;
    else if (node.type === "CallExpression") node = node.callee;
    else return node.type === "Identifier" ? node.name : undefined;
  }
};

/** Whether `rule` doesn't apply to the file being linted: a test, the primitive's owner, or pending. */
const exempt = (rule, context) => {
  const file = relative(REPO, context.filename).replaceAll("\\", "/");
  if (/\.test\.[cm]?[jt]sx?$/.test(file)) return true;
  const list = ALLOWLISTS[rule];
  return list !== undefined && (list.owners.includes(file) || list.pending.includes(file));
};

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Lines holding code: not blank and not only comments, as ESLint's `max-lines` counts them with
 * `skipBlankLines` and `skipComments`. */
const linesOfCode = (sourceCode) => {
  // Blank every comment out, keeping its line breaks, so what is left on a line is code.
  const { text } = sourceCode;
  const pieces = [];
  let at = 0;
  for (const { range } of sourceCode.getAllComments()) {
    pieces.push(text.slice(at, range[0]), text.slice(range[0], range[1]).replace(/[^\r\n]/g, ""));
    at = range[1];
  }
  pieces.push(text.slice(at));
  return pieces
    .join("")
    .split(/\r\n|\r|\n|\u2028|\u2029/)
    .filter((line) => line.trim() !== "").length;
};

const SPLIT_HINT =
  "Split it by responsibility: move one cohesive seam into its own module beside it (a feature's handlers, one table's queries, a sub-component or panel, pure helpers apart from the effectful wiring, fixtures and builders out of a test) and import it back.";

const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const REALPATHS = new Set(["realpath", "realpathSync"]);

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

const TIMER_HOSTS = new Set(["window", "globalThis", "self"]);
const isSetTimeout = (callee) =>
  (callee.type === "Identifier" && callee.name === "setTimeout") ||
  (callee.type === "MemberExpression" &&
    propertyName(callee) === "setTimeout" &&
    callee.object.type === "Identifier" &&
    TIMER_HOSTS.has(callee.object.name));

/** `settle` itself, or a function whose whole body calls it: `() => settle("timeout")`. */
const settles = (node, settle) => {
  if (node?.type === "Identifier") return node.name === settle;
  if (!isFunction(node)) return false;
  const call = soleExpression(node);
  return (
    call?.type === "CallExpression" &&
    call.callee.type === "Identifier" &&
    call.callee.name === settle
  );
};

/**
 * `new Promise((r) => setTimeout(r, ms))` and its spellings: a promise that is only a timer. One
 * that keeps its timer to clear (`timer = setTimeout(…)`) is a bounded wait's timeout, not a sleep.
 */
const isSleepPromise = (node) => {
  if (node.callee.type !== "Identifier" || node.callee.name !== "Promise") return false;
  const [executor] = node.arguments;
  if (!isFunction(executor) || executor.params[0]?.type !== "Identifier") return false;
  const timer = soleExpression(executor);
  return (
    timer?.type === "CallExpression" &&
    isSetTimeout(timer.callee) &&
    settles(timer.arguments[0], executor.params[0].name)
  );
};

const SLEEP_HELPERS =
  "For a real-time wait in product code (backoff, polling, a grace period) use the one helper: `setTimeout` from `node:timers/promises` in Node code (`await setTimeout(ms)`, `setTimeout(ms, value)` for a race), `sleep` from `apps/web/src/lib/sleep.ts` in the web app.";
const SLEEP_IN_TESTS =
  "A test that sleeps races what it waits for: it flakes on a slow machine and wastes time on a fast one. Wait on the thing itself: await the real promise or event, `vi.waitFor(() => expect(…))` for a condition, or `vi.useFakeTimers()` with `await vi.advanceTimersByTimeAsync(ms)` when time is the input. Don't swap in a sleep helper: that hides the same race.";
const WAIT_FOR_TIMEOUT =
  "`waitForTimeout` races the page: wait on what you need instead, with a web-first assertion (`await expect(locator).toBeVisible()`, `.toHaveText()`, `.toHaveCount()`), `await expect.poll(() => value).toBe(…)`, `await expect(async () => {…}).toPass()`, `page.waitForResponse`/`waitForFunction`, or `page.clock` when time is the input.";

/** A directive that turns rules off: `oxlint-disable`, `eslint-disable-next-line` and the rest. */
const DISABLE = /^\s*(?:oxlint|eslint)-disable(?:-next-line|-line)?(?:\s|$)/;
/** Its reason, after ` -- `, ESLint's own place for one. */
const REASON = /\s--\s*\S/;

/** Lucide's props that set an icon's stroke, which the `lucide` class's stroke outranks. */
const LUCIDE_STROKES = new Set(["strokeWidth", "absoluteStrokeWidth"]);
const CREATORS = new Set(["createLucideIcon"]);

/** Whether a binding is an import from lucide-react (one of `names`, when given). */
const fromLucide = (definition, names) =>
  definition?.type === "ImportBinding" &&
  definition.parent.source.value === "lucide-react" &&
  (names === undefined ||
    (definition.node.type === "ImportSpecifier" &&
      names.has(definition.node.imported.name ?? definition.node.imported.value)));

/** The Date methods that format with locale options; `toLocaleTimeString` always shows the hour. */
const LOCALE_FORMATS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);

/** `x as const`, `x satisfies T` and `(x)` are `x`. */
const unwrap = (node) => {
  while (
    node?.type === "TSAsExpression" ||
    node?.type === "TSSatisfiesExpression" ||
    node?.type === "ParenthesizedExpression"
  )
    node = node.expression;
  return node;
};

/** The initialiser of the `const` an identifier names in this file, if it has one. */
const constInit = (sourceCode, node) => {
  for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
    const variable = scope.variables.find((value) => value.name === node.name);
    if (!variable) continue;
    const definition = variable.defs.find((value) => value.type === "Variable");
    return definition?.parent.kind === "const" ? definition.node.init : undefined;
  }
};

/**
 * What a formatter's options say about the clock: whether they ask for the hour, and whether they
 * pin a 24-hour cycle. `undefined` when the options come from somewhere this file can't see (a
 * parameter, an import, a spread of one), so only what is certain is reported.
 */
const clockOf = (sourceCode, node, seen = new Set()) => {
  node = unwrap(node);
  if (node === undefined) return { hour: false, h23: false };
  if (node.type === "Identifier") {
    if (seen.has(node.name)) return undefined;
    seen.add(node.name);
    const init = constInit(sourceCode, node);
    return init === undefined ? undefined : clockOf(sourceCode, init, seen);
  }
  if (node.type === "ConditionalExpression") {
    const a = clockOf(sourceCode, node.consequent, seen);
    const b = clockOf(sourceCode, node.alternate, seen);
    return a && b ? { hour: a.hour || b.hour, h23: a.h23 || b.h23 } : undefined;
  }
  if (node.type !== "ObjectExpression") return undefined;
  const clock = { hour: false, h23: false };
  for (const property of node.properties) {
    if (property.type === "SpreadElement") {
      const inner = clockOf(sourceCode, property.argument, seen);
      if (inner === undefined) return undefined;
      clock.hour ||= inner.hour;
      clock.h23 ||= inner.h23;
      continue;
    }
    const key = propertyName({ ...property, property: property.key });
    const value = unwrap(property.value);
    if (key === "hour" || key === "timeStyle") clock.hour = true;
    else if (key === "hourCycle" || key === "hour12") {
      if (value.type !== "Literal") return undefined;
      clock.h23 = key === "hourCycle" ? value.value === "h23" : value.value === false;
    }
  }
  return clock;
};

export default {
  meta: { name: "gram" },
  rules: {
    "no-sleep": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow fixed waits (`waitForTimeout`, hand-rolled `new Promise(… setTimeout …)` sleeps); wait on the condition, or use the shared helper",
        },
      },
      create(context) {
        const file = relative(REPO, context.filename).replaceAll("\\", "/");
        const list = ALLOWLISTS["no-sleep"];
        if (list.owners.includes(file)) return {};
        const allowed = list.pending[file] ?? 0;
        const test = isTestFile(file);
        const found = [];
        return {
          NewExpression(node) {
            if (isSleepPromise(node))
              found.push({ node, message: test ? SLEEP_IN_TESTS : SLEEP_HELPERS });
          },
          CallExpression(node) {
            if (
              node.callee.type === "MemberExpression" &&
              propertyName(node.callee) === "waitForTimeout"
            )
              found.push({ node, message: WAIT_FOR_TIMEOUT });
          },
          "Program:exit"() {
            if (found.length <= allowed) return;
            const note =
              allowed > 0
                ? ` (${file} may keep ${allowed} in tools/oxlint/allowlists.mjs, which only shrinks; it has ${found.length}.)`
                : "";
            for (const { node, message } of found)
              context.report({ node, message: message + note });
          },
        };
      },
    },
    "no-cross-package-path": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow a relative import from one workspace package's sources into another package or app",
        },
      },
      create(context) {
        const file = relative(REPO, context.filename).replaceAll("\\", "/");
        const own = /^((?:apps|packages)\/[^/]+)\/src\//.exec(file)?.[1];
        if (own === undefined || isTestFile(file)) return {};
        const check = (source) => {
          if (typeof source?.value !== "string" || !source.value.startsWith(".")) return;
          const target = relative(
            REPO,
            resolve(dirname(context.filename), source.value),
          ).replaceAll("\\", "/");
          const unit = /^((?:apps|packages)\/[^/]+)(?:\/|$)/.exec(target)?.[1];
          if (unit === undefined || unit === own) return;
          context.report({
            node: source,
            message: `\`${source.value}\` reaches from ${own} into ${unit} by a relative path, which skips its package.json and the import fences in .oxlintrc.json. Import it by the package's name and one of its declared "exports" (add an export if the piece is meant to be shared, and the dependency to ${own}/package.json), or move the piece into the package that owns it.`,
          });
        };
        return {
          ImportDeclaration: (node) => check(node.source),
          ExportNamedDeclaration: (node) => check(node.source),
          ExportAllDeclaration: (node) => check(node.source),
          ImportExpression: (node) => check(node.source),
        };
      },
    },
    "disable-reason": {
      meta: {
        type: "problem",
        docs: { description: "Give every oxlint-disable directive its reason after ` -- `" },
      },
      create(context) {
        const file = relative(REPO, context.filename).replaceAll("\\", "/");
        if (ALLOWLISTS["disable-reason"].pending.includes(file)) return {};
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (!DISABLE.test(comment.value)) continue;
              const [rules] = comment.value.split(/\s--(?:\s|$)/);
              if (rules.includes("react-hooks/"))
                context.report({
                  loc: comment.loc,
                  message:
                    "Name the rule as .oxlintrc.json does, `react/exhaustive-deps`: oxlint takes `react-hooks/` too, but one name keeps the directives searchable.",
                });
              if (!REASON.test(comment.value))
                context.report({
                  loc: comment.loc,
                  message:
                    "Say why the rule is wrong here: end the directive with ` -- <reason>` (what the rule can't see, or why this site is the exception). If the rule is right, fix the code instead.",
                });
            }
          },
        };
      },
    },
    "lucide-stroke": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Don't set strokeWidth on a Lucide icon: the `lucide` class draws one optical stroke per size",
        },
      },
      create(context) {
        if (exempt("lucide-stroke", context)) return {};
        const sourceCode = context.sourceCode;
        /** The definition `name` is bound to where `node` is. */
        const definitionOf = (node, name) => {
          for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
            const variable = scope.variables.find((value) => value.name === name);
            if (variable) return variable.defs[0];
          }
        };
        /** Whether a JSX name is a lucide-react icon, imported or made with its createLucideIcon. */
        const lucide = (name) => {
          while (name.type === "JSXMemberExpression") name = name.object;
          if (name.type !== "JSXIdentifier") return false;
          const definition = definitionOf(name, name.name);
          if (fromLucide(definition)) return true;
          if (definition?.type !== "Variable" || definition.parent.kind !== "const") return false;
          let init = definition.node.init;
          while (init?.type === "TSAsExpression" || init?.type === "TSSatisfiesExpression")
            init = init.expression;
          return (
            init?.type === "CallExpression" &&
            init.callee.type === "Identifier" &&
            fromLucide(definitionOf(init.callee, init.callee.name), CREATORS)
          );
        };
        return {
          JSXOpeningElement(node) {
            const props = node.attributes.filter(
              (attribute) =>
                attribute.type === "JSXAttribute" && LUCIDE_STROKES.has(attribute.name.name),
            );
            if (props.length === 0 || !lucide(node.name)) return;
            for (const prop of props)
              context.report({
                node: prop,
                message: `\`${prop.name.name}\` does nothing on a Lucide icon: its \`lucide\` class sets the stroke from --icon-stroke for each size (styles/base.css), and DESIGN.md keeps one optical stroke. Drop it and pick the size token; a glyph of Gram's own that needs a thinner line sets \`strokeWidth\` on its strokes in createLucideIcon's node, as motion/spinner.tsx's rings do.`,
              });
          },
        };
      },
    },
    "clock-24h": {
      meta: {
        type: "problem",
        docs: {
          description:
            'Format a time of day with `hourCycle: "h23"`, Gram\'s 24-hour clock (CLOCK_TIME in apps/web/src/lib/time.ts)',
        },
      },
      create(context) {
        if (exempt("clock-24h", context)) return {};
        const sourceCode = context.sourceCode;
        const check = (node, options, always = false) => {
          const clock = clockOf(sourceCode, options);
          if (clock === undefined || clock.h23 || !(always || clock.hour)) return;
          context.report({
            node,
            message:
              'Gram\'s times are 24-hour, and without `hourCycle: "h23"` this reads `2:05 PM` wherever the locale defaults to a 12-hour clock. Use formatStamp (or formatClockTime, formatDay) from apps/web/src/lib/time.ts, or spread its `CLOCK_TIME` into these options.',
          });
        };
        const formatter = (node) => {
          const callee = node.callee;
          if (callee.type === "Identifier" && callee.name === "dateTimeFormat")
            check(node, node.arguments[1]);
          else if (callee.type === "MemberExpression" && propertyName(callee) === "DateTimeFormat")
            check(node, node.arguments[1]);
        };
        return {
          NewExpression: formatter,
          CallExpression(node) {
            formatter(node);
            const callee = node.callee;
            if (callee.type !== "MemberExpression") return;
            const name = propertyName(callee);
            if (LOCALE_FORMATS.has(name))
              check(node, node.arguments[1], name === "toLocaleTimeString");
          },
        };
      },
    },
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
    "max-lines": {
      meta: {
        type: "suggestion",
        docs: {
          description: "Keep files small enough to read whole; listed large files only shrink",
        },
        schema: [
          {
            type: "object",
            properties: {
              limit: { type: "number" },
              testLimit: { type: "number" },
              pending: { type: "object" },
            },
            additionalProperties: false,
          },
        ],
      },
      create(context) {
        const { limit, testLimit, pending } = { ...MAX_LINES, ...context.options[0] };
        return {
          Program(node) {
            const file = relative(REPO, context.filename).replaceAll("\\", "/");
            const ceiling = TEST_FILE.test(file) ? testLimit : limit;
            const count = linesOfCode(context.sourceCode);
            const listed = Object.hasOwn(pending, file) ? pending[file] : undefined;
            if (count <= (listed ?? ceiling)) return;
            context.report({
              node,
              loc: { line: 1, column: 0 },
              message:
                listed === undefined
                  ? `This file has ${count} lines of code, over the limit of ${ceiling}. ${SPLIT_HINT} Don't raise the limit or add the file to MAX_LINES in tools/oxlint/allowlists.mjs.`
                  : `This file has ${count} lines of code, past its ratchet of ${listed} in tools/oxlint/allowlists.mjs (the limit is ${ceiling}); listed files may only shrink. ${SPLIT_HINT} Don't raise its entry.`,
            });
          },
        };
      },
    },
    "no-raw-effect": noRawEffect,
    "no-timer": noTimer,
    "no-comment": noComment,
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
