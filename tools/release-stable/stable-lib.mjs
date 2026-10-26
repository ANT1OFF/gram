// Pure parts of the stable release tool (tools/release-stable/stable.mjs): arguments, the published
// notes and their leak check, and how a GitHub release must look against the local assets. No
// process, file or network access here.

/** The repository releases are published to, and the only one notes may link to. */
export const RELEASE_REPO = "ANT1OFF/gram";

/** The state `release:rc --stable` leaves in its work dir for the later phases. */
export const STATE_FILE = "release.json";

const PHASES = ["validate", "update-check", "publish"];

/** Arguments of `release:stable <phase>`; throws on anything unknown. */
export function parseStableArgs(argv) {
  const options = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value.`);
      return next;
    };
    if (arg === "--work") options.work = value();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--harness-source") options.harnessSource = value();
    else if (arg === "--bun") options.bun = value();
    else if (arg === "--live") options.live = true;
    else if (arg === "--notes") options.notes = value();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!arg.startsWith("-") && options.phase === undefined) options.phase = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.help) return options;
  if (!PHASES.includes(options.phase))
    throw new Error(
      `Name a phase: ${PHASES.join(", ")} (the build and draft are release:rc --stable).`,
    );
  if (!options.work) throw new Error("Pass --work <dir>: the work dir release:rc --stable used.");
  if (options.dryRun && options.phase !== "publish")
    throw new Error(`--dry-run is for publish; ${options.phase} writes nothing anyway.`);
  if (options.live && options.phase !== "update-check")
    throw new Error("--live is for update-check.");
  if (options.notes !== undefined && options.phase !== "publish")
    throw new Error("--notes is for publish.");
  return options;
}

/**
 * `text` as it reads, for the checks: compatibility forms folded (full-width digits, ligatures),
 * invisible format characters dropped, and Markdown's emphasis, code and strike marks removed, so
 * `**#**287`, `` `9613` tests `` and a zero-width space inside a SHA read as what they say.
 */
export const plainNotes = (text) =>
  text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[*_`~]+/g, "");

/**
 * What published notes must never carry, whatever else passes: PR numbers and links (the fresh
 * public repository's numbers are not the archive's), commit SHAs, notarization IDs, test counts and
 * private process words.
 */
const LEAKS = [
  // Anywhere, `bug#123` included: GitHub links a number after any `#`.
  [/#\d/, "a PR or issue number (#123)"],
  // `PR 287`, `PR: 287`, `PR-287`, `PRs 287`, `pull request no. 287`, `issue #287`, `GH-12`…
  [
    /\b(?:PRs?|MRs?|pulls?|pull requests?|issues?|GH)\b[\s:.#-]*(?:no\.?|number)?[\s:.#-]*\d/i,
    "a PR or issue number (PR 123)",
  ],
  [/\/(?:pull|issues|commit)\/\w+/, "a PR, issue or commit link"],
  // Any 7 to 64 hex characters, letters-only ones too (`deadbeef`): a short or full SHA or a
  // digest. An English word made only of a–f is refused with them, which is the safe side.
  [/\b[0-9a-f]{7,64}\b/i, "a commit SHA or digest"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "a notarization or run ID"],
  // Test counters, told apart from product behaviour by a complete number in a counter's place:
  // `9,613 tests`, `Tests: 9613`, `9613 passed`, `9,613 passed successfully`, `52 skipped.`,
  // `Passed: 9613`, `Passed 9613 checks`, and anything numeric after `Test results`. Not
  // `2 failed uploads` (a noun follows the result) or `Failed 2FA requests` (not a number).
  [/\b\d[\d,]*\s+(?:tests?|specs?)\b/i, "a test count"],
  [/\b(?:tests?|specs?)\s*[:=]\s*\d[\d,]*(?![\w])/i, "a test count"],
  [/\btest\s+(?:results?|runs?|suites?|summary|report)\b[^.\n]*\d/i, "a test count"],
  [
    /\b\d[\d,]*\s+(?:\w+ly\s+)?(?:passed|passing|failed|failing|failures?|skipped|skips?)\b(?!\s+(?!\w+ly\b)[a-z])/i,
    "a test count",
  ],
  [
    /\b(?:passed|passing|failed|failing|failures?|skipped|skips?)\s*(?:[:=]\s*\d[\d,]*(?![\w])|\d[\d,]*(?=\s*(?:[.,;)]|$|(?:checks?|cases?|tests?|specs?|assertions?|suites?)\b)))/im,
    "a test count",
  ],
  [/\bprivate\b/i, "the word “private”"],
  [/docs\/releases\//, "a private release record"],
];

/**
 * What public notes may hold, beyond that, is closed: no encoded or HTML text (it hides what it
 * says), no `@` handles or addresses, no paths, branches or other slash-separated names (`and/or`
 * aside), no host names, no version but this release's, and links only to the public repository's
 * own pages. Anything else is refused rather than guessed at.
 */
const CLOSED = [
  [/%[0-9a-f]{2}/i, "percent-encoded text"],
  [/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i, "an HTML entity"],
  [/<\/?[a-z!?][^>]*>/i, "HTML"],
  [/\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/i, "an escape sequence"],
  [/@/, "an @handle or e-mail address"],
  [/[~\\]/, "a home or Windows path"],
  [/\b(?:mailto|javascript|data|file|ftp|ssh|git):/i, "a link scheme other than https"],
  [
    /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|ai|co|me|sh|xyz|cloud|internal|local|lan|corp|test|example|invalid)\b/i,
    "a host name",
  ],
];

/**
 * The pages of the public repository a link may name, as paths below `owner/repo`: its front
 * page, its releases (a tag, a download), its issues and its documents. Nothing else.
 */
const PUBLIC_PAGES = [
  /^$/,
  /^releases(?:\/latest)?$/,
  /^releases\/tag\/v[0-9][0-9A-Za-z.-]*$/,
  /^releases\/download\/v[0-9][0-9A-Za-z.-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
  /^issues(?:\/new(?:\/choose)?)?$/,
  /^security(?:\/policy|\/advisories\/new)?$/,
  /^blob\/main\/(?:README|PRIVACY|SECURITY|EULA|LICENSE|CODE_OF_CONDUCT|THIRD-PARTY-NOTICES)(?:\.md|\.txt)?$/,
];

/**
 * Why `link` isn't a page of `publicRepo`, or undefined. It is parsed, not prefix-matched: https
 * on github.com exactly, no credentials, port, query or fragment, no `.` or `..` segment before
 * or after normalizing, the exact owner and repository, then one of PUBLIC_PAGES.
 */
export function publicLinkProblem(link, publicRepo = RELEASE_REPO) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return "not an absolute https link";
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port)
    return "not on https://github.com";
  if (url.username || url.password) return "carries credentials";
  if (url.search || url.hash || /[?#]/.test(link)) return "has a query or fragment";
  const written = link.replace(/^https:\/\/github\.com/i, "").split(/[?#]/)[0];
  if (written.split("/").some((segment) => segment === "." || segment === ".."))
    return "has a . or .. segment";
  const [owner, repo, ...rest] = url.pathname.split("/").slice(1);
  if (`${owner}/${repo}` !== publicRepo) return `not in ${publicRepo}`;
  const page = rest.join("/").replace(/\/$/, "");
  if (!PUBLIC_PAGES.some((shape) => shape.test(page))) return `not a public page of ${publicRepo}`;
  return undefined;
}

const LINK = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]"']+/gi;
const MARKDOWN_TARGET = /\]\(\s*([^)\s]*)[^)]*\)|^\s*\[[^\]]+\]:\s*(\S+)/gm;

