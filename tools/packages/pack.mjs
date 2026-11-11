#!/usr/bin/env node
// Packs the published workspace packages as registry tarballs, from an existing build
// (`bun run typecheck` emits each package's `dist`). Publishes nothing.
//
//   node tools/packages/pack.mjs --canary --scope @owner [--out out/packages]
//   node tools/packages/pack.mjs --release v1.2.3 --scope @owner
//
// See docs/PACKAGES.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  BINS,
  canaryVersion,
  EXTRA_FILES,
  publishManifest,
  PUBLISHED,
  readme,
  releaseVersion,
  sourceKind,
} from "./lib.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    canary: { type: "boolean", default: false },
    release: { type: "string" },
    scope: { type: "string" },
    repository: { type: "string" },
    out: { type: "string", default: "out/packages" },
  },
});
if (values.canary === (values.release !== undefined)) {
  throw new Error("Pass exactly one of --canary and --release <tag>");
}
if (values.scope === undefined) throw new Error("Pass --scope, the registry scope to publish in");

const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const filesUnder = (directory, prefix = "") =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(directory, entry.name), `${prefix}${entry.name}/`)
      : entry.isFile()
        ? [`${prefix}${entry.name}`]
        : [],
  );

const workspace = json("package.json");
const commit = git("rev-parse", "HEAD");
const version =
  values.release === undefined
    ? canaryVersion({
        base: workspace.version,
        committedAt: git("show", "-s", "--format=%cI", "HEAD"),
        commit,
      })
    : releaseVersion({ base: workspace.version, tag: values.release });
const repository =
  values.repository ??
  /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(git("remote", "get-url", "origin"))?.[1];
if (repository === undefined) throw new Error("Pass --repository <owner>/<name>");

const out = resolve(root, values.out);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "stage"), { recursive: true });

const manifests = Object.fromEntries(
  PUBLISHED.map((folder) => [folder, json(`packages/${folder}/package.json`)]),
);
const published = Object.values(manifests).map((manifest) => manifest.name);
const packed = [];
for (const folder of PUBLISHED) {
  const source = join(root, "packages", folder);
  const stage = join(out, "stage", folder);
  const manifest = publishManifest({
    manifest: manifests[folder],
    folder,
    catalog: workspace.workspaces.catalog,
    published,
    version,
    scope: values.scope,
    repository,
    commit,
    engines: { node: workspace.engines.node },
    built: { typescript: workspace.workspaces.catalog.typescript, node: process.versions.node },
  });

  // Walk the sources, not `dist`: an incremental build leaves the output of deleted files behind.
  for (const path of filesUnder(join(source, "src"))) {
    const kind = sourceKind(path);
    if (kind === "skipped") continue;
    const copies =
      kind === "copied"
        ? [[join(source, "src", path), path]]
        : [".js", ".js.map", ".d.ts"].map((extension) => {
            const built = path.replace(/\.tsx?$/, extension);
            return [join(source, "dist", built), built];
          });
    for (const [from, to] of copies) {
      if (!existsSync(from)) {
        throw new Error(`${folder}: ${to} isn't built. Run \`bun run typecheck\` first.`);
      }
      mkdirSync(dirname(join(stage, "dist", to)), { recursive: true });
      cpSync(from, join(stage, "dist", to));
    }
  }
  for (const extra of EXTRA_FILES[folder] ?? []) {
    cpSync(join(source, extra), join(stage, extra), { recursive: true });
  }
  for (const [name, target] of Object.entries(BINS[folder] ?? {})) {
    if (!existsSync(join(stage, target))) throw new Error(`${folder}: ${name} has no ${target}`);
    mkdirSync(join(stage, "bin"), { recursive: true });
    writeFileSync(join(stage, "bin", `${name}.mjs`), `#!/usr/bin/env node\nimport ".${target}";\n`);
    chmodSync(join(stage, "bin", `${name}.mjs`), 0o755);
  }
  // Built, the server starts this machine's host from `gram-host.js` beside the module that asks
  // for it (`host/child.ts`); a bundle puts the whole host there, a package the host's own entry.
  if (folder === "server") {
    writeFileSync(join(stage, "dist/host/gram-host.js"), 'import "./main.js";\n');
  }
  for (const entry of Object.values(manifest.exports)) {
    for (const file of Object.values(entry)) {
      if (!existsSync(join(stage, file))) throw new Error(`${folder}: export ${file} is missing`);
    }
  }
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(stage, "README.md"),
    readme({
      name: manifest.name,
      workspaceName: manifests[folder].name,
      folder,
      repository,
      commit,
      version,
    }),
  );
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));

  // The tarball only: no scripts run, and no registry or login is read.
  const [{ filename }] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", out], {
      cwd: stage,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  packed.push({
    folder,
    workspaceName: manifests[folder].name,
    name: manifest.name,
    version,
    tarball: filename,
    sha256: createHash("sha256")
      .update(readFileSync(join(out, filename)))
      .digest("hex"),
  });
}

writeFileSync(
  join(out, "packages.json"),
  `${JSON.stringify({ version, commit, repository, scope: values.scope, canary: values.canary, packages: packed }, null, 2)}\n`,
);
for (const entry of packed) console.log(`${entry.name}@${entry.version}  ${entry.tarball}`);
