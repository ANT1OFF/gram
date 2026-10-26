// Offline upstream dry-run. Pass the directory of the pinned action's npm-ci installation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateReleaseMetadata } from "./check-release-please.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(resolve(root, path), "utf8");
assert(process.argv[2], "Pass the pinned release-please-action dependency directory");
const upstream = createRequire(resolve(process.argv[2], "package.json"));
const { Manifest, VERSION } = upstream("release-please");
const { FileNotFoundError } = upstream("release-please/build/src/errors");
const { load } = upstream("js-yaml");
assert.equal(VERSION, "17.6.0", "Test the runtime bundled in the pinned action");
// The repository's single first commit, which the v1.0.0 release is tagged on. Invented.
const baseline = "1".repeat(40);
const silent = { info() {}, warn() {}, debug() {}, error() {} };
const versioned = [
  ".release-please-manifest.json",
  "package.json",
  "apps/desktop/package.json",
  "bun.lock",
];
const paths = ["release-please-config.json", ...versioned];
/** `files` with every version field moved from `from` to `to`, and nothing else touched. */
const withVersion = (files, from, to) =>
  Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      path,
      path === ".release-please-manifest.json"
        ? text.replace(`"${from}"`, `"${to}"`)
        : versioned.includes(path)
          ? text.replace(`"version": "${from}"`, `"version": "${to}"`)
          : text,
    ]),
  );
const currentVersion = validateReleaseMetadata(read);
// The cases set their metadata explicitly to 1.0.0, independent of current main.
const initialFiles = withVersion(
  Object.fromEntries(paths.map((path) => [path, read(path)])),
  currentVersion,
  "1.0.0",
);
const commit = (digit, message) => ({ sha: digit.repeat(40), message, files: ["package.json"] });

test("configuration fields and extra-file shapes are supported by the pinned upstream schema", () => {
  const schema = upstream("release-please/schemas/config.json");
  const config = JSON.parse(read("release-please-config.json"));
  for (const key of Object.keys(config)) assert(key in schema.properties, key);
  const options = schema.definitions.ReleaserConfigOptions.properties;
  for (const [key, value] of Object.entries(config.packages["."])) {
    assert(key in options, key);
    if (key === "extra-files") {
      const supported = options[key].items.anyOf;
      for (const file of value) {
        const shape = supported.find((candidate) =>
          candidate.properties?.type?.enum.includes(file.type),
        );
        assert(shape, file.type);
        for (const required of shape.required) assert(required in file, required);
        for (const field of Object.keys(file)) assert(field in shape.properties, field);
      }
    } else {
      assert.equal(typeof value, options[key].type, key);
    }
  }
});

// No GitHub client or network exists here. Every read and mutation is an invented port.
function fixture({ releases = true } = {}) {
  const state = {
    files: { ...initialFiles },
    releases: releases ? [{ tagName: "v1.0.0", sha: baseline, notes: "Invented 1.0.0 notes" }] : [],
    commits: [
      commit("a", "fix: repair invented desktop behavior"),
      { sha: baseline, message: "Gram 1.0.0", files: ["package.json"] },
    ],
    open: [],
    merged: [],
    writes: [],
  };
  const github = {
    repository: { owner: "ANT1OFF", repo: "gram", defaultBranch: "main" },
    async getFileContentsOnBranch(path) {
      if (!(path in state.files)) throw new FileNotFoundError(path);
      const content = state.files[path];
      return {
        content: Buffer.from(content).toString("base64"),
        parsedContent: content,
        sha: "f".repeat(40),
      };
    },
    async getFileJson(path) {
      return JSON.parse((await this.getFileContentsOnBranch(path)).parsedContent);
    },
    async *releaseIterator() {
      yield* state.releases;
    },
    async *tagIterator() {
      yield* state.releases.map((r) => ({ name: r.tagName, sha: r.sha }));
    },
    async *mergeCommitIterator() {
      yield* state.commits;
    },
    async *pullRequestIterator(_branch, status) {
      yield* status === "OPEN" ? state.open : status === "MERGED" ? state.merged : [];
    },
    async createPullRequest(pr, _branch, _message, updates, options) {
      assert.equal(options.draft, true);
      const created = { ...pr, number: 100, body: pr.body.toString() };
      state.open.push(created);
      state.writes.push({ kind: "create", updates });
      return created;
    },
    async updatePullRequest(number, pr) {
      state.writes.push({ kind: "update", updates: pr.updates });
      const existing = state.open.find((p) => p.number === number);
      Object.assign(existing, { body: pr.body.toString(), title: pr.title.toString() });
      return existing;
    },
  };
  // Reject any unexpected port, including publication/tagging and authentication discovery.
  const guarded = new Proxy(github, {
    get(target, key) {
      assert(key in target, `Unexpected GitHub port: ${String(key)}`);
      return target[key];
    },
  });
  const manifest = () =>
    Manifest.fromManifest(guarded, "main", undefined, undefined, { logger: silent });
  return { state, manifest };
}

