// The `ui` half of docs/features.json: where a person finds a feature, and how a driver reaches it.
// `bun run drive` and `e2e/feature-map.spec.ts` reach features through `reach`;
// tools/feature-map/check.mjs holds each entry to `uiProblems`.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The ways a step or landmark names an element, each one of Playwright's user-facing locators. */
const LOCATOR_KEYS = ["testid", "role", "label", "text", "placeholder"];
const ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "dialog",
  "form",
  "heading",
  "link",
  "list",
  "listitem",
  "main",
  "menu",
  "menuitem",
  "navigation",
  "option",
  "radio",
  "region",
  "row",
  "searchbox",
  "switch",
  "tab",
  "tablist",
  "tabpanel",
  "textbox",
  "toolbar",
  "tree",
  "treeitem",
]);
const STEP_KEYS = ["click", "key", "wait", "goto"];

/** @param {string} name */
export const featureSlug = (name) =>
  name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Features with a `ui` block, in the map's order. @param {string} repoRoot */
export function loadUiFeatures(repoRoot) {
  const map = JSON.parse(readFileSync(join(repoRoot, "docs/features.json"), "utf8"));
  return map.features
    .filter((feature) => feature.ui)
    .map((feature) => ({ name: feature.name, slug: featureSlug(feature.name), ui: feature.ui }));
}

/**
 * A feature by its slug or name, or by a word in it when only one feature has it.
 * @param {ReturnType<typeof loadUiFeatures>} features
 * @param {string} query
 */
export function findFeature(features, query) {
  const wanted = featureSlug(query);
  const exact = features.find((feature) => feature.slug === wanted);
  if (exact) return exact;
  const partial = features.filter((feature) => feature.slug.includes(wanted));
  if (partial.length === 1) return partial[0];
  const names = (partial.length ? partial : features).map((feature) => feature.slug).join(", ");
  throw new Error(
    partial.length
      ? `"${query}" matches ${names}: name one`
      : `no feature with a ui block is "${query}". Known: ${names}`,
  );
}

/** @param {unknown} spec @param {string} where @returns {string[]} */
function locatorProblems(spec, where) {
  if (!spec || typeof spec !== "object") return [`${where} is a locator object`];
  const keys = Object.keys(spec).filter((key) => LOCATOR_KEYS.includes(key));
  if (keys.length !== 1)
    return [`${where} names its element one way: one of ${LOCATOR_KEYS.join(", ")}`];
  const extra = Object.keys(spec).filter(
    (key) => !LOCATOR_KEYS.includes(key) && key !== "name" && key !== "exact" && key !== "in",
  );
  const problems = extra.map((key) => `${where} has an unknown field "${key}"`);
  if ("role" in spec && !ROLES.has(spec.role))
    problems.push(`${where} role "${spec.role}" is not one the map uses: ${[...ROLES].join(", ")}`);
  if ("name" in spec && !("role" in spec))
    problems.push(`${where} has "name" without "role": name goes with a role`);
  if ("in" in spec) problems.push(...locatorProblems(spec.in, `${where}.in`));
  return problems;
}

/**
 * What is wrong with one feature's `ui` block, as messages that name the fix. Empty when it is
 * well formed. @param {string} name @param {any} ui
 */
export function uiProblems(name, ui) {
  const at = `${name}: ui`;
  if (!ui || typeof ui !== "object") return [`${at} is an object`];
  const problems = [];
  if (typeof ui.where !== "string" || ui.where.length < 8)
    problems.push(`${at}.where says, in the app's words, where a person finds it`);
  if (typeof ui.route !== "string" || !ui.route.startsWith("/"))
    problems.push(`${at}.route is the path the driver loads first, such as "/settings"`);
  problems.push(...locatorProblems(ui.landmark, `${at}.landmark`));
  if (ui.state !== undefined) problems.push(...locatorProblems(ui.state, `${at}.state`));
  if (ui.scenario !== undefined && !["realistic", "empty"].includes(ui.scenario))
    problems.push(`${at}.scenario is "realistic" (the default) or "empty"`);
  for (const [index, step] of (ui.steps ?? []).entries()) {
    const keys = Object.keys(step ?? {});
    if (keys.length !== 1 || !STEP_KEYS.includes(keys[0])) {
      problems.push(`${at}.steps[${index}] is one of ${STEP_KEYS.map((k) => `{${k}}`).join(", ")}`);
      continue;
    }
    const [kind] = keys;
    if (kind === "click" || kind === "wait")
      problems.push(...locatorProblems(step[kind], `${at}.steps[${index}].${kind}`));
    else if (typeof step[kind] !== "string" || !step[kind])
      problems.push(`${at}.steps[${index}].${kind} is a string`);
  }
  return problems;
}