/**
 * Why `text` can't be published as public notes, as readable reasons; empty when it can.
 * `versions` are the version strings it may name (this release's, the minimum macOS).
 *
 * Every rule reads the whole text, links included. Only two rules skip the links that pass
 * `publicLinkProblem`: a host name and a slash are what those links are made of, and their path is
 * already held to PUBLIC_PAGES.
 */
export function publicNotesProblems(text, { publicRepo = RELEASE_REPO, versions = [] } = {}) {
  // Every check, links and hosts and paths and versions included, reads the text as written and
  // as it reads once normalized: `build.**widgets**.internal`, `0.**3**.1` and a full-width slash
  // are what they look like.
  return [
    ...new Set([
      ...notesProblems(text, { publicRepo, versions }),
      ...notesProblems(plainNotes(text), { publicRepo, versions }),
    ]),
  ];
}

/** `publicNotesProblems` for one representation of the notes. */
function notesProblems(text, { publicRepo, versions }) {
  const problems = new Set();
  // A sentence's closing punctuation isn't part of the link before it.
  const links = [
    ...[...text.matchAll(LINK)].map(([url]) => url.replace(/[.,;:!?]+$/, "")),
    ...[...text.matchAll(MARKDOWN_TARGET)].map(([, inline, reference]) => inline ?? reference),
  ].filter(Boolean);
  const good = new Set();
  for (const link of links) {
    const why = publicLinkProblem(link, publicRepo);
    if (why) problems.add(`a link that is ${why} (${link})`);
    else good.add(link);
  }
  for (const [pattern, reason] of [...LEAKS, ...CLOSED])
    if (reason !== "a host name" && pattern.test(text)) problems.add(reason);
  const rest = [...good]
    .reduce((out, link) => out.split(link).join(" "), text)
    // `and/or` as a word on its own: not inside `command/orchestration` or `and/or/x`.
    .replace(/(?<![\w/])and\/or(?![\w/])/gi, " ");
  if (CLOSED.find(([, reason]) => reason === "a host name")[0].test(rest) || /\bwww\./i.test(rest))
    problems.add("a host name");
  if (rest.includes("/")) problems.add("a path, branch or other slash-separated name");
  // `v0.3.1` and `gram_0.3.1_…` count too, so no word boundary: any digits not already inside
  // a longer number.
  for (const [found] of text.matchAll(
    /(?<![\d.])\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?/g,
  ))
    if (!versions.includes(found)) problems.add(`another version (${found})`);
  return [...problems];
}