function apply(pr, files) {
  const changed = {};
  for (const update of pr.updates) {
    const before = files[update.path];
    if (before === undefined && !update.createIfMissing) continue;
    changed[update.path] = update.updater.updateContent(before, silent);
  }
  return changed;
}

test("upstream proposes 1.0.1 after v1.0.0, updates only the version fields, and is byte idempotent", async () => {
  const { state, manifest } = fixture();
  const [pr] = await (await manifest()).buildPullRequests();
  assert.equal(pr.version.toString(), "1.0.1");
  assert.equal(pr.draft, true);
  const changed = apply(pr, state.files);
  assert.deepEqual(Object.keys(changed).toSorted(), [
    ".release-please-manifest.json",
    "CHANGELOG.md",
    "apps/desktop/package.json",
    "bun.lock",
    "package.json",
  ]);
  for (const path of ["package.json", "apps/desktop/package.json", "bun.lock"]) {
    assert.equal(
      changed[path],
      state.files[path].replace('"version": "1.0.0"', '"version": "1.0.1"'),
      `${path}: every other byte stays identical`,
    );
  }
  assert.equal(JSON.parse(changed[".release-please-manifest.json"])["."], "1.0.1");
  assert.match(changed["CHANGELOG.md"], /repair invented desktop behavior/);
  assert.doesNotMatch(changed["CHANGELOG.md"], /Gram 1\.0\.0/);
  const [repeated] = await (await manifest()).buildPullRequests();
  assert.deepEqual(
    apply(repeated, state.files),
    changed,
    "Same main source generates identical updates",
  );
  const reapplied = apply(pr, { ...state.files, ...changed });
  for (const path of versioned) {
    assert.equal(reapplied[path], changed[path], `${path}: version updates are idempotent`);
  }
  assert.equal(
    validateReleaseMetadata((path) => ({ ...state.files, ...changed })[path]),
    "1.0.1",
  );
});

test("the first commit alone proposes nothing, with or without the v1.0.0 release", async () => {
  for (const releases of [true, false]) {
    const { state, manifest } = fixture({ releases });
    state.commits = state.commits.filter((c) => c.sha === baseline);
    assert.deepEqual(await (await manifest()).buildPullRequests(), [], `releases: ${releases}`);
  }
});

test("before v1.0.0 is published, a fix still proposes 1.0.1 from the first commit on", async () => {
  const { state, manifest } = fixture({ releases: false });
  const [pr] = await (await manifest()).buildPullRequests();
  assert.equal(pr.version.toString(), "1.0.1");
  const changelog = apply(pr, state.files)["CHANGELOG.md"];
  assert.match(changelog, /repair invented desktop behavior/);
  assert.doesNotMatch(changelog, /Gram 1\.0\.0/);
});

test("after v1.0.0 only commits since its tag count", async () => {
  const { state, manifest } = fixture();
  // A conventional commit behind the baseline is invented: the real first commit has no parent.
  state.commits.push(commit("c", "feat: a feature older than the release"));
  const [pr] = await (await manifest()).buildPullRequests();
  assert.equal(pr.version.toString(), "1.0.1");
  assert.doesNotMatch(apply(pr, state.files)["CHANGELOG.md"], /older than the release/);
});

test("a feature proposes 1.1.0, and a breaking feat!/fix! 2.0.0", async () => {
  for (const [message, version] of [
    ["feat: next feature", "1.1.0"],
    ["feat!: incompatible change", "2.0.0"],
    ["fix!: incompatible correction", "2.0.0"],
  ]) {
    const { state, manifest } = fixture();
    state.commits[0].message = message;
    const [pr] = await (await manifest()).buildPullRequests();
    assert.equal(pr.version.toString(), version, message);
  }
});

