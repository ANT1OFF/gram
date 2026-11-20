// `gram/no-timer`: see the header of `gram.mjs`.

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWLISTS } from "./allowlists.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TIMER_HOSTS = new Set(["window", "globalThis", "self"]);
const isTestFile = (file) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /(^|\/)(e2e[^/]*|test|tests|__tests__)\//.test(file);
const propertyName = (node) =>
  node.computed
    ? node.property.type === "Literal" && typeof node.property.value === "string"
      ? node.property.value
      : undefined
    : node.property.type === "Identifier"
      ? node.property.name
      : undefined;

const TIMERS = new Set([
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
  "requestIdleCallback",
]);
const TIMER_FIX = {
  setTimeout:
    'A timer that waits for a render, a focus or a measurement hides an ordering bug: do the work in the event handler, a ref callback or `useLayoutEffect`, or `focus()` after the state that mounts the element. For time a person sees, use a helper from `@/lib/timers`: `useFlash(ms)` for a mark shown then cleared ("Copied"), `useDebounced(value, ms)` for input that settles; `useNow` (`@/lib/use-now`) for a ticking clock; `sleep(ms)` (`@/lib/sleep`) to wait in async code.',
  setInterval:
    "A ticking clock is `useNow(active, anchor, ms)` from `@/lib/use-now`, which shares one timer per interval and stops while the window is hidden. A poll is a query with `refetchInterval`, or an async loop over `sleep(ms)` from `@/lib/sleep`.",
  requestAnimationFrame:
    "Waiting a frame to read layout is `useLayoutEffect`, a `ResizeObserver` or an `IntersectionObserver`; waiting for the DOM to exist is a ref callback. Work batched to the next frame goes through `nextFrame`/`createFrameBatch` in `@/stores/frame-batch`, and an async loop that awaits a paint uses `painted()` from `@/lib/timers`.",
  requestIdleCallback:
    "Start-up work deferred until the window is idle goes in `usePreloadAfterPaint` (`@/shell/preload-after-paint`), which owns the idle callback and its fallback; anything else waits on the event that makes it ready.",
};

/** The timer a call reaches, if it calls the global one rather than something bound in the file. */
const globalTimer = (sourceCode, callee) => {
  let name;
  let root = callee;
  if (callee.type === "Identifier") name = callee.name;
  else if (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    TIMER_HOSTS.has(callee.object.name)
  ) {
    name = propertyName(callee);
    root = callee.object;
  }
  if (!TIMERS.has(name)) return undefined;
  for (let scope = sourceCode.getScope(root); scope; scope = scope.upper) {
    const variable = scope.variables.find((value) => value.name === root.name);
    if (variable && variable.defs.length > 0) return undefined;
  }
  return name;
};

export const noTimer = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow imperative timers in the web app; use the named helper for real time, or fix the ordering they paper over",
    },
  },
  create(context) {
    const file = relative(REPO, context.filename).replaceAll("\\", "/");
    if (isTestFile(file)) return {};
    const list = ALLOWLISTS["no-timer"];
    if (list.owners.includes(file)) return {};
    const allowed = list.pending[file] ?? 0;
    const found = [];
    return {
      CallExpression(node) {
        const timer = globalTimer(context.sourceCode, node.callee);
        if (timer) found.push({ node, message: `No \`${timer}\` here. ${TIMER_FIX[timer]}` });
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
