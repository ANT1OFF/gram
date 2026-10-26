// Pure parts of the private RC release script (tools/release-rc/rc.mjs): versions, notes, assets,
// test summaries and the release record. No process, file or network access here.

export const REPO = "ANT1OFF/gram";
const RC = /^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/;
const DRY_RUN = /^0\.0\.0-dryrun\.(\d+)$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** `{ core: [major, minor, patch], pre: identifiers }`, or undefined for anything else. */
export function parseVersion(version) {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  const pre = match[4] === undefined ? [] : match[4].split(".");
  if (pre.some((id) => id === "" || (/^\d+$/.test(id) && id.length > 1 && id.startsWith("0"))))
    return undefined;
  return { core: [1, 2, 3].map((i) => Number(match[i])), pre };
}

/** Semver precedence: negative, zero or positive. */
export function compareVersions(a, b) {
  const x = parseVersion(a),
    y = parseVersion(b);
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i],
      q = y.pre[i];
    if (p === q) continue;
    const pn = /^\d+$/.test(p),
      qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return x.pre.length - y.pre.length;
}

const isRcVersion = (version) => RC.test(version);
export const isDryRunVersion = (version) => DRY_RUN.test(version);

/** Versions of `v*` tags, highest first; other tags are ignored. */
export function tagVersions(tags) {
  return tags
    .filter((tag) => tag.startsWith("v") && parseVersion(tag.slice(1)))
    .map((tag) => tag.slice(1))
    .toSorted((a, b) => compareVersions(b, a));
}

/**
 * The next RC after the highest `v*` tag, or main's own version when that is an RC nobody has
 * tagged yet. A stable highest tag has no obvious next RC, so it asks for an explicit version.
 */
export function nextRcVersion(tags, mainVersion) {
  const highest = tagVersions(tags)[0];
  if (isRcVersion(mainVersion) && (!highest || compareVersions(mainVersion, highest) > 0))
    return mainVersion;
  if (!highest) throw new Error("No v* tag to count from; pass the version, e.g. 0.1.0-rc.1.");
  const match = RC.exec(highest);
  if (!match)
    throw new Error(`The highest tag v${highest} is stable; pass the next RC version explicitly.`);
  return `${match[1]}.${match[2]}.${match[3]}-rc.${Number(match[4]) + 1}`;
}

const STABLE_PATH =
  "Stable releases take bun run release:rc --stable <version>; see docs/RELEASING.md.";

/**
 * The version each of main's four version fields carries: the release-please manifest, the root
 * and desktop `package.json`, and the desktop entry in `bun.lock` (whose text is JSON with
 * trailing commas, so it is matched rather than parsed).
 */
export function versionFields({ manifest, rootPackage, desktopPackage, lock }) {
  return {
    manifest: JSON.parse(manifest)["."],
    root: JSON.parse(rootPackage).version,
    desktop: JSON.parse(desktopPackage).version,
    lock: /"apps\/desktop": \{\s*"name": "@gram\/desktop",\s*"version": "([^"]+)"/.exec(lock)?.[1],
  };
}

/**
 * Refuses a stable version the stable path must not cut: not stable, a tag that exists, not newer
 * than every tag, or not what all four of main's version fields say (the release PR sets them).
 */
export function validateStableTarget({ version, tags, fields }) {
  const parsed = parseVersion(version);
  if (!parsed || parsed.pre.length)
    throw new Error(`${version} is not a stable version like 1.0.0.`);
  if (tags.includes(`v${version}`)) throw new Error(`Tag v${version} already exists.`);
  const highest = tagVersions(tags)[0];
  if (highest && compareVersions(version, highest) <= 0)
    throw new Error(`${version} is not newer than v${highest}; installs would not offer it.`);
  const wrong = Object.entries(fields).filter(([, value]) => value !== version);
  if (wrong.length)
    throw new Error(
      `main's version fields must all read ${version} (merge the release PR first): ` +
        wrong.map(([field, value]) => `${field} is ${value ?? "missing"}`).join(", "),
    );
}

/**
 * Refuses what this fast path must never publish: a stable version, a version an installed RC
 * would not see as newer, or a throwaway dry-run version outside a draft or local-only run.
 */
export function validateTarget({ version, publish, tags, mainVersion }) {
  if (isDryRunVersion(version)) {
    if (publish)
      throw new Error(`${version} is a dry-run version: use it only with --draft or --no-publish.`);
    return;
  }
  if (parseVersion(version) && !parseVersion(version).pre.length)
    throw new Error(
      `${version} is a stable version. This script cuts private RCs only. ${STABLE_PATH}`,
    );
  if (!isRcVersion(version))
    throw new Error(`${version} is not an RC version like 0.1.0-rc.16 (what the updater accepts).`);
  if (tags.includes(`v${version}`)) throw new Error(`Tag v${version} already exists.`);
  const highest = tagVersions(tags)[0];
  if (highest && compareVersions(version, highest) <= 0)
    throw new Error(`${version} is not newer than v${highest}; installed RCs would not offer it.`);
  if (parseVersion(mainVersion) && compareVersions(version, mainVersion) < 0)
    throw new Error(
      `${version} is older than main's ${mainVersion}; a local build of main would outrank it.`,
    );
}