/** One What's New body as Markdown: its only markup is `<kbd>…</kbd>`. */
const cardText = (body) => body.replace(/<kbd>(.*?)<\/kbd>/g, "`$1`");

/**
 * The public release notes for `version`, from its What's New cards (already written for people
 * using the app), plus requirements and how to install. No PR titles, SHAs, test counts or
 * process.
 */
export function renderPublicNotes({ version, cards, minimumMacOS }) {
  const shown = cards.filter((card) => !card.platform || card.platform === "darwin");
  const lines = [];
  if (shown.length) {
    lines.push("## What's new", "");
    for (const card of shown) lines.push(`- **${card.title}.** ${cardText(card.body)}`);
    lines.push("");
  } else lines.push(`Gram ${version}: fixes and improvements.`, "");
  lines.push(
    "## Requirements",
    "",
    `- macOS ${minimumMacOS} or later on Apple silicon.`,
    "- Claude Code and/or Codex installed and signed in with your own account. Gram runs them; it adds no subscription of its own.",
    "- `git`. The GitHub CLI (`gh`) is optional, for pull request features.",
    "",
    "## Install or update",
    "",
    `- New install: download \`gram_${version}_darwin-arm64_signed.zip\`, unzip it and move Gram to Applications.`,
    "- Already installed: Settings → Updates. Nothing installs without your click.",
    "- The app is signed with a Developer ID and notarized by Apple. `SHA256SUMS.txt` lists the download's checksum.",
    "",
    "Gram is not affiliated with Anthropic or OpenAI.",
    "",
  );
  return lines.join("\n");
}

/**
 * What differs between a GitHub release and what it should be: draft and prerelease flags, its
 * tag and target, and exactly `assets` (name, size and GitHub's SHA-256), nothing more.
 */
export function releaseProblems(release, { tag, target, draft, assets }) {
  const problems = [];
  if (release.tag_name !== tag) problems.push(`tag is ${release.tag_name}, not ${tag}`);
  if (target && release.target_commitish !== target)
    problems.push(`target is ${release.target_commitish}, not ${target}`);
  if (release.draft !== draft) problems.push(`draft is ${release.draft}`);
  if (release.prerelease !== false) problems.push("marked prerelease");
  const remote = release.assets ?? [];
  if (remote.length !== assets.length)
    problems.push(`${remote.length} assets, not ${assets.length}`);
  for (const { name, bytes, sha256 } of assets) {
    const asset = remote.find((a) => a.name === name);
    if (!asset) problems.push(`${name} missing`);
    else if (asset.digest !== `sha256:${sha256}` || asset.size !== bytes)
      problems.push(`${name}: GitHub has ${asset.digest ?? "no digest"}/${asset.size} bytes`);
  }
  return problems;
}
