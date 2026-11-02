#!/usr/bin/env node
// Checks an unpacked `electron-builder --dir` build: bundle id, Electron's fuses, asar contents,
// minified bundles, native binaries for the right platform/arch, sherpa-onnx's addon (on macOS,
// without the GPL espeak-ng), the bundled web app, the third-party notices, and node-pty's
// spawn-helper exec bit (macOS).
//
// Linux ships without local dictation, so there it checks that no sherpa-onnx is packaged or
// noticed, that node-pty's compiled addon stays within Debian 12's glibc, and, on a Linux host of
// the package's arch, loads node-pty through the packaged app (tools/release-rc/native-probe.cjs).
// It then checks the AppImage and .deb electron-builder made beside the unpacked app: their
// metadata, desktop entry, icons, and that each carries the same app.asar and pty.node.
//
// The shipped bundles are minified with their comments stripped (shipped-code.ts), so what each
// one carries comes from the lists its build recorded (tools/notices/bundled-packages.mjs), matched
// to the packaged files by SHA-256. Run it after the build that made the package.
//
//   node scripts/verify-package.mjs [--release <dir>] [--platform darwin|win32|linux] [--arch arm64|x64]
//                                   [--lists <dir>] [--dir-only]
//
// `--dir-only` skips the Linux AppImage and .deb, for a `--dir` package.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

/** The package a `node_modules/...` folder holds: its innermost `node_modules` entry. */
const packageName = (dir) => {
  const parts = dir.slice(dir.lastIndexOf("node_modules/") + "node_modules/".length).split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
};

/**
 * Electron's fuses as each one must be in a package. `runAsNode` stays on for the release tool's
 * native probe; see electron-builder.yml.
 */
/** A fuse's byte in the wire: ASCII "1" or "0". */
const FUSE_ON = 0x31;
const FUSE_OFF = 0x30;

const FUSES = {
  RunAsNode: true,
  EnableCookieEncryption: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
};

/** The Node-side bundles in app.asar, by the names their builds record lists under. */
const NODE_BUNDLES = ["main", "preload", "server", "proc-worker", "speech"];

/** The lists in `dir` for NODE_BUNDLES, by name; a missing one is left out. */
const readBundleLists = (dir) =>
  new Map(
    NODE_BUNDLES.filter((name) => fs.existsSync(path.join(dir, `${name}.json`))).map((name) => {
      const list = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
      return [name, { bundle: name, packages: list.packages, chunks: list.chunks ?? [] }];
    }),
  );

const require = createRequire(import.meta.url);
const { findBinaries, findForeignBinaries, listFiles } = require("../build/native-binary.cjs");

const APP_ID = "io.github.ant1off.gram";
const PRODUCT = "Gram";
const ASAR_ENTRIES = [
  "package.json",
  "out/main/index.js",
  "out/server/server.js",
  "out/server/proc-worker.js",
  // The terminal emulator the server replays scrollback through; read from beside the bundle.
  "out/server/ghostty-vt.wasm",
  "out/preload/index.js",
  "out/speech/speech.js",
];