/** The test ids a feature's `ui` names, for the check that they are still in the source. */
export function uiTestIds(ui) {
  const ids = [];
  const visit = (spec) => {
    if (!spec || typeof spec !== "object") return;
    if (typeof spec.testid === "string") ids.push(spec.testid);
    visit(spec.in);
  };
  visit(ui.landmark);
  visit(ui.state);
  for (const step of ui.steps ?? []) visit(step.click ?? step.wait);
  return ids;
}

/**
 * The first element `spec` names, inside `spec.in` when given.
 * @param {import("@playwright/test").Page} page @param {any} spec
 */
export function locate(page, spec) {
  const root = spec.in ? locate(page, spec.in) : page;
  const exact = spec.exact ?? true;
  if (spec.testid) return root.getByTestId(spec.testid).first();
  if (spec.role)
    return root
      .getByRole(spec.role, spec.name === undefined ? {} : { name: spec.name, exact })
      .first();
  if (spec.label) return root.getByLabel(spec.label, { exact }).first();
  if (spec.placeholder) return root.getByPlaceholder(spec.placeholder, { exact }).first();
  return root.getByText(spec.text, { exact }).first();
}

/** A locator in the map's own words, for messages. @param {any} spec @returns {string} */
export function describeLocator(spec) {
  const own = spec.testid
    ? `testid ${spec.testid}`
    : spec.role
      ? `${spec.role}${spec.name === undefined ? "" : ` "${spec.name}"`}`
      : spec.label
        ? `label "${spec.label}"`
        : spec.placeholder
          ? `placeholder "${spec.placeholder}"`
          : `text "${spec.text}"`;
  return spec.in ? `${own} in ${describeLocator(spec.in)}` : own;
}

/**
 * Seeds the mock as a working window's: agents signed in, welcome seen and, unless the feature
 * asks for an empty one, the realistic scenario. Runs in the page before the app.
 * @param {{ scenario: string }} seed
 */
export function seedMock(seed) {
  if (sessionStorage.getItem("gram.drive.seeded")) return;
  sessionStorage.setItem("gram.mock.agents", "claude,codex");
  sessionStorage.setItem(
    "gram.mock.settings",
    JSON.stringify({ onboarding: { welcomeSeen: true } }),
  );
  sessionStorage.setItem(
    "gram.mock.launchChecks",
    JSON.stringify({ claudeSignIn: "signedIn", codexSignIn: "signedIn", ghSignedIn: true }),
  );
  if (seed.scenario === "realistic") sessionStorage.setItem("gram.mock.orchestration", "realistic");
  sessionStorage.setItem("gram.drive.seeded", "1");
}

/** Runs one step, and on failure names it with the first line of why. */
async function runStep(label, run) {
  try {
    await run();
  } catch (error) {
    const first = String(error?.message ?? error).split("\n")[0];
    throw new Error(`${label}: ${first}`, { cause: error });
  }
}

/**
 * Loads the feature's route, takes its steps and waits for its landmark. Throws naming the step
 * that did not happen. @param {import("@playwright/test").Page} page @param {string} origin
 * @param {any} ui @param {{ timeout?: number }} [options]
 */
export async function reach(page, origin, ui, options = {}) {
  const timeout = options.timeout ?? 15_000;
  await runStep(`load ${ui.route}`, async () => {
    await page.goto(`${origin}${ui.route}`, { timeout: 180_000 });
    await page.getByTestId("app-shell").waitFor({ timeout: 180_000 });
    await page.waitForFunction(() => Boolean(window.gramMock), null, { timeout: 180_000 });
  });
  for (const [index, entry] of (ui.steps ?? []).entries()) {
    const label = `step ${index + 1}`;
    if (entry.click)
      await runStep(`${label}, click ${describeLocator(entry.click)}`, () =>
        locate(page, entry.click).click({ timeout }),
      );
    else if (entry.wait)
      await runStep(`${label}, wait for ${describeLocator(entry.wait)}`, () =>
        locate(page, entry.wait).waitFor({ timeout }),
      );
    else if (entry.key)
      await runStep(`${label}, press ${entry.key}`, () => page.keyboard.press(entry.key));
    else if (entry.goto)
      await runStep(`${label}, go to ${entry.goto}`, () =>
        page.goto(`${origin}${entry.goto}`, { timeout: 60_000 }),
      );
  }
  const landmark = locate(page, ui.landmark);
  await runStep(`landmark ${describeLocator(ui.landmark)}`, () =>
    landmark.waitFor({ state: "visible", timeout }),
  );
  return { landmark, state: ui.state ? locate(page, ui.state) : landmark };
}
