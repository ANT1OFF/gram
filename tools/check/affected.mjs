// Which workspaces and Vitest projects a set of changed paths can affect, by the workspace
// dependency graph (package.json `@gram/*` dependencies and tsconfig project references).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Root files every workspace builds or tests with: a change to one is a change to all. */
const GLOBAL = [
  /^package\.json$/,
  /^bun\.lock$/,
  /^bunfig\.toml$/,
  /^tsconfig(\.[\w-]+)?\.json$/,
  /^vitest\.config\.ts$/,
  /^\.oxlintrc\.json$/,
  /^\.oxfmtrc\.json$/,
  /^\.node-version$/,
  /^\.bun-version$/,
  /^\.npmrc$/,
  /^patches\//,
  /^tools\/oxlint\//,
  /^tools\/check\//,
];

/** Paths no Vitest project reads: prose and repository plumbing the static stages cover. */
const NO_TESTS = [/\.md$/, /^docs\//, /^\.github\//, /^\.gram\//, /^\.agents\//, /^\.claude\//];

/** Every workspace: its directory, package name, Vitest project and the workspaces it uses. */
export function workspaces(root) {
  const list = [];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${group}/${entry.name}`;
      const manifestPath = join(root, dir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
        (name) => name.startsWith("@gram/"),
      );
      let references = [];
      try {
        const tsconfig = JSON.parse(readFileSync(join(root, dir, "tsconfig.json"), "utf8"));
        references = (tsconfig.references ?? []).map((ref) =>
          relative(root, join(root, dir, ref.path)),
        );
      } catch {
        // No tsconfig, or one with comments: the manifest's dependencies stand alone.
      }
      list.push({ dir, name: manifest.name, project: entry.name, deps, references });
    }
  }
  const byName = new Map(list.map((ws) => [ws.name, ws]));
  return list.map((ws) => ({
    ...ws,
    uses: [
      ...new Set([
        ...ws.deps.flatMap((name) => (byName.has(name) ? [byName.get(name).dir] : [])),
        ...ws.references.filter((dir) => list.some((other) => other.dir === dir)),
      ]),
    ],
  }));
}

/**
 * What `changed` (repository-relative paths) affects: `all` when a shared root file changed,
 * otherwise the changed workspaces and everything that depends on them, and the Vitest projects
 * to run (the workspaces' plus `tools` for tool sources).
 */
export function affected(changed, graph) {
  const global = changed.filter((path) => GLOBAL.some((pattern) => pattern.test(path)));
  if (global.length > 0) {
    return {
      all: true,
      reason: `shared ${global.length === 1 ? "file" : "files"} ${global.slice(0, 3).join(", ")}`,
      workspaces: graph.map((ws) => ws.dir),
      projects: [...graph.map((ws) => ws.project), "tools"],
    };
  }
  const direct = new Set();
  let tools = false;
  const unowned = [];
  for (const path of changed) {
    const owner = graph.find((ws) => path.startsWith(`${ws.dir}/`));
    if (owner !== undefined) direct.add(owner.dir);
    else if (path.startsWith("tools/")) tools = true;
    else if (!NO_TESTS.some((pattern) => pattern.test(path))) unowned.push(path);
  }
  // A source outside every workspace may be read by any test: run them all rather than guess.
  if (unowned.length > 0) {
    return {
      all: true,
      reason: `unowned ${unowned.slice(0, 3).join(", ")}`,
      workspaces: graph.map((ws) => ws.dir),
      projects: [...graph.map((ws) => ws.project), "tools"],
    };
  }
  const closure = new Set(direct);
  for (let grew = true; grew;) {
    grew = false;
    for (const ws of graph) {
      if (!closure.has(ws.dir) && ws.uses.some((dir) => closure.has(dir))) {
        closure.add(ws.dir);
        grew = true;
      }
    }
  }
  const chosen = graph.filter((ws) => closure.has(ws.dir));
  return {
    all: false,
    direct: [...direct],
    workspaces: chosen.map((ws) => ws.dir),
    projects: [...chosen.map((ws) => ws.project), ...(tools ? ["tools"] : [])],
  };
}
