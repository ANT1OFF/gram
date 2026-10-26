#!/usr/bin/env node
// Writes the packaged app's THIRD-PARTY-NOTICES.txt from what the production build ships:
//
// - every npm package a bundle carries, from the lists `bundled-packages.mjs` records as each
//   bundle builds (main, preload, the update helper, the server, its command worker, speech, web);
// - the packages electron-builder copies into app.asar.unpacked: the desktop app's production
//   dependencies (node-pty, sherpa-onnx and its platform addon) and Electron itself;
// - the libraries compiled into sherpa-onnx's addon, from native-components.json, which ship with
//   no notices of their own;
// - the notices already kept beside the motion kit's drawings and the terminal's symbol font.
//
// electron-builder ships the file in Resources/ (electron-builder.yml), afterPack fails a package
// without it and verify-package.mjs checks it covers every bundled package.
//
//   node tools/notices/generate.mjs [--out <file>]
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

import { BUNDLES, LISTS, ROOT } from "./bundled-packages.mjs";

export const OUT = join(ROOT, "out", "notices", "THIRD-PARTY-NOTICES.txt");
const TEXTS = join(ROOT, "tools", "notices", "texts");
const DESKTOP = join(ROOT, "apps", "desktop");

/** Header files node-pty compiles against; electron-builder.yml leaves them out of the package. */
const NOT_PACKAGED = new Set(["node-addon-api"]);

/** Files kept beside source Gram ships, copied in as they are. */
const KEPT_NOTICES = [
  {
    title: "Motion kit drawings",
    file: "apps/web/src/motion/THIRD-PARTY-NOTICES.md",
  },
  {
    title: "Terminal symbol font",
    file: "apps/web/src/panels/terminal/fonts/THIRD-PARTY-NOTICES.txt",
  },
];

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/i;
const NOT_LICENSE_FILE = /\.(?:[cm]?[jt]sx?|json|map|d\.ts)$/i;

const rule = (char) => char.repeat(78);
const toPosix = (path) => path.split(sep).join("/");

/** The license a package.json declares, in its several historical shapes. */
export function declaredLicense(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === "string") return license;
  if (license && typeof license.type === "string") return license.type;
  if (Array.isArray(licenses)) {
    const types = licenses.map((entry) => (typeof entry === "string" ? entry : entry?.type));
    if (types.every((type) => typeof type === "string")) return types.join(" OR ");
  }
  return "UNKNOWN";
}