test("repeated create runs reuse one PR; additional changes update it", async () => {
  const { state, manifest } = fixture();
  await (await manifest()).createPullRequests();
  await (await manifest()).createPullRequests();
  assert.deepEqual(
    state.writes.map((w) => w.kind),
    ["create"],
  );
  state.commits.unshift(commit("b", "fix: another invented correction"));
  await (await manifest()).createPullRequests();
  assert.deepEqual(
    state.writes.map((w) => w.kind),
    ["create", "update"],
  );
  assert.equal(state.open.length, 1);
});

test("merged pending PR holds the next cycle until verified tag publication and label reconciliation", async () => {
  const { state, manifest } = fixture();
  const [pr] = await (await manifest()).buildPullRequests();
  await (await manifest()).createPullRequests();
  Object.assign(state.files, apply(pr, state.files));
  const publishedSource = "d".repeat(40);
  const merged = { ...state.open.pop(), mergeCommitOid: publishedSource };
  state.merged.push(merged);
  state.commits.unshift({
    sha: publishedSource,
    message: pr.title.toString(),
    files: Object.keys(state.files),
    pullRequest: merged,
  });
  state.commits.unshift(commit("e", "fix: correction after stable metadata"));
  await (await manifest()).createPullRequests();
  assert.equal(state.writes.length, 1, "Pending merged PR refuses another proposal");
  // Invented post-publication reconciliation, never a call to the real release API.
  state.releases.unshift({
    tagName: "v1.0.1",
    sha: publishedSource,
    notes: "Verified stable fixture",
  });
  merged.labels = ["autorelease: tagged"];
  await (await manifest()).createPullRequests();
  assert.equal(state.writes.length, 2);
  const [next] = await (await manifest()).buildPullRequests();
  assert.equal(next.version.toString(), "1.0.2");
  const changelog = apply(next, state.files)["CHANGELOG.md"];
  assert.match(changelog.split("## 1.0.1")[0], /correction after stable metadata/);
  assert.equal((changelog.match(/repair invented desktop behavior/g) ?? []).length, 1);
  await (await manifest()).createPullRequests();
  assert.equal(state.writes.length, 2, "Next cycle also reuses its one PR");
});

test("metadata preflight refuses desynchronized, malformed or widened updates", () => {
  assert.equal(
    validateReleaseMetadata((path) => initialFiles[path]),
    "1.0.0",
  );
  assert.equal(validateReleaseMetadata(read), currentVersion);
  const mutations = [
    [
      "apps/desktop/package.json",
      read("apps/desktop/package.json").replace(
        `"version": "${currentVersion}"`,
        '"version": "0.0.1"',
      ),
    ],
    [".release-please-manifest.json", '{".":"0.0.1"}'],
    ["package.json", "{broken"],
    ["bun.lock", read("bun.lock").replace(" // x-release-please-version", "")],
    ["bun.lock", read("bun.lock") + "\n// x-release-please-version\n"],
    [
      "release-please-config.json",
      read("release-please-config.json").replace(
        '"skip-github-release": true',
        '"skip-github-release": false',
      ),
    ],
    [
      "release-please-config.json",
      read("release-please-config.json").replace(
        '"packages"',
        `"bootstrap-sha": "${baseline}", "packages"`,
      ),
    ],
  ];
  for (const [changedPath, value] of mutations) {
    assert.throws(
      () => validateReleaseMetadata((path) => (path === changedPath ? value : read(path))),
      changedPath,
    );
  }
});

test("workflow grants write scopes only to pinned API action on trusted main", () => {
  const workflow = load(read(".github/workflows/release-please.yml"));
  assert.deepEqual(workflow.on, { push: { branches: ["main"] }, workflow_dispatch: null });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "release-please-main",
    "cancel-in-progress": false,
  });
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job.if, "github.repository == 'ANT1OFF/gram' && github.ref == 'refs/heads/main'");
  }
  const validate = workflow.jobs.validate;
  assert.equal(validate.steps[0].uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.equal(validate.steps[0].with["persist-credentials"], false);
  assert.equal(validate.steps[0].with.ref, "${{ github.sha }}");
  const propose = workflow.jobs.propose;
  assert.equal(propose.needs, "validate");
  assert.deepEqual(propose.permissions, {
    contents: "write",
    "pull-requests": "write",
    issues: "write",
  });
  assert.equal(propose.steps.length, 1);
  assert.equal(
    propose.steps[0].uses,
    "googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7",
  );
  assert.equal(propose.steps[0].with["skip-github-release"], true);
  assert.equal(propose.steps[0].with.token, "${{ github.token }}");
  assert.equal(propose.steps[0].with["target-branch"], "main");
});
