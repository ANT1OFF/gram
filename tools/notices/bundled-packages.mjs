// Records which npm packages each production bundle carries, so `generate.mjs` can write the
// third-party notices from what ships rather than from a hand-kept list.
//
// Each build writes `out/notices/lists/<name>.json` at the repository root: the package folders,
// relative to the root, whose modules ended up in the bundle's chunks, and each chunk's SHA-256 and
// the modules it leaves to `require` at runtime. The folder stays outside apps/desktop/out and
// apps/web/dist, which ship as they are. The shipped bundles are minified with their comments
// stripped, so verify-package.mjs reads these lists, matched to the packaged files by hash, rather
// than the bundles' source comments.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const LISTS = join(ROOT, "out", "notices", "lists");

/** The bundles a packaged app carries; `generate.mjs` fails when one hasn't recorded its list. */
export const BUNDLES = ["main", "preload", "server", "proc-worker", "speech", "web"];

const MARKER = `${sep}node_modules${sep}`;

/**
 * The package folder a bundled module came from, or undefined for the app's own source. Takes the
 * innermost `node_modules`, so a nested copy counts as its own package, and Bun's isolated
 * `node_modules/.bun/<name>@<version>/node_modules/<name>` layout resolves like a hoisted one.
 */
export function packageDirOf(id) {
  const path = id.replace(/^\0+/, "").replace(/[?#].*$/, "");
  const at = path.lastIndexOf(MARKER);
  if (at === -1) return undefined;
  const parts = path.slice(at + MARKER.length).split(sep);
  const take = parts[0]?.startsWith("@") ? 2 : 1;
  if (parts.length <= take || parts[0] === ".bin") return undefined;
  return path.slice(0, at + MARKER.length) + parts.slice(0, take).join(sep);
}

/** The repository-relative package folders behind `moduleIds`, sorted and without repeats. */
export function packageDirs(moduleIds, root = ROOT) {
  const dirs = new Set();
  for (const id of moduleIds) {
    const dir = packageDirOf(id);
    if (dir) dirs.add(relative(root, dir).split(sep).join("/"));
  }
  return [...dirs].toSorted();
}

/**
 * Writes `name`'s package list from the module ids of its output chunks, with the chunks
 * themselves (see `bundleChunks`).
 */
export function writePackageList(name, moduleIds, lists = LISTS, chunks = []) {
  mkdirSync(lists, { recursive: true });
  writeFileSync(
    join(lists, `${name}.json`),
    `${JSON.stringify({ bundle: name, packages: packageDirs(moduleIds), chunks }, null, 2)}\n`,
  );
}

/**
 * A bundle's JavaScript chunks as written: file name, SHA-256 of the code, and the modules it
 * imports from outside the bundle (Node built-ins and externalized natives), sorted.
 */
export function bundleChunks(bundle) {
  const files = new Set(Object.keys(bundle));
  return Object.values(bundle)
    .filter((output) => output.type === "chunk")
    .map((chunk) => ({
      file: chunk.fileName,
      sha256: createHash("sha256").update(chunk.code).digest("hex"),
      externals: [...new Set([...chunk.imports, ...chunk.dynamicImports])]
        .filter((id) => !files.has(id))
        .toSorted(),
    }))
    .toSorted((a, b) => a.file.localeCompare(b.file, "en"));
}

/**
 * The source files behind a bundle's outputs: each chunk's modules, and the file each asset was
 * copied from, such as a font a stylesheet imports. Vite gives an asset's source relative to its
 * root, so `root` resolves those.
 */
export function bundleSources(bundle, root) {
  return Object.values(bundle).flatMap((output) =>
    output.type === "chunk"
      ? output.moduleIds
      : (output.originalFileNames ?? []).map((file) => resolve(root, file)),
  );
}

/** A Vite/Rolldown plugin that records the packages in the bundle it writes as `name`. */
export function bundledPackages(name) {
  let root = process.cwd();
  return {
    name: "gram:bundled-packages",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      writePackageList(name, bundleSources(bundle, root), LISTS, bundleChunks(bundle));
    },
  };
}