const personName = (person) =>
  typeof person === "string" ? person.replace(/\s*[<(].*$/, "") : person?.name;

const sourceUrl = (manifest) => {
  const repository = manifest.repository;
  const url = typeof repository === "string" ? repository : repository?.url;
  if (typeof url === "string") {
    return url
      .replace(/^git\+/, "")
      .replace(/^git:\/\//, "https://")
      .replace(/^github:/, "https://github.com/")
      .replace(/\.git$/, "")
      .replace(/^([\w.-]+\/[\w.-]+)$/, "https://github.com/$1");
  }
  return typeof manifest.homepage === "string" ? manifest.homepage : undefined;
};

/** The license and notice files at the top of a package folder, sorted by name. */
export function licenseFiles(dir) {
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && !NOT_LICENSE_FILE.test(name))
    .filter((name) => statSync(join(dir, name)).isFile())
    .toSorted();
}

/** Reads one package folder into the record a notice is written from. */
export function readPackage(dir, root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return {
    name: manifest.name,
    version: manifest.version,
    license: declaredLicense(manifest),
    author: personName(manifest.author),
    source: sourceUrl(manifest),
    dir: toPosix(relative(root, dir)),
    files: licenseFiles(dir).map((name) => ({
      name,
      text: readFileSync(join(dir, name), "utf8").replaceAll("\r\n", "\n").trimEnd(),
    })),
  };
}

/** The bundle lists, keyed by bundle; fails if one is missing, since its packages would be too. */
export function readLists(lists = LISTS, expected = BUNDLES) {
  const missing = expected.filter((name) => !existsSync(join(lists, `${name}.json`)));
  if (missing.length > 0) {
    throw new Error(
      `no package list for ${missing.join(", ")} in ${lists}: build the web app and the desktop bundles first (bun run build:bundles)`,
    );
  }
  return new Map(
    expected.map((name) => [
      name,
      JSON.parse(readFileSync(join(lists, `${name}.json`), "utf8")).packages,
    ]),
  );
}

/**
 * The folders of the packages electron-builder copies into the app beside the bundles: `from`'s
 * production dependencies with theirs, and the optional ones installed for this platform.
 */
export function packagedDependencies(from = DESKTOP) {
  const found = new Map();
  const visit = (dir, names) => {
    const require = createRequire(join(dir, "package.json"));
    for (const name of names) {
      if (NOT_PACKAGED.has(name) || found.has(name)) continue;
      let manifestPath;
      try {
        manifestPath = require.resolve(`${name}/package.json`);
      } catch {
        // An optional dependency for another platform isn't installed, and isn't packaged.
        continue;
      }
      const packageDir = dirname(manifestPath);
      found.set(name, packageDir);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      visit(packageDir, [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ]);
    }
  };
  const manifest = JSON.parse(readFileSync(join(from, "package.json"), "utf8"));
  visit(from, Object.keys(manifest.dependencies ?? {}));
  return [...found.values()];
}

/** The Electron package the desktop app is built with: its runtime ships as the app itself. */
const electronDir = (from = DESKTOP) =>
  dirname(createRequire(join(from, "package.json")).resolve("electron/package.json"));

/** Every shipped package, once per name and version, with where it ships. */
export function collectPackages({ lists, packaged, electron, root = ROOT }) {
  const byDir = new Map();
  const add = (dir, place) => {
    const key = toPosix(relative(root, dir));
    const places = byDir.get(key) ?? new Set();
    places.add(place);
    byDir.set(key, places);
  };
  for (const [bundle, dirs] of lists) for (const dir of dirs) add(join(root, dir), bundle);
  for (const dir of packaged) add(dir, "native modules");
  if (electron) add(electron, "Electron runtime");

  const byId = new Map();
  for (const [dir, places] of byDir) {
    const pkg = readPackage(join(root, dir), root);
    const id = `${pkg.name}@${pkg.version}`;
    const seen = byId.get(id);
    if (seen) for (const place of places) seen.places.add(place);
    else byId.set(id, { ...pkg, places: new Set(places) });
  }
  return [...byId.values()].toSorted(
    (a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"),
  );
}

const standardText = (license) =>
  existsSync(join(TEXTS, `${license}.txt`)) ? `${license}.txt` : undefined;

function packageSection(pkg, referenced) {
  const lines = [rule("-"), `${pkg.name} ${pkg.version}`, `License: ${pkg.license}`];
  if (pkg.source) lines.push(`Source: ${pkg.source}`);
  lines.push(`Ships in: ${[...pkg.places].toSorted().join(", ")}`, "");
  if (pkg.files.length > 0) {
    for (const file of pkg.files) {
      if (pkg.files.length > 1) lines.push(`[${file.name}]`);
      lines.push(file.text, "");
    }
  } else {
    const text = standardText(pkg.license);
    if (text) referenced.add(text);
    lines.push(
      `This package ships no license file. Its package.json declares ${pkg.license}` +
        (pkg.author ? ` and names ${pkg.author} as its author` : "") +
        (text ? `; the ${pkg.license} text is under "License texts" below.` : "."),
      "",
    );
  }
  return lines.join("\n");
}

function componentSection(component, referenced) {
  for (const text of component.texts) referenced.add(text);
  return [
    rule("-"),
    `${component.name} ${component.version}`,
    `License: ${component.license}`,
    `Source: ${component.source}`,
    `Ships in: sherpa-onnx's native addon, ${component.where}`,
    `License text: ${component.texts.join(", ")} under "License texts" below.`,
    "",
  ].join("\n");
}

/** Reads native-components.json, failing when sherpa-onnx moved past the version it describes. */
export function readComponents(packages) {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "tools", "notices", "native-components.json"), "utf8"),
  );
  const sherpa = packages.find((pkg) => pkg.name === "sherpa-onnx-node");
  if (!sherpa) return [];
  if (sherpa.version !== manifest.sherpaOnnx) {
    throw new Error(
      `tools/notices/native-components.json describes sherpa-onnx ${manifest.sherpaOnnx}, but ${sherpa.version} ships: recheck the libraries its cmake/ pins and update the file`,
    );
  }
  return manifest.components;
}