const { values } = parseArgs({
  options: {
    release: { type: "string", default: path.resolve(import.meta.dirname, "../release") },
    platform: { type: "string", default: process.platform },
    arch: { type: "string", default: process.arch },
    lists: {
      type: "string",
      default: path.resolve(import.meta.dirname, "../../../out/notices/lists"),
    },
    "dir-only": { type: "boolean", default: false },
  },
});
const { release, platform, arch, lists } = values;
/** Linux packages leave local dictation out: no sherpa-onnx ships (electron-builder.yml). */
const speech = platform !== "linux";

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Parses the JSON file index at the start of an asar archive. */
function readAsarIndex(file) {
  const fd = fs.openSync(file, "r");
  try {
    const prefix = Buffer.alloc(8);
    fs.readSync(fd, prefix, 0, 8, 0);
    const header = Buffer.alloc(prefix.readUInt32LE(4));
    fs.readSync(fd, header, 0, header.length, 8);
    // The header is a Chromium pickle: payload size, string length, then the JSON string.
    return JSON.parse(header.toString("utf8", 8, 8 + header.readUInt32LE(4)));
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads one packed (not unpacked) file's contents out of an asar archive. */
const readAsarFile = (file, entryPath) => readAsarBytes(file, entryPath).toString("utf8");

/** Reads one packed file's raw bytes out of an asar archive. */
function readAsarBytes(file, entryPath) {
  let node = readAsarIndex(file);
  for (const part of entryPath.split("/")) node = node.files[part];
  const fd = fs.openSync(file, "r");
  try {
    const prefix = Buffer.alloc(8);
    fs.readSync(fd, prefix, 0, 8, 0);
    const contents = Buffer.alloc(node.size);
    fs.readSync(fd, contents, 0, node.size, 8 + prefix.readUInt32LE(4) + Number(node.offset));
    return contents;
  } finally {
    fs.closeSync(fd);
  }
}

function asarEntries(node, prefix = "") {
  return Object.entries(node.files ?? {}).flatMap(([name, entry]) => {
    const p = prefix ? `${prefix}/${name}` : name;
    return entry.files ? asarEntries(entry, p) : [{ path: p, unpacked: entry.unpacked === true }];
  });
}

// Walks by hand: a recursive readdir follows the framework symlinks and counts them twice.
function dirSize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) size += dirSize(p);
    else if (entry.isFile()) size += fs.statSync(p).size;
  }
  return size;
}

const archSuffix = arch === "x64" ? "" : `-${arch}`;
let appDir;
let resources;
if (platform === "darwin") {
  appDir = path.join(release, `mac${archSuffix}`, `${PRODUCT}.app`);
  resources = path.join(appDir, "Contents", "Resources");
} else if (platform === "win32") {
  appDir = path.join(release, `win${archSuffix}-unpacked`);
  resources = path.join(appDir, "resources");
} else if (platform === "linux") {
  appDir = path.join(release, `linux${archSuffix}-unpacked`);
  resources = path.join(appDir, "resources");
} else {
  console.error(`unsupported platform: ${platform}`);
  process.exit(2);
}

if (!fs.existsSync(appDir)) {
  check("packaged app exists", false, appDir);
  process.exit(1);
}
console.log(`${appDir} (${(dirSize(appDir) / 1024 / 1024).toFixed(1)} MiB)`);

if (platform === "darwin") {
  const plist = path.join(appDir, "Contents", "Info.plist");
  const bundleId = execFileSync(
    "plutil",
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist],
    {
      encoding: "utf8",
    },
  ).trim();
  check("bundle id", bundleId === APP_ID, bundleId);
} else if (platform === "linux") {
  check("Gram Linux executable present", fs.existsSync(path.join(appDir, "gram")));
} else {
  check(`${PRODUCT}.exe present`, fs.existsSync(path.join(appDir, `${PRODUCT}.exe`)));
  check("no Squirrel updater", !fs.existsSync(path.join(appDir, "Squirrel.exe")));
}

// The fuses as electron-builder flipped them, read with the @electron/fuses it flips them with.
{
  const builder = createRequire(require.resolve("electron-builder/package.json"));
  const { getCurrentFuseWire, FuseV1Options } = createRequire(
    builder.resolve("app-builder-lib/package.json"),
  )("@electron/fuses");
  const binary =
    platform === "darwin"
      ? appDir
      : path.join(appDir, platform === "win32" ? `${PRODUCT}.exe` : "gram");
  const wire = await getCurrentFuseWire(binary);
  const wrong = Object.entries(FUSES)
    .filter(([fuse, on]) => wire[FuseV1Options[fuse]] !== (on ? FUSE_ON : FUSE_OFF))
    .map(([fuse, on]) => `${fuse} should be ${on ? "on" : "off"}`);
  check("Electron fuses", wrong.length === 0, wrong.join(", ") || "as electron-builder.yml sets");
  if (platform === "linux") {
    // Electron 45 validates ASAR integrity on macOS and Windows only; the fuse is set but inert.
    console.log("note  ASAR integrity: fuse on, not enforced by Electron on Linux");
  }
}

