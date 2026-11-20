// Settings opened through `apps/web/src/settings/open-settings.ts`. `/settings` redirects to the
// tab open last time, which is the open tab while in Settings: a plain link or navigate to it,
// pressed there, pushed `/settings` and the redirect replaced it with a second copy of that tab,
// so the first Back seemed to do nothing. The helpers replace the entry while Settings is open.

import { relative } from "node:path";
import { ALLOWLISTS } from "./allowlists.mjs";
import { isTestFile, propertyName, REPO } from "./ast.mjs";

const MESSAGE =
  "`/settings` redirects to the tab open last time: pressed while Settings is open, a plain link or navigate to it pushes a second copy of that tab, and the first Back seems to do nothing. Spread `useSettingsLink()` into the Link, or call `useOpenSettings()`, from settings/open-settings.ts.";

const INDEX = /^\/settings\/?$/;

/** The router calls that take a `to` and go nowhere, so add no entry. */
const STAYS = new Set([
  "preloadRoute",
  "loadRoute",
  "matchRoute",
  "buildLocation",
  "useMatchRoute",
]);

/** Whether `node` is the string `/settings`, alone or as a branch of a condition. */
const settingsIndex = (node) => {
  while (
    node?.type === "TSAsExpression" ||
    node?.type === "TSSatisfiesExpression" ||
    node?.type === "ParenthesizedExpression" ||
    node?.type === "JSXExpressionContainer"
  )
    node = node.expression;
  if (node?.type === "ConditionalExpression")
    return settingsIndex(node.consequent) || settingsIndex(node.alternate);
  if (node?.type === "LogicalExpression")
    return settingsIndex(node.left) || settingsIndex(node.right);
  if (node?.type === "TemplateLiteral")
    return node.expressions.length === 0 && INDEX.test(node.quasis[0].value.cooked);
  return node?.type === "Literal" && typeof node.value === "string" && INDEX.test(node.value);
};

/** Whether the object a `to` is in goes to a call that navigates, or to no call at all. */
const navigates = (property) => {
  const call = property.parent?.parent;
  if (call?.type !== "CallExpression") return true;
  const name = call.callee.type === "Identifier" ? call.callee.name : propertyName(call.callee);
  return !STAYS.has(name);
};

export const settingsEntry = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Open Settings through useSettingsLink or useOpenSettings (settings/open-settings.ts), which replace the entry while Settings is open",
    },
  },
  create(context) {
    const file = relative(REPO, context.filename).replaceAll("\\", "/");
    if (isTestFile(file) || ALLOWLISTS["settings-entry"].owners.includes(file)) return {};
    return {
      JSXAttribute(node) {
        if (node.name.name === "to" && settingsIndex(node.value))
          context.report({ node, message: MESSAGE });
      },
      Property(node) {
        // `{ to: … }`, written with a name or a string.
        const key = node.computed ? undefined : (node.key.name ?? node.key.value);
        if (key === "to" && settingsIndex(node.value) && navigates(node))
          context.report({ node, message: MESSAGE });
      },
    };
  },
};