/** The notices file's text. */
export function renderNotices({ packages, components, kept }) {
  const referenced = new Set();
  const packageSections = packages.map((pkg) => packageSection(pkg, referenced));
  const componentSections = components.map((component) => componentSection(component, referenced));
  const width = Math.max(...packages.map((pkg) => `${pkg.name} ${pkg.version}`.length));
  const index = packages.map((pkg) =>
    `  ${`${pkg.name} ${pkg.version}`.padEnd(width)}  ${pkg.license}`.trimEnd(),
  );

  const parts = [
    "GRAM THIRD-PARTY NOTICES",
    rule("="),
    "",
    "Gram includes the third-party software listed below. Each component remains under",
    "its own license, and nothing here changes those terms.",
    "",
    "Electron's license and Chromium's notices ship beside this file as LICENSE.electron.txt",
    "and LICENSES.chromium.html (Gram.app/Contents/Resources on macOS; next to the",
    "executable on Windows and Linux).",
    "",
    "This file is generated when Gram is built, from the packages in its production bundles",
    "and native modules.",
    "",
    "Contents",
    `  1. npm packages (${packages.length})`,
    ...(components.length > 0
      ? [`  2. Libraries compiled into sherpa-onnx (${components.length})`]
      : []),
    ...kept.map((notice, i) => `  ${i + (components.length > 0 ? 3 : 2)}. ${notice.title}`),
    `  ${kept.length + (components.length > 0 ? 3 : 2)}. License texts`,
    "",
    rule("="),
    "1. npm packages",
    rule("="),
    "",
    ...index,
    "",
    ...packageSections,
  ];
  if (components.length > 0) {
    parts.push(rule("="), "2. Libraries compiled into sherpa-onnx", rule("="), "");
    parts.push(...componentSections);
  }
  for (const notice of kept) {
    parts.push(rule("="), notice.title, rule("="), "", notice.text.trimEnd(), "");
  }
  parts.push(rule("="), "License texts", rule("="), "");
  for (const name of [...referenced].toSorted()) {
    parts.push(
      rule("-"),
      name,
      "",
      readFileSync(join(TEXTS, name), "utf8").replaceAll("\r\n", "\n").trimEnd(),
      "",
    );
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

/** Collects everything that ships and writes the notices to `out`; returns what it wrote. */
export function generate({ out = OUT, lists = LISTS } = {}) {
  const packages = collectPackages({
    lists: readLists(lists),
    packaged: packagedDependencies(),
    electron: electronDir(),
  });
  const components = readComponents(packages);
  const kept = KEPT_NOTICES.map((notice) => ({
    ...notice,
    text: readFileSync(join(ROOT, notice.file), "utf8"),
  }));
  const text = renderNotices({ packages, components, kept });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  return { out, packages: packages.length, components: components.length, bytes: text.length };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: "string", default: OUT } } });
  const result = generate({ out: values.out });
  console.log(
    `${toPosix(relative(process.cwd(), result.out))}: ${result.packages} packages, ${result.components} native libraries, ${(result.bytes / 1024).toFixed(0)} KiB`,
  );
}