/** macOS caps a Unix socket path at 104 bytes (`sun_path`), its NUL included. */
const SOCKET_PATH_MAX = 103;
/**
 * The deepest socket path the tests make under the work dir's TMPDIR, as a stand-in:
 * tool-image-source.test.ts listens at `<TMPDIR>/gram-image-source-XXXXXX/checkout/swap.png`.
 */
const TEST_SOCKET_TAIL = "tmp/gram-image-source-XXXXXX/checkout/swap.png";

/** The default work dir's mkdtemp prefix: under /tmp, not $TMPDIR (/var/folders/… is too long). */
export const defaultWorkPrefix = (version) => `/tmp/gram-rc-${version}-`;

/** Why `work` (its real path) is too long for the tests' sockets, or undefined. */
export function workPathProblem(work) {
  const longest = `${work.replace(/\/+$/, "")}/${TEST_SOCKET_TAIL}`;
  const bytes = new TextEncoder().encode(longest).length;
  if (bytes <= SOCKET_PATH_MAX) return undefined;
  return (
    `work dir ${work} is too long: the tests' Unix sockets under it reach ${bytes} bytes, ` +
    `over macOS's ${SOCKET_PATH_MAX}. Pass a shorter --work, such as /tmp/rc.`
  );
}

/** The six assets the private updater requires, in upload order; the ZIP names how it is signed. */
export function assetNames(version, signed = false) {
  return [
    `gram_${version}_darwin-arm64_${signed ? "signed" : "unsigned"}.zip`,
    "BUILD-INFO.json",
    "BUNDLE-INVENTORY.json",
    "BUNDLE-SHA256SUMS.txt",
    "WEB-SHA256SUMS.txt",
    "SHA256SUMS.txt",
  ];
}

/**
 * electron-updater's manifest for a signed release, as its GitHub provider names channel files:
 * `rc-mac.yml` for an RC, `latest-mac.yml` for a stable release.
 */
export function updaterManifestName(version) {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`Not a version: ${version}`);
  return parsed.pre.length ? "rc-mac.yml" : "latest-mac.yml";
}

/**
 * Everything a release uploads, in order: the six assets, then electron-updater's manifest for a
 * signed build. An unsigned build has no manifest, so signed installs are never offered it.
 */
export function uploadNames(version, signed = false) {
  const names = assetNames(version, signed);
  return signed ? [...names, updaterManifestName(version)] : names;
}

/** `sha  name` lines, as `shasum -a 256 -c` reads them, sorted by name. */
export function checksumLines(entries) {
  return entries
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ sha256, name }) => `${sha256}  ${name}\n`)
    .join("");
}

const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?!?:\s*/;
const MAINTENANCE_TYPES = new Set([
  "chore",
  "docs",
  "ci",
  "test",
  "tests",
  "build",
  "refactor",
  "style",
  "e2e",
]);

/** A squash title as `{ kind: "feature" | "fix" | "maintenance", text }`. */
export function classifyTitle(title) {
  const type = CONVENTIONAL.exec(title)?.[1]?.toLowerCase();
  const stripped = title.replace(CONVENTIONAL, "");
  const text = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  if (
    (type && MAINTENANCE_TYPES.has(type)) ||
    /^(design|docs?|tests?|ci):/i.test(stripped) ||
    /\b(tests?|fixtures?|specs?|typecheck|CI)\b/.test(stripped)
  )
    return { kind: "maintenance", text };
  if (
    type === "fix" ||
    /^(fix|fixes|fixed|repair|restore)\b/i.test(stripped) ||
    /\bfix(es|ed)?\b/i.test(stripped)
  )
    return { kind: "fix", text };
  return { kind: "feature", text };
}

/** Squash titles grouped for the notes. */
export function groupTitles(titles) {
  const groups = { features: [], fixes: [], maintenance: 0 };
  for (const title of titles) {
    const { kind, text } = classifyTitle(title.trim());
    if (kind === "feature") groups.features.push(text);
    else if (kind === "fix") groups.fixes.push(text);
    else groups.maintenance++;
  }
  return groups;
}

export const DEFAULT_NOTARY_PROFILE = "gram-notary";
const DEVELOPER_ID = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/;

