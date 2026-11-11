// What a workspace package becomes when it is published: its name, its version, and a manifest
// that resolves without this repository's workspace or catalog. Pure, so the tests cover it whole.

/** The workspace packages that are published, each after the ones it depends on. */
export const PUBLISHED = ["contracts", "themes", "git", "agents", "server"];

/** The scope the packages have in this repository, and in the imports their code makes. */
export const WORKSPACE_SCOPE = "@gram";

/**
 * Commands a published package installs, by workspace folder: the name on the PATH and the built
 * module it runs.
 */
export const BINS = {
  server: { "gram-server": "./dist/main.js", "gram-host": "./dist/host/main.js" },
};

/**
 * Folders beside `src` that a package's exported code reads at run time, by workspace folder. The
 * agents' `testing` entries replay their recorded fixtures.
 */
export const EXTRA_FILES = { agents: ["fixtures"] };

/** Dependencies a consumer must share one copy of, so they are published as exact peers. */
export const PEERS = new Set(["effect"]);

/**
 * Dependencies of a dependency that must not float, by the dependency that brings them, each
 * published at the version of the catalog entry named. `@effect/platform-node` asks for a range of
 * its shared half, and a newer one needs a newer `effect` than the exact peer.
 */
export const COMPANIONS = {
  "@effect/platform-node": { "@effect/platform-node-shared": "effect" },
};

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SCOPE = /^@[a-z0-9][a-z0-9._-]*$/;

/**
 * A canary's version: the patch after `base`, so it sorts above the release it follows, then the
 * commit's time and hash. The time orders canaries; the hash names the source. The hash carries a
 * letter in front because a prerelease part made only of digits can't start with a zero.
 */
export const canaryVersion = ({ base, committedAt, commit }) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (match === null) throw new Error(`Canaries follow a plain release version, not ${base}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("A canary needs the full commit hash");
  const at = new Date(committedAt);
  if (Number.isNaN(at.getTime())) throw new Error(`Not a commit time: ${committedAt}`);
  const stamp = at.toISOString().replace(/\D/g, "").slice(0, 14);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}-canary.${stamp}.g${commit.slice(0, 9)}`;
};

/** A release's version, which must be the one its tag names. */
export const releaseVersion = ({ base, tag }) => {
  if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error(`Not a release version: ${base}`);
  if (tag !== `v${base}`) throw new Error(`Tag ${tag} doesn't name version ${base}`);
  return base;
};

/**
 * The name a workspace package is published under. In the `@gram` scope it keeps its name; in any
 * other scope (a registry may only allow the owner's) it is `gram-<name>` there.
 */
export const publishedName = (name, scope) => {
  if (!SCOPE.test(scope)) throw new Error(`Not a package scope: ${scope}`);
  if (!name.startsWith(`${WORKSPACE_SCOPE}/`)) throw new Error(`Not a workspace package: ${name}`);
  const bare = name.slice(WORKSPACE_SCOPE.length + 1);
  return scope === WORKSPACE_SCOPE ? name : `${scope}/gram-${bare}`;
};

/**
 * What a consumer writes to depend on a published package. Outside the `@gram` scope it is an
 * alias, so the package still installs as `@gram/<name>`, the name every import uses.
 */
export const dependencySpec = (name, scope, version) =>
  scope === WORKSPACE_SCOPE ? version : `npm:${publishedName(name, scope)}@${version}`;

/** `./src/a/b.ts` as the built files it is published as. */
export const builtEntry = (source) => {
  const match = /^\.\/src\/(.+)\.ts$/.exec(source);
  if (match === null) throw new Error(`An export must be a TypeScript file under src: ${source}`);
  return { types: `./dist/${match[1]}.d.ts`, default: `./dist/${match[1]}.js` };
};

const builtExports = (exports) =>
  Object.fromEntries(
    Object.entries(exports).map(([subpath, target]) => {
      const source = typeof target === "string" ? target : target.default;
      if (typeof source !== "string") throw new Error(`Export ${subpath} names no file`);
      return [subpath, builtEntry(source)];
    }),
  );

/**
 * The manifest a package is published with. Workspace and catalog specifiers become exact
 * versions, exports point at built files, and development-only fields go.
 *
 * - `manifest`: the workspace package's own `package.json`.
 * - `folder`: its folder under `packages/`.
 * - `catalog`: the workspace catalog, name to exact version.
 * - `published`: the names of the workspace packages published beside it.
 * - `built`: what built it (`typescript`, `node`), recorded for the consumer.
 */
export const publishManifest = ({
  manifest,
  folder,
  catalog,
  published,
  version,
  scope,
  repository,
  commit,
  engines,
  built,
}) => {
  if (!EXACT.test(version)) throw new Error(`Not an exact version: ${version}`);
  const dependencies = {};
  const peerDependencies = {};
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    let resolved = spec;
    if (spec.startsWith("workspace:")) {
      if (!published.includes(name)) {
        throw new Error(`${manifest.name} depends on ${name}, which isn't published`);
      }
      resolved = dependencySpec(name, scope, version);
    } else if (spec === "catalog:") {
      resolved = catalog[name];
      if (resolved === undefined) throw new Error(`${name} isn't in the catalog`);
    }
    if (!resolved.startsWith("npm:") && !EXACT.test(resolved)) {
      throw new Error(`${manifest.name}: ${name} must be an exact version, not ${resolved}`);
    }
    (PEERS.has(name) ? peerDependencies : dependencies)[name] = resolved;
    for (const [companion, pin] of Object.entries(COMPANIONS[name] ?? {})) {
      if (catalog[pin] === undefined) throw new Error(`${pin} isn't in the catalog`);
      dependencies[companion] = catalog[pin];
    }
  }
  const bin = BINS[folder];
  return {
    name: publishedName(manifest.name, scope),
    version,
    description: manifest.description ?? `Gram's ${folder} package`,
    license: manifest.license,
    type: manifest.type,
    repository: {
      type: "git",
      url: `git+https://github.com/${repository}.git`,
      directory: `packages/${folder}`,
    },
    engines,
    exports: builtExports(manifest.exports),
    ...(bin === undefined
      ? {}
      : { bin: Object.fromEntries(Object.keys(bin).map((name) => [name, `./bin/${name}.mjs`])) }),
    files: ["dist", ...(bin === undefined ? [] : ["bin"]), ...(EXTRA_FILES[folder] ?? [])],
    dependencies,
    ...(Object.keys(peerDependencies).length === 0 ? {} : { peerDependencies }),
    publishConfig: { access: "public" },
    gram: { commit, built },
  };
};