const asar = path.join(resources, "app.asar");
if (fs.existsSync(asar)) {
  check("app.asar present", true);
  const entries = asarEntries(readAsarIndex(asar));
  const packed = new Set(entries.filter((e) => !e.unpacked).map((e) => e.path));
  const missing = ASAR_ENTRIES.filter((e) => !packed.has(e));
  check("asar holds main, server and preload bundles", missing.length === 0, missing.join(", "));
  // A platform `files` list of only exclusions makes electron-builder pack the whole app dir,
  // which put src/, the tests, scripts and configs in the asar.
  const stray = entries
    .map((e) => e.path)
    .filter((p) => p !== "package.json" && !/^(out|node_modules)\//.test(p));
  check(
    "asar holds only package.json, out/ and node_modules/",
    stray.length === 0,
    stray.join(", "),
  );
  const tests = entries.map((e) => e.path).filter((p) => /\.(test|spec)\.[cm]?[jt]sx?\b/.test(p));
  check("no test files in the asar", tests.length === 0, tests.join(", "));
  if (!speech) {
    const sherpaEntries = entries.map((e) => e.path).filter((p) => /(^|\/)sherpa-onnx/.test(p));
    check("no sherpa-onnx in the asar", sherpaEntries.length === 0, sherpaEntries.join(", "));
  }
  const packedNatives = [...packed].filter((p) => p.endsWith(".node"));
  check("no native modules inside the asar", packedNatives.length === 0, packedNatives.join(", "));
  // Main must only fork the server. A bundle that requires it runs the server in the main
  // process at load, which hangs startup before app.whenReady.
  const mainRequiresServer = /require\(["'][^"']*server\.m?js["']\)/.test(
    readAsarFile(asar, "out/main/index.js"),
  );
  check("main bundle doesn't load the server bundle", !mainRequiresServer);

  // What each bundle carries, from the lists its build recorded. Every JavaScript file under out/
  // must be a chunk some list names, with the same SHA-256, and every listed chunk must ship.
  const bundles = readBundleLists(lists);
  const shippedScripts = [...packed].filter((p) => /^out\/.+\.[cm]?js$/.test(p));
  const byHash = new Map(
    [...bundles.values()].flatMap((b) => b.chunks.map((c) => [c.sha256, { bundle: b, chunk: c }])),
  );
  const unlisted = [];
  const shippedChunks = new Set();
  for (const p of shippedScripts) {
    const digest = createHash("sha256").update(readAsarBytes(asar, p)).digest("hex");
    const found = byHash.get(digest);
    if (found) shippedChunks.add(found.chunk);
    else unlisted.push(p);
  }
  const unshipped = [...bundles.values()].flatMap((b) =>
    b.chunks.filter((c) => !shippedChunks.has(c)).map((c) => `${b.bundle}/${c.file}`),
  );
  check(
    "each packaged bundle matches the list its build recorded",
    bundles.size === NODE_BUNDLES.length && unlisted.length === 0 && unshipped.length === 0,
    bundles.size !== NODE_BUNDLES.length
      ? `lists missing in ${lists} (run the build that made this package)`
      : [...unlisted, ...unshipped.map((c) => `${c} not packaged`)].join(", ") ||
          `${shippedScripts.length} files`,
  );
  const packagesOf = (name) => new Set((bundles.get(name)?.packages ?? []).map(packageName));
  const externalsOf = (...names) =>
    new Set(names.flatMap((name) => (bundles.get(name)?.chunks ?? []).flatMap((c) => c.externals)));

  // The shipped code is minified, with no source maps and only license comments (shipped-code.ts).
  const readable = [];
  for (const p of shippedScripts) {
    const code = readAsarFile(asar, p);
    if (/^\/\/#(?:end)?region\b/m.test(code) || /^\s*\/\*\*\s*$/m.test(code)) readable.push(p);
    if (/[#@] sourceMappingURL=/.test(code)) readable.push(`${p} (source map link)`);
  }
  const maps = [...packed].filter((p) => p.startsWith("out/") && p.endsWith(".map"));
  check(
    "bundles minified, without source comments or source maps",
    readable.length === 0 && maps.length === 0,
    [...readable, ...maps].join(", "),
  );

  // The server and its command worker must carry their dependencies: only Node built-ins and the
  // externalized natives may be required at runtime, because the asar holds no other node_modules.
  // `@parcel/watcher` is imported lazily by Linux dev only and never packaged (checked below).
  const builtins = new Set(require("node:module").builtinModules);
  const externals = new Set(["node-pty", "@parcel/watcher"]);
  const runtimeRequires = [...externalsOf("server", "proc-worker")].filter((name) => {
    const root = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
    return !name.startsWith("node:") && !builtins.has(root) && !externals.has(root);
  });
  check(
    "server bundle requires nothing outside Node and the natives",
    runtimeRequires.length === 0,
    runtimeRequires.join(", "),
  );

  // Dependencies that break when left unbundled (ESM-only, or loaded through dynamic paths).
  const bundled = ["pino", "@modelcontextprotocol/sdk", "@ai-sdk/openai-compatible", "smol-toml"];
  const notBundled = bundled.filter((dep) => !packagesOf("server").has(dep));
  check(
    "server bundle includes pino, MCP SDK, AI SDK and smol-toml",
    notBundled.length === 0,
    notBundled.join(", "),
  );
  check("main bundle includes pino for the desktop log", packagesOf("main").has("pino"));
  // Signed macOS installs update through it; the asar holds no node_modules to load it from.
  check(
    "main bundle includes electron-updater",
    packagesOf("main").has("electron-updater") && !externalsOf("main").has("electron-updater"),
  );
  // Source comments may name PRs (owner/repo#123); minifying strips them, and this checks it did.
  const prRefs = shippedScripts.filter((p) => /ANT1OFF\/gram#\d/.test(readAsarFile(asar, p)));
  check("no internal PR references in the bundles", prRefs.length === 0, prRefs.join(", "));
} else {
  check("app.asar present", false, asar);
}

const unpacked = path.join(resources, "app.asar.unpacked");
const natives = findBinaries(unpacked);
const foreign = findForeignBinaries(unpacked, platform, arch);
check(
  `unpacked natives target ${platform}-${arch}`,
  foreign.length === 0,
  foreign.length > 0
    ? foreign.map((b) => `${path.relative(unpacked, b.file)} (${b.platform}-${b.arch})`).join(", ")
    : `${natives.length} binaries`,
);

// No shipped target uses @parcel/watcher: macOS and Windows watch with fs.watch, and only Linux dev
// imports it.
const parcelPackages = new Set(
  listFiles(path.join(unpacked, "node_modules", "@parcel"))
    .map((f) => path.relative(path.join(unpacked, "node_modules"), f).split(/[\\/]/))
    .filter(([, name]) => /^watcher(-.+)?$/.test(name ?? ""))
    .map(([scope, name]) => `${scope}/${name}`),
);
check("@parcel/watcher not packaged", parcelPackages.size === 0, [...parcelPackages].join(", "));

if (platform === "darwin") {
  // The bucket signer's rcodesign reads `@` as a settings scope, so any Mach-O under an `@` path
  // fails signing before upload.
  const scoped = findBinaries(appDir)
    .map((b) => path.relative(appDir, b.file))
    .filter((f) => f.includes("@"));
  check("no Mach-O under an @ path", scoped.length === 0, scoped.join(", "));
}

// The Terminal tab's pty; on Windows this prebuild carries ConPTY (conpty.node) and winpty.
const ptyPrebuild =
  platform === "linux"
    ? path.join("node_modules", "node-pty", "build", "Release")
    : path.join("node_modules", "node-pty", "prebuilds", `${platform}-${arch}`);
check(
  `node-pty ${platform}-${arch} native addon bundled`,
  fs.existsSync(path.join(unpacked, ptyPrebuild, "pty.node")),
  ptyPrebuild,
);

// Local dictation's recogniser: sherpa-onnx's addon and the ONNX Runtime it links, beside each
// other and outside the asar, with the JS that requires them.
const sherpaPackage = path.join(
  "node_modules",
  `sherpa-onnx-${platform === "win32" ? "win" : platform}-${arch}`,
);
const onnxRuntime =
  platform === "win32"
    ? "onnxruntime.dll"
    : platform === "linux"
      ? "libonnxruntime.so"
      : "libonnxruntime.dylib";
if (speech) {
  check(
    `sherpa-onnx ${platform}-${arch} addon bundled`,
    ["sherpa-onnx.node", onnxRuntime].every((file) =>
      fs.existsSync(path.join(unpacked, sherpaPackage, file)),
    ) && fs.existsSync(path.join(unpacked, "node_modules", "sherpa-onnx-node", "addon.js")),
    sherpaPackage,
  );
} else {
  // Its Linux builds carry text-to-speech, which links GPL code (espeak-ng, piper-phonemize).
  const sherpa = fs.existsSync(path.join(unpacked, "node_modules"))
    ? fs.readdirSync(path.join(unpacked, "node_modules")).filter((n) => n.startsWith("sherpa-onnx"))
    : [];
  const onnx = listFiles(unpacked).filter((f) => /onnx|espeak|piper/i.test(path.basename(f)));
  check(
    "no sherpa-onnx or ONNX Runtime packaged (Linux ships without dictation)",
    sherpa.length === 0 && onnx.length === 0,
    [...sherpa, ...onnx.map((f) => path.relative(unpacked, f))].join(", "),
  );
}

// The npm darwin-arm64 build carries text-to-speech, and up to 1.13.8 statically linked espeak-ng
// (GPL-3.0-or-later) through piper-phonemize for it; Gram ships the speech-recognition-only build
// from tools/sherpa-onnx instead.
// Case matters: "OfflineSpeaker" holds "eSpeak".
if (platform === "darwin") {
  const gpl = findBinaries(path.join(unpacked, sherpaPackage)).flatMap(({ file }) => {
    const symbols = execFileSync("nm", ["-a", file], { encoding: "utf8", maxBuffer: 256 << 20 });
    const found = symbols.split("\n").filter((line) => /espeak|Espeak|piper|Piper/.test(line));
    return found.length > 0 ? [`${path.basename(file)} (${found.length} symbols)`] : [];
  });
  check("sherpa-onnx without espeak-ng or piper-phonemize", gpl.length === 0, gpl.join(", "));
}

// electron-updater names its download cache from this; it names no feed, which is set in code.
const updateConfig = path.join(resources, "app-update.yml");
const updateConfigText = fs.existsSync(updateConfig) ? fs.readFileSync(updateConfig, "utf8") : "";
check(
  "app-update.yml names only the updater cache",
  /^updaterCacheDirName: gram-updater$/m.test(updateConfigText) &&
    !/^\s*(provider|url|owner|repo|token)\s*:/m.test(updateConfigText),
  updateConfig,
);

// The notices tools/notices/generate.mjs writes at build time. Each section opens with a rule, then
// "<name> <version>" and its license.
const noticesFile = path.join(resources, "THIRD-PARTY-NOTICES.txt");
const notices = fs.existsSync(noticesFile) ? fs.readFileSync(noticesFile, "utf8") : "";
check("THIRD-PARTY-NOTICES.txt present and not empty", notices.trim().length > 0, noticesFile);
if (notices && fs.existsSync(asar)) {
  const noticed = new Set(
    [...notices.matchAll(/^-{78}\n(\S+) \S+\nLicense: /gm)].map((match) => match[1]),
  );
  // The web app's packages are covered by the generator's own check of its list.
  const uncovered = new Set();
  for (const bundle of readBundleLists(lists).values())
    for (const name of bundle.packages.map(packageName))
      if (!noticed.has(name)) uncovered.add(name);
  const nativePackages = ["electron", "node-pty"];
  if (speech) nativePackages.push("sherpa-onnx-node", path.basename(sherpaPackage));
  for (const name of nativePackages) if (!noticed.has(name)) uncovered.add(name);
  if (!speech) {
    // Notices for what doesn't ship would claim it does.
    const sherpaNotices = [...noticed].filter((name) => name.startsWith("sherpa-onnx"));
    check(
      "notices name no sherpa-onnx package or library",
      sherpaNotices.length === 0 && !notices.includes("Libraries compiled into sherpa-onnx"),
      sherpaNotices.join(", "),
    );
  }
  check(
    "notices cover every bundled and native package",
    noticed.size > 0 && uncovered.size === 0,
    uncovered.size > 0 ? [...uncovered].join(", ") : `${noticed.size} packages`,
  );
}

const webIndex = path.join(resources, "web", "index.html");
check("web index.html bundled", fs.existsSync(webIndex));
check("web assets bundled", listFiles(path.join(resources, "web", "assets")).length > 0);

if (platform === "darwin") {
  const helpers = listFiles(unpacked).filter((f) => path.basename(f) === "spawn-helper");
  if (helpers.length === 0) {
    console.log("skip  spawn-helper: node-pty is not packaged");
  }
  for (const helper of helpers) {
    const mode = fs.statSync(helper).mode;
    check("spawn-helper executable", (mode & 0o111) === 0o111, path.relative(unpacked, helper));
  }
}

const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const mib = (file) => `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MiB`;

/** A .desktop file's [Desktop Entry] keys. */
const desktopEntry = (file) =>
  Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => /^[A-Za-z]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

/** Checks the keys a Linux artifact's desktop entry must carry. */
const checkEntry = (label, file, exec) => {
  if (!fs.existsSync(file)) return check(`${label} desktop entry`, false, file);
  const entry = desktopEntry(file);
  const wrong = Object.entries({
    Name: "Gram",
    Exec: exec,
    Icon: "gram",
    Type: "Application",
    Categories: "Development;",
    StartupWMClass: "gram",
  })
    .filter(([key, want]) => entry[key] !== want)
    .map(([key, want]) => `${key}=${entry[key] ?? ""} (want ${want})`);
  check(`${label} desktop entry`, wrong.length === 0, wrong.join(", ") || "gram.desktop");
};

if (platform === "linux") {
  const ptyDir = path.join(unpacked, "node_modules", "node-pty");
  const ptyAddon = path.join(ptyDir, "build", "Release", "pty.node");
  // Only the addon: the gyp Makefiles, objects and config.gypi name the build machine's paths.
  const ptyExtra = listFiles(path.join(ptyDir, "build"))
    .concat(listFiles(path.join(ptyDir, "prebuilds")))
    .filter((f) => f !== ptyAddon)
    .map((f) => path.relative(ptyDir, f));
  check("node-pty ships only build/Release/pty.node", ptyExtra.length === 0, ptyExtra.join(", "));

  // Built on Ubuntu 24.04 (glibc 2.39), it has to load on Debian 12 (glibc 2.36).
  if (fs.existsSync(ptyAddon)) {
    let symbols;
    try {
      symbols = execFileSync("objdump", ["-T", ptyAddon], { encoding: "utf8" });
    } catch {
      console.log("skip  node-pty's glibc floor: no objdump");
    }
    if (symbols !== undefined) {
      const versions = [...symbols.matchAll(/GLIBC_(\d+)\.(\d+)/g)].map(([, a, b]) => [+a, +b]);
      const [major, minor] = versions.reduce(
        (max, v) => (v[0] > max[0] || (v[0] === max[0] && v[1] > max[1]) ? v : max),
        [0, 0],
      );
      check(
        "node-pty needs glibc 2.36 or older (Debian 12)",
        major === 2 && minor <= 36,
        `GLIBC_${major}.${minor}`,
      );
    }
  }

  // node-pty loading in the packaged Electron, as Node, and running a shell through a pty; and
  // sherpa-onnx-node failing to resolve. Only a host that can run the package can do this.
  if (process.platform === "linux" && process.arch === arch) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gram-native-probe-"));
    try {
      const marker = `GRAM_NATIVE_${randomBytes(4).toString("hex")}`;
      const probe = path.resolve(import.meta.dirname, "../../../tools/release-rc/native-probe.cjs");
      let output = "";
      try {
        output = execFileSync(
          path.join(appDir, "gram"),
          [probe, path.join(resources, "app.asar"), scratch, marker, "no-speech"],
          {
            encoding: "utf8",
            env: { PATH: "/usr/bin:/bin", HOME: scratch, ELECTRON_RUN_AS_NODE: "1" },
            timeout: 60_000,
          },
        );
      } catch (error) {
        output = `${error.stdout ?? ""}${error.stderr ?? ""}` || String(error);
      }
      const runtime = JSON.parse(output.split("\n").find((line) => line.startsWith("{")) ?? "{}");
      const electron = JSON.parse(
        fs.readFileSync(require.resolve("electron/package.json"), "utf8"),
      ).version;
      check(
        "packaged app loads node-pty and runs a pty; sherpa-onnx doesn't resolve",
        output.includes("NATIVE OK") && runtime.electron === electron && runtime.arch === arch,
        output.includes("NATIVE OK")
          ? `Electron ${runtime.electron} ${runtime.arch}`
          : output.trim(),
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  } else {
    console.log(`skip  native probe: needs a linux-${arch} host`);
  }

  if (!values["dir-only"]) verifyLinuxArtifacts();
}

/** The AppImage and .deb electron-builder made from the unpacked app checked above. */
function verifyLinuxArtifacts() {
  const { version } = JSON.parse(
    fs.readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
  );
  // electron-builder's ${arch}, which is each format's own name for the arch.
  const debArch = { x64: "amd64", arm64: "arm64" }[arch] ?? arch;
  const appImageArch = { x64: "x86_64", arm64: "arm64" }[arch] ?? arch;
  const reference = {
    "resources/app.asar": sha(path.join(resources, "app.asar")),
    "resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node": sha(
      path.join(unpacked, "node_modules", "node-pty", "build", "Release", "pty.node"),
    ),
    gram: sha(path.join(appDir, "gram")),
  };
  const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

  /** The packaged app inside an extracted artifact matches the unpacked one, without sherpa. */
  const checkPayload = (label, root) => {
    const differ = Object.entries(reference)
      .filter(
        ([rel, hash]) => !fs.existsSync(path.join(root, rel)) || sha(path.join(root, rel)) !== hash,
      )
      .map(([rel]) => rel);
    check(
      `${label} carries the verified app.asar, pty.node and executable`,
      differ.length === 0,
      differ.join(", "),
    );
    const web = path.join(root, "resources", "web", "index.html");
    check(
      `${label} carries the web app and notices`,
      fs.existsSync(web) && fs.existsSync(path.join(root, "resources", "THIRD-PARTY-NOTICES.txt")),
    );
    const sherpa = listFiles(root).filter((f) =>
      /sherpa-onnx|onnxruntime/i.test(path.relative(root, f)),
    );
    check(
      `${label} holds no sherpa-onnx`,
      sherpa.length === 0,
      sherpa.map((f) => path.relative(root, f)).join(", "),
    );
  };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gram-linux-artifacts-"));
  try {
    // The .deb, read with dpkg-deb.
    const deb = path.join(release, `gram_${version}_${debArch}.deb`);
    if (!fs.existsSync(deb)) {
      check(".deb present", false, deb);
    } else {
      check(".deb present", true, `${path.basename(deb)} (${mib(deb)})`);
      const field = (name) =>
        execFileSync("dpkg-deb", ["-f", deb, name], { encoding: "utf8" }).trim();
      check("deb Package is gram", field("Package") === "gram", field("Package"));
      check("deb Version", field("Version") === version, field("Version"));
      check(
        `deb Architecture ${debArch}`,
        field("Architecture") === debArch,
        field("Architecture"),
      );
      check(
        "deb Maintainer set",
        /^.+ <[^>]+@[^>]+>$/.test(field("Maintainer")),
        field("Maintainer"),
      );
      const depends = field("Depends").split(/,\s*/);
      check(
        "deb Depends on GTK, NSS and libsecret, not on an agent CLI",
        ["libgtk-3-0", "libnss3", "libsecret-1-0", "libgbm1", "libasound2"].every((d) =>
          depends.includes(d),
        ) && !depends.some((d) => /claude|codex|nodejs|^git\b/.test(d)),
        field("Depends"),
      );
      check(
        "deb Recommends git",
        field("Recommends").split(/,\s*/).includes("git"),
        field("Recommends"),
      );
      const root = path.join(scratch, "deb");
      execFileSync("dpkg-deb", ["-x", deb, root]);
      checkPayload("deb", path.join(root, "opt", "Gram"));
      checkEntry(
        "deb",
        path.join(root, "usr", "share", "applications", "gram.desktop"),
        "/opt/Gram/gram %U",
      );
      const icons = ICON_SIZES.filter(
        (n) =>
          !fs.existsSync(
            path.join(root, "usr", "share", "icons", "hicolor", `${n}x${n}`, "apps", "gram.png"),
          ),
      );
      check(
        "deb installs the hicolor icons",
        icons.length === 0,
        icons.map((n) => `${n}x${n}`).join(", ") || `${ICON_SIZES.length} sizes`,
      );
    }

    // The AppImage, extracted by its own runtime (no FUSE needed).
    const appImage = path.join(release, `gram_${version}_${appImageArch}.AppImage`);
    if (!fs.existsSync(appImage)) {
      check("AppImage present", false, appImage);
    } else {
      check(
        "AppImage present and executable",
        (fs.statSync(appImage).mode & 0o111) === 0o111,
        `${path.basename(appImage)} (${mib(appImage)})`,
      );
      if (process.platform === "linux" && process.arch === arch) {
        const cwd = path.join(scratch, "appimage");
        fs.mkdirSync(cwd);
        execFileSync(appImage, ["--appimage-extract"], { cwd, stdio: "ignore" });
        const root = path.join(cwd, "squashfs-root");
        checkPayload("AppImage", root);
        // No `--no-sandbox`: AppRun adds it only where user namespaces are refused.
        checkEntry("AppImage", path.join(root, "gram.desktop"), "AppRun %U");
        const icons = ICON_SIZES.filter(
          (n) =>
            !fs.existsSync(
              path.join(root, "usr", "share", "icons", "hicolor", `${n}x${n}`, "apps", "gram.png"),
            ),
        );
        check(
          "AppImage carries the hicolor icons",
          icons.length === 0,
          icons.map((n) => `${n}x${n}`).join(", ") || `${ICON_SIZES.length} sizes`,
        );
      } else {
        console.log(`skip  AppImage contents: extracting needs a linux-${arch} host`);
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