/**
 * Whether this run signs, and with what, from names only: `security find-identity` lines and a
 * notarytool profile name. `auto` signs when the source names its publisher team, exactly one
 * matching Developer ID Application identity is in the keychain (or the one passed) and the
 * profile answers (`checkProfile` runs last, as it contacts Apple); otherwise it builds unsigned and says why. `signed` turns that reason into an
 * error, and `unsigned` keeps the old path.
 */
export function resolveSigning({ mode, teamId, identityLines, identity, profile, checkProfile }) {
  const unsigned = (reason) => {
    if (mode === "signed") throw new Error(`--signed: ${reason}`);
    return { signed: false, reason };
  };
  if (mode === "unsigned") return { signed: false, reason: "--unsigned" };
  if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId))
    return unsigned(
      "GRAM_MAC_TEAM_ID is not set in packages/shell/src/modules/update/mac-signature.ts",
    );
  const names = [
    ...new Set(
      identityLines.map((line) => /^\s*\d+\) [0-9A-F]{40} "(.+)"/.exec(line)?.[1]).filter(Boolean),
    ),
  ].filter((name) => DEVELOPER_ID.exec(name)?.[1] === teamId);
  if (identity !== undefined) {
    if (DEVELOPER_ID.exec(identity)?.[1] !== teamId)
      throw new Error(`${identity} is not a Developer ID Application identity of team ${teamId}.`);
    if (!names.includes(identity))
      return unsigned(`"${identity}" is not a valid identity in the keychain`);
  } else if (names.length !== 1)
    return unsigned(
      names.length
        ? `${names.length} Developer ID Application identities of team ${teamId}; pass --identity`
        : `no valid Developer ID Application identity of team ${teamId} in the keychain`,
    );
  const answer = checkProfile();
  if (answer !== true)
    return unsigned(
      typeof answer === "string" ? answer : `notarytool profile "${profile}" did not answer`,
    );
  return { signed: true, identity: identity ?? names[0], teamId, profile };
}

const UNSIGNED_LIMIT = "Unsigned: ad-hoc linker signatures only, no Developer ID, not notarized.";
const SIGNED_LIMIT =
  "Developer ID signed with the hardened runtime, notarized and stapled; Gatekeeper accepted the app before it was zipped.";
const COMMON_LIMITS = [
  "No live-provider or microphone test: the smoke run uses fake agents and temporary stores.",
  "No installed-update test: nothing was installed, launched in place or replaced.",
];
const limits = (signed = false) => [signed ? SIGNED_LIMIT : UNSIGNED_LIMIT, ...COMMON_LIMITS];

const NOTES_LIMIT = 7_500;

/** Release notes: optional highlights, then features and fixes, then source and limits. */
export function renderNotes({
  version,
  sha,
  previousTag,
  titles,
  highlights,
  check,
  signed = false,
  stable = false,
}) {
  const { features, fixes, maintenance } = groupTitles(titles);
  const since = previousTag ? `since ${previousTag}` : "in this release";
  const lines = [];
  if (highlights?.trim()) lines.push(highlights.trim(), "");
  const section = (heading, items) => {
    if (!items.length) return;
    lines.push(`### ${heading}`, "", ...items.map((item) => `- ${item}`), "");
  };
  if (!features.length && !fixes.length) lines.push(`No user-facing changes ${since}.`, "");
  section("Features", features);
  section("Fixes", fixes);
  if (maintenance)
    lines.push(
      `Plus ${maintenance} maintenance change${maintenance === 1 ? "" : "s"} (tests, docs, tooling).`,
      "",
    );
  const tail = [
    "### Build",
    "",
    stable
      ? `Draft of ${version} for macOS on Apple silicon, built from \`${sha}\`. \`release:stable publish\` replaces these notes.`
      : `Private prerelease ${version} for macOS on Apple silicon, built from \`${sha}\`.`,
    check ? `Full local check: ${check}.` : undefined,
    "Checksums for all six assets are in SHA256SUMS.txt; the updater verifies them before installing.",
    signed
      ? `Signed installs update through Electron's updater from ${updaterManifestName(version)}, which names the signed ZIP and its SHA-512.`
      : undefined,
    "",
    ...limits(signed).map((limit) => `- ${limit}`),
    "",
  ].filter((line) => line !== undefined);
  let body = lines.join("\n");
  const room = NOTES_LIMIT - tail.join("\n").length - 40;
  if (body.length > room) body = `${body.slice(0, room).replace(/\n[^\n]*$/, "")}\n- …and more.\n`;
  return `${body}\n${tail.join("\n")}`.replace(/\n{3,}/g, "\n\n");
}

const timedOut = (message) => /(?:Test|Hook) timed out in \d+ms/.test(message ?? "");