/**
 * Whether a file under `src` is published, and how: `built` for TypeScript (its `.js` and `.d.ts`
 * come from `dist`), `copied` for anything else the code may read beside itself, `skipped` for
 * tests and their snapshots.
 */
export const sourceKind = (path) => {
  if (/(^|\/)__snapshots__\//.test(path) || /\.test\.[cm]?tsx?$/.test(path)) return "skipped";
  if (path.endsWith(".d.ts")) return "copied";
  return /\.tsx?$/.test(path) ? "built" : "copied";
};

/** The registry page's text for one package. */
export const readme = ({
  name,
  workspaceName,
  folder,
  source = `packages/${folder}`,
  repository,
  commit,
  version,
}) =>
  [
    `# ${name}`,
    "",
    `Gram's \`${folder}\` package (\`${workspaceName}\` in its source), built from`,
    `[${repository}](https://github.com/${repository}/tree/${commit}/${source}) at`,
    `\`${commit.slice(0, 9)}\` as version ${version}.`,
    "",
    "It is published for embedding and self-hosting Gram. The packages are released together:",
    "depend on one exact version of each, and on the exact versions this one names as peers.",
    `See [the packaging guide](https://github.com/${repository}/blob/${commit}/docs/PACKAGES.md).`,
    "",
  ].join("\n");

/** The registry tag a packed set is published under: `canary`, or `latest` for a release. */
export const distTag = ({ version, canary }) => {
  const prerelease = version.includes("-");
  if (canary !== prerelease) throw new Error(`${version} isn't a ${canary ? "canary" : "release"}`);
  return canary ? "canary" : "latest";
};

/** The packed packages, each after the ones it depends on. */
export const publishOrder = (packages) =>
  packages
    .map((entry) => {
      const index = [...PUBLISHED, ...PREBUILT.map((each) => each.folder)].indexOf(entry.folder);
      if (index < 0) throw new Error(`${entry.folder} isn't a published package`);
      return [index, entry];
    })
    .toSorted(([a], [b]) => a - b)
    .map(([, entry]) => entry);

/**
 * Packages a build of their own writes whole, manifest included: the folder it is named by, where
 * its source lives, the directory the build leaves, and the command that makes it. The web app's
 * is a browser bundle, so it is packed as it stands with only its name and version set.
 */
export const PREBUILT = [
  {
    folder: "web",
    source: "apps/web",
    directory: "apps/web/dist-embed",
    build: "bun run --filter @gram/web build:embed",
  },
];

/**
 * The manifest a prebuilt package is published with: its own, renamed into the scope and given
 * the version of this pack. Its build must already have left nothing a registry can't resolve.
 */
export const prebuiltManifest = ({
  manifest,
  source,
  version,
  scope,
  repository,
  commit,
  built,
}) => {
  if (!EXACT.test(version)) throw new Error(`Not an exact version: ${version}`);
  for (const section of ["dependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (!EXACT.test(spec)) {
        throw new Error(`${manifest.name}: ${name} must be an exact version, not ${spec}`);
      }
    }
  }
  if (manifest.exports === undefined) throw new Error(`${manifest.name} has no exports`);
  return {
    ...manifest,
    name: publishedName(manifest.name, scope),
    version,
    description: manifest.description ?? "Gram's web app, built to be mounted in another app",
    repository: {
      type: "git",
      url: `git+https://github.com/${repository}.git`,
      directory: source,
    },
    publishConfig: { access: "public" },
    gram: { commit, built },
  };
};

/** Every file a manifest's exports name. */
export const exportedFiles = (exports) =>
  Object.values(exports).flatMap((target) =>
    typeof target === "string" ? [target] : Object.values(target),
  );

/** The native modules a host bundle leaves to `require`: they load their own binaries. */
export const NATIVE = ["@parcel/watcher", "node-pty"];

/**
 * The `package.json` beside a standalone host bundle: only the native modules, at the exact
 * versions the workspace packages that use them pin. CommonJS, as the bundle is.
 */
export const hostManifest = ({ version, engines, catalog, manifests }) => {
  const dependencies = {};
  for (const name of NATIVE) {
    const spec = manifests.map((manifest) => manifest.dependencies?.[name]).find(Boolean);
    const resolved = spec === "catalog:" ? catalog[name] : spec;
    if (resolved === undefined || !EXACT.test(resolved)) {
      throw new Error(`${name} needs an exact version, not ${resolved}`);
    }
    dependencies[name] = resolved;
  }
  return { name: "gram-host", version, private: true, license: "MIT", engines, dependencies };
};
