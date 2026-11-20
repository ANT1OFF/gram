// What Gram's lint rules share: reading names, imports and function bodies off the AST, and which
// files are tests.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const propertyName = (node) =>
  node.computed
    ? node.property.type === "Literal" && typeof node.property.value === "string"
      ? node.property.value
      : undefined
    : node.property.type === "Identifier"
      ? node.property.name
      : undefined;

/** The import an identifier is bound to, as `{ module, name }` (`name` `*` for a namespace). */
export const importOf = (sourceCode, node) => {
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

/** The one expression a function's body is: `x => e`, `x => { e; }` or `x => { return e; }`. */
export const soleExpression = (fn) => {
  if (fn.body.type !== "BlockStatement") return fn.body;
  if (fn.body.body.length !== 1) return undefined;
  const [statement] = fn.body.body;
  if (statement.type === "ExpressionStatement") return statement.expression;
  if (statement.type === "ReturnStatement") return statement.argument ?? undefined;
};

export const isFunction = (node) =>
  node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";

/** Test code: unit tests, Playwright specs and the e2e folders' fixtures and helpers. */
export const isTestFile = (file) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /(^|\/)(e2e[^/]*|test|tests|__tests__)\//.test(file);
