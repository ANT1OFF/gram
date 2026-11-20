// No raw React effects in product code. `useEffect` takes any code and any dependencies, and most
// of what gets written in one belongs in render or an event handler, so an effect is named for what
// it does with a hook from `apps/web/src/lib/effects.ts` (or the timers). Those hooks' callbacks are
// held to what `react/set-state-in-effect` holds a raw effect to. The files not moved yet are in
// `allowlists.mjs`, with how many each may keep.

import { relative } from "node:path";
import { ALLOWLISTS } from "./allowlists.mjs";
import { importOf, isFunction, isTestFile, propertyName, REPO, soleExpression } from "./ast.mjs";

/** React's own effects, which product code names through `apps/web/src/lib/effects.ts`. */
const RAW_EFFECTS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);
/** That module's effects, whose body a state update must stay out of as a raw effect's must. */
const NAMED_EFFECTS = new Set([
  "useSubscription",
  "useExternalSync",
  "useLayoutSync",
  "useMountEffect",
]);

/** The calls a function body makes as it runs, not those in functions it only defines. */
const syncCalls = (node, calls = []) => {
  if (node === null || typeof node !== "object") return calls;
  if (Array.isArray(node)) {
    for (const each of node) syncCalls(each, calls);
    return calls;
  }
  if (typeof node.type !== "string") return calls;
  if (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  )
    return calls;
  if (node.type === "CallExpression") calls.push(node);
  for (const key of Object.keys(node))
    if (key !== "parent" && key !== "loc" && key !== "range") syncCalls(node[key], calls);
  return calls;
};

const EFFECTS_DOC = "See CONTRIBUTING.md#react-effects.";
const EFFECT_CHOICES =
  "Most effects need none: derive the value in render, do the work in the event handler that caused the change, reset state with a `key`, read a store with its hook or `useSyncExternalStore`, load data with the query hooks. Otherwise name it from `@/lib/effects`: `useSubscription` (attach to a store, the bridge, a DOM event with `listen`, an observer; return the detach), `useExternalSync` or `useLayoutSync` (push this render's values out to the DOM, storage or the bridge), `useMountEffect` (once on mount), `useLatest` (a ref holding the latest value); timers are `useNow` and `@/lib/timers`.";

/** What a raw effect should be instead, read off its callback and dependencies. */
const rawEffectMessage = (name, [effect, deps], sourceCode) => {
  const head = `Raw \`${name}\` takes any code and any dependencies, and is where effects that belong in render or a handler end up.`;
  const body = isFunction(effect) ? sourceCode.getText(effect) : "";
  const hint = /\b(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)\b/.test(body)
    ? "This one keeps a timer: use `useNow` (`@/lib/use-now`) or `@/lib/timers`."
    : /addEventListener|\.subscribe\(|\.on[A-Z]\w*\(|Observer\(|\.retain\(/.test(body)
      ? "This one attaches to something outside React: `useSubscription(() => …, deps)` returning the detach, with `listen(target, type, handler)` for a DOM event."
      : deps?.type === "ArrayExpression" && deps.elements.length === 0
        ? "This one runs once on mount: `useMountEffect(fn)`."
        : deps === undefined &&
            isFunction(effect) &&
            soleExpression(effect)?.type === "AssignmentExpression" &&
            soleExpression(effect).left.type === "MemberExpression" &&
            propertyName(soleExpression(effect).left) === "current"
          ? "This one keeps a ref current: `const latest = useLatest(value)`."
          : "";
  return [head, hint, EFFECT_CHOICES, EFFECTS_DOC].filter(Boolean).join(" ");
};

export const noRawEffect = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw `useEffect`/`useLayoutEffect` in product code; name the effect with a hook from `apps/web/src/lib/effects.ts`, or do without one",
    },
  },
  create(context) {
    const file = relative(REPO, context.filename).replaceAll("\\", "/");
    if (isTestFile(file)) return {};
    const list = ALLOWLISTS["no-raw-effect"];
    if (list.owners.includes(file)) return {};
    const allowed = list.pending[file] ?? 0;
    const sourceCode = context.sourceCode;
    const found = [];
    /** The raw effect a call's callee names (`useEffect`, `React.useLayoutEffect`), if any. */
    const rawEffect = (callee) => {
      if (callee.type === "Identifier") {
        const binding = importOf(sourceCode, callee);
        return binding?.module === "react" && RAW_EFFECTS.has(binding.name)
          ? binding.name
          : undefined;
      }
      if (callee.type !== "MemberExpression") return undefined;
      const name = propertyName(callee);
      return RAW_EFFECTS.has(name) && importOf(sourceCode, callee.object)?.module === "react"
        ? name
        : undefined;
    };
    /** Whether an identifier is the setter of a `useState` or `useReducer` in this file. */
    const isStateSetter = (node) => {
      for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
        const variable = scope.variables.find((value) => value.name === node.name);
        if (!variable) continue;
        const declarator = variable.defs.find((value) => value.type === "Variable")?.node;
        const init = declarator?.init;
        if (declarator?.id.type !== "ArrayPattern" || init?.type !== "CallExpression") return false;
        if (declarator.id.elements[1] !== variable.identifiers[0]) return false;
        const callee =
          init.callee.type === "MemberExpression" ? propertyName(init.callee) : init.callee.name;
        return callee === "useState" || callee === "useReducer";
      }
      return false;
    };
    return {
      CallExpression(node) {
        const raw = rawEffect(node.callee);
        if (raw !== undefined) {
          found.push({ node, message: rawEffectMessage(raw, node.arguments, sourceCode) });
          return;
        }
        // The named effects run as effects do, so what `react/set-state-in-effect` refuses in a
        // raw one, a state update as the effect runs, is refused in them too.
        if (node.callee.type !== "Identifier") return;
        const binding = importOf(sourceCode, node.callee);
        if (!binding || !NAMED_EFFECTS.has(binding.name) || !/(^|\/)effects$/.test(binding.module))
          return;
        const [effect] = node.arguments;
        if (!isFunction(effect)) return;
        for (const call of syncCalls(effect.body))
          if (call.callee.type === "Identifier" && isStateSetter(call.callee))
            context.report({
              node: call,
              message: `\`${call.callee.name}\` runs as the effect does, so the component renders twice for one change. Compute the value in render (with \`useMemo\` if it is costly), set it in the event handler that caused the change, or reset the component with a \`key\`. A subscription's callback may set state: the rule only refuses it in the effect's own body. See CONTRIBUTING.md#react-effects.`,
            });
      },
      "Program:exit"() {
        if (found.length <= allowed) return;
        const note =
          allowed > 0
            ? ` (${file} may keep ${allowed} in tools/oxlint/allowlists.mjs, which only shrinks; it has ${found.length}.)`
            : "";
        for (const { node, message } of found) context.report({ node, message: message + note });
      },
    };
  },
};