/** What one vitest JSON report says, with the failing files relative to `root`. */
export function summarizeVitest(report, root) {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const failed = (report.testResults ?? []).filter((file) => file.status === "failed");
  return {
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
    skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
    success: report.success === true,
    failedFiles: failed.map((file) =>
      file.name.startsWith(prefix) ? file.name.slice(prefix.length) : file.name,
    ),
    timeoutsOnly:
      failed.length > 0 &&
      failed.every((file) => {
        const failures = (file.assertionResults ?? []).filter((a) => a.status === "failed");
        return (
          (failures.length > 0 || timedOut(file.message)) &&
          failures.every((a) => (a.failureMessages ?? []).every(timedOut)) &&
          (!file.message || timedOut(file.message))
        );
      }),
  };
}

/** One rerun of only the failing files, and only for a few files that all timed out. */
export function rerunFiles(summary, max = 3) {
  if (summary.success || !summary.timeoutsOnly) return undefined;
  if (!summary.failedFiles.length || summary.failedFiles.length > max) return undefined;
  return summary.failedFiles;
}

export const describeTests = (s) => `${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`;

/** `6m 01s`; rounds first, so 359.6s is 6m 00s rather than 5m 60s. */
export const minutes = (seconds) => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/** The short record of a run, `<version>.md` in the work dir. */
export function renderRecord({
  version,
  sha,
  previousTag,
  url,
  draft,
  publishedAt,
  check,
  steps,
  assets,
  totalSeconds,
  signed = false,
}) {
  return [
    `# Gram ${version} release`,
    "",
    `Cut with \`tools/release-rc/rc.mjs\`: one local check, build, package, smoke and publish.`,
    "",
    "## Source and result",
    "",
    `- Source: \`${sha}\` on main${previousTag ? `; changes since ${previousTag}` : ""}.`,
    `- Release: [v${version}](${url}), ${draft ? "draft (not published)" : `prerelease, not latest, published ${publishedAt}`}.`,
    `- Full local check: ${check}.`,
    `- Package verifier, native probe and fake-agent smoke passed; the ZIP extracted with the updater's own reader matched every bundle hash.`,
    `- GitHub's asset digests matched the local SHA256SUMS after upload.`,
    ...(signed
      ? [
          `- \`${updaterManifestName(version)}\` names the signed ZIP and its SHA-512; it was read back through electron-updater's own parser before upload.`,
        ]
      : []),
    `- Total time: ${minutes(totalSeconds)}.`,
    "",
    "## Steps",
    "",
    "| Step | Time |",
    "| --- | --- |",
    ...steps.map((step) => `| ${step.name} | ${minutes(step.seconds)} |`),
    "",
    "## Assets",
    "",
    "| Asset | Bytes | SHA-256 |",
    "| --- | --- | --- |",
    ...assets.map((asset) => `| \`${asset.name}\` | ${asset.bytes} | \`${asset.sha256}\` |`),
    "",
    "## Limits",
    "",
    ...limits(signed).map((limit) => `- ${limit}`),
    "",
  ].join("\n");
}

/**
 * Arguments of `release:rc`; throws on anything unknown, and on a stable `--latest`. `--stable`
 * takes the stable path's first phase: a signed build and a private draft, nothing published.
 */
export function parseArgs(argv) {
  const options = { draft: false, publish: true, signing: "auto", stable: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value.`);
      return next;
    };
    if (arg === "--draft") options.draft = true;
    else if (arg === "--no-publish" || arg === "--dry-run") options.publish = false;
    else if (arg === "--stable") options.stable = true;
    else if (arg === "--first-release") options.firstRelease = true;
    else if (arg === "--highlights") options.highlights = value();
    else if (arg === "--source") options.source = value();
    else if (arg === "--bun") options.bun = value();
    else if (arg === "--work") options.work = value();
    else if (arg === "--signed" || arg === "--unsigned") {
      if (options.signing !== "auto") throw new Error("Use --signed or --unsigned, not both.");
      options.signing = arg.slice(2);
    } else if (arg === "--identity") options.identity = value();
    else if (arg === "--notary-profile") options.notaryProfile = value();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--latest" || arg.startsWith("--latest="))
      throw new Error(`This script never marks a release latest. ${STABLE_PATH}`);
    else if (!arg.startsWith("-") && options.version === undefined)
      options.version = arg.replace(/^v/, "");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.draft && !options.publish) throw new Error("Use --draft or --no-publish, not both.");
  if (options.firstRelease && !options.stable)
    throw new Error("--first-release is for a stable release (--stable).");
  if (options.stable) {
    if (!options.version) throw new Error("--stable needs the version, e.g. 1.0.0.");
    if (options.signing === "unsigned") throw new Error("--stable builds are always signed.");
    // Never published from here: the draft goes on through bun run release:stable.
    options.signing = "signed";
    options.draft = options.publish;
  }
  if (options.signing === "unsigned" && (options.identity || options.notaryProfile))
    throw new Error("--unsigned takes no --identity or --notary-profile.");
  return options;
}
