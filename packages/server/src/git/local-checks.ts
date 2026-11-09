// A project-configured check of a pull request: what the solo merge policy accepts in place of GitHub CI.
//
// Gram builds the source itself. It merges the PR's head onto its base's current tip
// (`git merge-tree`), commits that tree to a throwaway commit and checks it out in a fresh
// worktree outside the repository, so nothing uncommitted, ignored, excluded or flagged
// skip-worktree in anyone's checkout can reach it. It runs the approved project command and keeps the
// result in its own database, keyed by project, run, head, base and merged tree. Nothing an agent writes into the
// repository counts as a pass, and a pass stops counting once the head or the base moves.
//
// What it can't prevent: the check runs the PR's own scripts and tests, as CI does, so a change
// that weakens `tools/check` or a test is the reviewer's to catch; and any process of this user
// could rewrite Gram's database, the trust boundary every local result shares.
import {
  type Checkout,
  hostOf,
  type HostCheckResult,
  type HostId,
  isLocalHost,
  localCheckConcurrencyOf,
  DEFAULT_LOCAL_CHECK_TIMEOUT_MS,
  type Project,
  type ProjectLocalCheck,
  type ProjectId,
} from "@gram/contracts";
import {
  canonicalizeOrOwned,
  git,
  PathProbe,
  Proc,
  realPathSync,
  type ProcOutput,
} from "@gram/git";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  lstatSync,
  openSync,
  mkdtempSync,
  readdirSync,
  unlinkSync,
  utimesSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, hostname } from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import {
  isGitControl,
  LEADERLESS_WAITS,
  LocalCheckFailure,
  markRetained,
  recordedGroup,
  recordedOutcome,
  RETAINED,
  readExitStatus,
  spawnCheck,
  stopVerifiedGroup,
  timedOut,
  type DurableCheck,
  type LocalCheckOutcome,
  type LocalCheckRun,
} from "./check-process.ts";
import { ServerConfig } from "../config.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient, type SqlError } from "../platform/unstable.ts";
import { dropOldest } from "../bounded.ts";
import { DAY_MS } from "../zone-time.ts";
import { makeAdmission } from "./keyed-lock.ts";

export {
  diagnoseExit,
  lastLines,
  missingCommand,
  readExitStatus,
  spawnCheck,
  type CheckEnvironment,
  type DurableCheck,
  type LocalCheckOutcome,
  type LocalCheckRun,
} from "./check-process.ts";

/** A publisher Git read's stdout; any failure or truncation refuses the publish. */
const requiredPublisherGit = (result: ProcOutput | undefined) => {
  if (result?.status !== 0 || result.truncated)
    throw new Error("publisher Git metadata unavailable");
  return result.stdout;
};

/** A private selected-source preparation step's stdout; any failure or truncation refuses it. */
const requirePreparedGit = (out: ProcOutput | undefined) => {
  if (out?.status !== 0 || out.truncated)
    throw new Error("private selected Git preparation failed");
  return out.stdout;
};

/** The merged source a run checks, and how its runner keeps or hands it on. */
export interface MergedCheckSource {
  readonly head: string;
  readonly base: string;
  readonly tree: string;
  readonly commit: string;
  /** Unsafe teardown retains the worktree as well as the durable admission quarantine. */
  readonly retain: () => void;
  /** Lets a check outlive a quit. */
  readonly durable?: DurableCheck | undefined;
}

/**
 * The isolation Gram's runner gives the source it checks: merged and checked out in its own bare
 * repository, fed only by fetch. A record without it, or with another, came from a runner an
 * agent's repository config could fool, so it never qualifies; changing how the source is isolated
 * changes this, and retires every pass before it.
 */
export const LOCAL_CHECK_ISOLATION = "own-bare-repository/2";
const SELECTED_CHECK_ISOLATION = "own-bare-repository/selected/1";

/** A thread's checkout on a joined machine, where its check runs through that machine's host. */
export interface MachineCheckSite {
  readonly hostId: HostId;
  /** The checkout's folder there. */
  readonly path: string;
  /** The machine's clone it was made from. */
  readonly repoRoot?: string | undefined;
}

/** Where a check runs: a folder of this machine's repository, or a joined machine's checkout. */
export type CheckSite = string | MachineCheckSite;

/**
 * Where the check of `checkout`'s thread runs: `here`, a folder on this machine, for a checkout on
 * this machine; the checkout itself on the joined machine it is on.
 */
export const checkSiteOf = (
  checkout: Pick<Checkout, "path" | "repoRoot" | "hostId">,
  here: string,
): CheckSite =>
  isLocalHost(checkout)
    ? here
    : {
        hostId: hostOf(checkout),
        path: checkout.path,
        ...(checkout.repoRoot === undefined ? {} : { repoRoot: checkout.repoRoot }),
      };

/**
 * How long a joined machine's check waits for its host to dial in again after the connection went,
 * before how it ended counts as unknown: the host keeps a run going across a redial, and answers
 * the same id with it.
 */
export const MachineReattachMs = Context.Reference<number>("@gram/server/MachineReattachMs", {
  defaultValue: () => 2 * 60_000,
});
/** How often a check waiting for its machine looks for it again. */
const MACHINE_POLL_MS = 2_000;
/** Past its timeout, how long a joined machine's check is given to answer before it is given up. */
const MACHINE_SLACK_MS = 10 * 60_000;

/** The single neutral project setting to command conversion. */
export const localCheckRunFor = (
  setting: ProjectLocalCheck | undefined,
  projectId?: ProjectId,
  unavailable?: string,
  revision?: string,
): LocalCheckRun | undefined => {
  if (unavailable !== undefined)
    return {
      isolation: LOCAL_CHECK_ISOLATION,
      ...(projectId === undefined ? {} : { projectId }),
      command: "Unavailable local validator",
      profile: "unavailable/v1",
      qualification: revision ?? "missing-revision",
      refusal: unavailable,
    };
  return setting?.command === undefined || setting.command.trim() === ""
    ? undefined
    : {
        isolation:
          setting.preparation === undefined ? LOCAL_CHECK_ISOLATION : SELECTED_CHECK_ISOLATION,
        ...(projectId === undefined ? {} : { projectId }),
        command: setting.command,
        ...(setting.preparation === undefined ? {} : { preparation: setting.preparation }),
        ...(setting.setup === undefined ? {} : { setup: setting.setup }),
        timeoutMs: setting.timeoutMs ?? DEFAULT_LOCAL_CHECK_TIMEOUT_MS,
      };
};

/** Run identity includes the source-isolation version, so runs under another one hash apart. */
export const runIdOf = (run: {
  readonly isolation?: string | undefined;
  readonly preparation?: ProjectLocalCheck["preparation"] | undefined;
  readonly command: string;
  readonly projectId?: string | undefined;
  readonly setup?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly profile?: string | undefined;
  readonly qualification?: string | undefined;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        run.isolation ?? null,
        run.projectId ?? null,
        run.command,
        run.setup ?? null,
        run.timeoutMs ?? DEFAULT_LOCAL_CHECK_TIMEOUT_MS,
        ...(run.profile === undefined ? [] : [run.profile, run.qualification ?? null]),
        ...(run.preparation === undefined
          ? []
          : [
              run.preparation.manifest,
              run.preparation.sha256,
              ...(run.preparation.inputConfigSha256 === undefined
                ? []
                : [run.preparation.inputConfigSha256]),
            ]),
      ]),
    )
    .digest("hex")
    .slice(0, 12);

/** A user-approved selection enumerates the complete candidate tree; omitted bytes are never read. */
interface SelectedSource {
  path: string;
  mode: string;
  oid: string;
  selected: boolean;
}
function protectedSourceName(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1)!;
  return (
    parts.some((part) =>
      [".ssh", ".aws", ".gnupg", "secret-manifest", "credential-store", "credentials"].includes(
        part,
      ),
    ) ||
    name.startsWith(".env") ||
    name.includes(".env.") ||
    /(?:private[_.-]?key|credential|password|mnemonic|seed[_.-]?phrase|keystore|api[_.-]?(?:key|token)|access[_.-]?token|refresh[_.-]?token)/i.test(
      name,
    ) ||
    (name.includes("wallet") && /\.(?:json|toml|yaml|yml|ini|db)$/.test(name)) ||
    /\.(?:env|key|pem|p12|pfx|jks|keystore)$/.test(name) ||
    /^(?:id_rsa|id_ed25519|id_ecdsa)/.test(name) ||
    ["secrets.json", "secrets.toml", ".npmrc", ".pypirc", ".netrc", ".git-credentials"].includes(
      name,
    )
  );
}
/** Verify materialized bytes and modes without opening any omitted path. */
function verifySelectedWorktree(root: string, selection: ReadonlyArray<SelectedSource>): void {
  const expected = new Map(selection.filter((row) => row.selected).map((row) => [row.path, row]));
  const directories = new Set<string>();
  for (const path of expected.keys()) {
    const parts = path.split("/");
    for (let end = 1; end < parts.length; end++) directories.add(parts.slice(0, end).join("/"));
  }
  const seen = new Set<string>();
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (!prefix && name === ".git") continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = nodePath.join(dir, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) {
        if (!directories.has(relative)) throw new Error("unexpected selected worktree directory");
        visit(path, relative);
        continue;
      }
      const row = expected.get(relative);
      if (row === undefined || !metadata.isFile() || metadata.isSymbolicLink())
        throw new Error("unexpected selected worktree path");
      const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const before = fstatSync(fd);
        const mode = (before.mode & 0o111) !== 0 ? "100755" : "100644";
        if (
          !before.isFile() ||
          mode !== row.mode ||
          before.dev !== metadata.dev ||
          before.ino !== metadata.ino
        )
          throw new Error("selected worktree mode differs");
        const hash = createHash("sha1").update(`blob ${before.size}\0`);
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let bytes = 0;
        for (;;) {
          const count = readSync(fd, buffer, 0, buffer.length, null);
          if (count === 0) break;
          bytes += count;
          hash.update(buffer.subarray(0, count));
        }
        const after = fstatSync(fd);
        if (
          bytes !== before.size ||
          hash.digest("hex") !== row.oid ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error("selected worktree bytes differ");
      } finally {
        closeSync(fd);
      }
      seen.add(relative);
    }
  };
  visit(root, "");
  if (seen.size !== expected.size) throw new Error("selected worktree membership differs");
}

function selectedSourceManifest(
  preparation: NonNullable<ProjectLocalCheck["preparation"]>,
  head: string,
  base: string,
  tree?: string,
): { tree: string; entries: Array<SelectedSource> } {
  const path = preparation.manifest;
  if (process.platform !== "linux") throw new Error("selected-source preparation requires Linux");
  if (
    !nodePath.isAbsolute(path) ||
    nodePath.normalize(path) !== path ||
    realPathSync(path) !== path ||
    protectedSourceName(path)
  )
    throw new Error("unsafe selected-source manifest path");
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 8 * 1024 * 1024 || before.size <= 0)
      throw new Error("invalid selected-source manifest");
    const raw = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      createHash("sha256").update(raw).digest("hex") !== preparation.sha256
    )
      throw new Error("selected-source manifest identity differs");
    const doc: unknown = JSON.parse(raw.toString("utf8"));
    if (typeof doc !== "object" || doc === null || Array.isArray(doc))
      throw new Error("invalid selected-source document");
    const v = doc as Record<string, unknown>;
    if (
      Object.keys(v).toSorted().join(",") !== "base,entries,head,schema,tree" ||
      v.schema !== "gram.selected-source/v1" ||
      v.head !== head ||
      v.base !== base ||
      typeof v.tree !== "string" ||
      !/^[a-f0-9]{40}$/.test(v.tree) ||
      (tree !== undefined && v.tree !== tree) ||
      !Array.isArray(v.entries) ||
      v.entries.length === 0 ||
      v.entries.length > 100_000
    )
      throw new Error("selected-source candidate identity differs");
    const rows: Array<SelectedSource> = [];
    const seen = new Set<string>();
    for (const item of v.entries as Array<unknown>) {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        throw new Error("invalid selected-source entry");
      const row = item as Record<string, unknown>;
      if (
        Object.keys(row).toSorted().join(",") !== "mode,oid,path,selected" ||
        typeof row.path !== "string" ||
        !row.path ||
        row.path.startsWith("/") ||
        /[^\x20-\x7e]|\\/.test(row.path) ||
        row.path
          .split("/")
          .some(
            (part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git",
          ) ||
        seen.has(row.path) ||
        typeof row.mode !== "string" ||
        !["100644", "100755", "120000"].includes(row.mode) ||
        typeof row.oid !== "string" ||
        !/^[a-f0-9]{40}$/.test(row.oid) ||
        typeof row.selected !== "boolean" ||
        (!row.selected && row.path.split("/").at(-1) === ".gitattributes") ||
        (row.selected && (row.mode === "120000" || protectedSourceName(row.path)))
      )
        throw new Error("unsafe selected-source entry");
      seen.add(row.path);
      rows.push(row as unknown as SelectedSource);
    }
    if (
      !rows.some((row) => row.selected) ||
      rows.filter((row) => !row.selected).length > 4096 ||
      rows.some((row, index) => index > 0 && rows[index - 1]!.path >= row.path)
    )
      throw new Error("invalid selected-source bounds or order");
    const canonical = JSON.stringify({
      schema: "gram.selected-source/v1",
      head,
      base,
      tree: v.tree,
      entries: rows.map((row) => ({
        path: row.path,
        mode: row.mode,
        oid: row.oid,
        selected: row.selected,
      })),
    });
    if (raw.toString("utf8") !== canonical)
      throw new Error("noncanonical selected-source manifest");
    return { tree: v.tree as string, entries: rows };
  } finally {
    closeSync(fd);
  }
}

const SHA = /^[a-f0-9]{40}$/;

export const LocalCheck = Schema.Struct({
  head: Schema.String,
  base: Schema.String,
  /** The tree of `head` merged onto `base`: what was checked. */
  tree: Schema.String,
  status: Schema.Literals(["running", "passed", "failed"]),
  command: Schema.String,
  preparation: Schema.optionalKey(
    Schema.Struct({
      manifest: Schema.String,
      sha256: Schema.String,
      inputConfigSha256: Schema.optionalKey(Schema.String),
    }),
  ),
  omittedSources: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        mode: Schema.String,
        oid: Schema.String,
        contents: Schema.Literal("NOT_READ_OR_VERIFIED"),
      }),
    ),
  ),
  /** `LOCAL_CHECK_ISOLATION` as the check ran. */
  isolation: Schema.String,
  projectId: Schema.optionalKey(Schema.String),
  setup: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Number),
  profile: Schema.optionalKey(Schema.String),
  qualification: Schema.optionalKey(Schema.String),
  mergedCommit: Schema.optionalKey(Schema.String),
  /** The joined machine it ran on, by id, through its host; absent for this machine. */
  machine: Schema.optionalKey(Schema.String),
  startedAt: Schema.Number,
  finishedAt: Schema.optionalKey(Schema.Number),
  host: Schema.String,
  /** Why it failed, in a line. */
  reason: Schema.optionalKey(Schema.String),
  /** Why it failed, for a reader to act on, when the run says. */
  failure: Schema.optionalKey(LocalCheckFailure),
  /** The run's output. */
  log: Schema.optionalKey(Schema.String),
  /**
   * Set on a run Gram took back after it quit: `restarted` ran it again from the start, its
   * process gone; `kept` found it still running, or ended, and kept its result.
   */
  afterQuit: Schema.optionalKey(Schema.Literals(["restarted", "kept"])),
  /** What a running check needs to be taken back after a quit; dropped once it ends. */
  job: Schema.optionalKey(
    Schema.Struct({
      /** Gram's own bare repository the check's worktree belongs to. */
      own: Schema.String,
      /** The folder of the repository it was asked for, to read its configuration again. */
      repoDir: Schema.String,
      /** The worktree, once made. */
      work: Schema.optionalKey(Schema.String),
      /** Where the wrapper writes its exit status. */
      status: Schema.optionalKey(Schema.String),
      pid: Schema.optionalKey(Schema.Number),
      processStart: Schema.optionalKey(Schema.String),
      deadline: Schema.optionalKey(Schema.Number),
      pathValue: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type LocalCheck = typeof LocalCheck.Type;
type CheckJobRecord = NonNullable<LocalCheck["job"]>;
/** A job whose process was recorded, as a restart finds it. */
type RecordedJob = CheckJobRecord & {
  readonly pid: number;
  readonly processStart: string;
  readonly work: string;
  readonly status: string;
};

/** A record as it ends: what took it back is kept, what ran it is not. */
const ended = (check: LocalCheck): LocalCheck => {
  const { job: _, ...rest } = check;
  return rest;
};

/** How a check Gram lost track of while closed ended. */
const lost = (reason: string): LocalCheckOutcome => ({
  ok: false,
  reason,
  failure: { kind: "stopped" },
});

/** Why a running check reads as it does after Gram started again. */
const RESTARTED_AFTER_QUIT = "restarted after Gram quit";
const KEPT_AFTER_QUIT = "kept running while Gram was closed";

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(LocalCheck));
const encode = Schema.encodeSync(Schema.fromJsonString(LocalCheck));

/** Runs the check in a prepared worktree. The live one spawns the command; tests supply their own. */
export interface LocalCheckRunnerShape {
  readonly run: (
    dir: string,
    log: string,
    run: LocalCheckRun,
    source: MergedCheckSource,
  ) => Effect.Effect<LocalCheckOutcome>;
}

export class LocalCheckRunner extends Context.Service<LocalCheckRunner, LocalCheckRunnerShape>()(
  "@gram/server/LocalCheckRunner",
) {
  /** On the login-shell PATH: a Finder- or Dock-launched app inherits launchd's, without `bun`. */
  static readonly layer: Layer.Layer<LocalCheckRunner, never, PathProbe | ServerConfig> =
    Layer.effect(
      LocalCheckRunner,
      Effect.gen(function* () {
        const probe = yield* PathProbe;
        return {
          run: (dir, log, run, source) =>
            probe.path.pipe(
              Effect.flatMap((pathValue) =>
                spawnCheck(
                  dir,
                  log,
                  {
                    base: process.env,
                    pathValue,
                    retain: source.retain,
                    durable: source.durable,
                  },
                  run,
                ),
              ),
            ),
        };
      }),
    );
}

/** Shared selected checkout and raw-byte verification for native and explicit publisher preparation. */
type SelectedGit = (
  args: ReadonlyArray<string>,
  env?: Record<string, string>,
  more?: { readonly stdin?: string },
) => Effect.Effect<ProcOutput | undefined>;
const checkoutSelected = (
  dir: string,
  selection: ReadonlyArray<SelectedSource>,
  runGit: SelectedGit,
) =>
  Effect.gen(function* () {
    const files = selection
      .filter((row) => row.selected)
      .map((row) => row.path + "\0")
      .join("");
    const checkout = yield* runGit(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.autocrlf=false",
        "checkout-index",
        "--stdin",
        "-z",
      ],
      { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1" },
      { stdin: files },
    );
    if (checkout?.status !== 0 || checkout.truncated) return "selected-source checkout failed";
    try {
      verifySelectedWorktree(dir, selection);
      return undefined;
    } catch {
      return "selected-source materialization differs";
    }
  });

/** Prepare an already indexed, empty publisher using the same selected checkout as native checks.
 * This is preparation only; provider approval, partial-store safety and the local check remain separate.
 */
export const materializeSelectedPublisher = (
  dir: string,
  preparation: NonNullable<ProjectLocalCheck["preparation"]>,
  head: string,
  base: string,
  tree: string,
) =>
  Effect.gen(function* () {
    if (
      !nodePath.isAbsolute(dir) ||
      nodePath.normalize(dir) !== dir ||
      realPathSync(dir) !== dir ||
      !lstatSync(dir).isDirectory() ||
      lstatSync(dir).isSymbolicLink() ||
      !lstatSync(nodePath.join(dir, ".git")).isFile() ||
      lstatSync(nodePath.join(dir, ".git")).isSymbolicLink() ||
      readdirSync(dir).some((name) => name !== ".git")
    )
      throw new Error("publisher is not an empty canonical linked worktree");
    const selection = selectedSourceManifest(preparation, head, base, tree).entries;
    const proc = yield* Proc;
    const g: SelectedGit = (args, env, more) =>
      git(dir, args, {
        ...more,
        omitEnv: isGitControl,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_GRAFT_FILE: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_LAZY_FETCH: "1",
          GIT_ATTR_NOSYSTEM: "1",
          ...env,
        },
      }).pipe(
        Effect.provideService(Proc, proc),
        Effect.option,
        Effect.map((out) => (out._tag === "Some" ? out.value : undefined)),
      );
    const identity = requiredPublisherGit(yield* g(["rev-parse", "HEAD", "HEAD^{tree}"]))
      .trim()
      .split("\n");
    if (identity.length !== 2 || identity[0] !== head || identity[1] !== tree)
      throw new Error("publisher head/tree differs");
    const expected = new Map(selection.map((row) => [row.path, `${row.mode} ${row.oid}`]));
    const top = requiredPublisherGit(yield* g(["rev-parse", "--show-toplevel"])).trim();
    if (top !== dir) throw new Error("publisher Git root differs");
    if (
      requiredPublisherGit(
        yield* g(["for-each-ref", "--format=%(refname)", "refs/replace/"]),
      ).trim() !== ""
    )
      throw new Error("publisher replacement refs forbidden");
    // GIT_GRAFT_FILE is deliberately /dev/null for child commands, so asking
    // rev-parse for info/grafts would return that override rather than the real file.
    const common = requiredPublisherGit(
      yield* g(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ).trim();
    if (!nodePath.isAbsolute(common) || realPathSync(common) !== common)
      throw new Error("publisher common Git directory is not canonical");
    const attrs = requiredPublisherGit(
      yield* g(["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"]),
    ).trim();
    if (!nodePath.isAbsolute(attrs))
      throw new Error("publisher Git attributes path is not absolute");
    for (const [label, path] of [
      ["info/grafts", nodePath.join(common, "info/grafts")],
      ["info/attributes", attrs],
    ]) {
      try {
        lstatSync(path!);
        throw new Error(`publisher ${label} forbidden`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const treeRows = requiredPublisherGit(yield* g(["ls-tree", "-r", "-z", "--full-tree", head]))
      .split("\0")
      .filter(Boolean);
    if (
      treeRows.length !== expected.size ||
      treeRows.some((row) => {
        const tab = row.indexOf("\t"),
          meta = row.slice(0, tab).split(" ");
        return (
          tab < 0 ||
          meta.length !== 3 ||
          meta[1] !== "blob" ||
          expected.get(row.slice(tab + 1)) !== `${meta[0]} ${meta[2]}`
        );
      })
    )
      throw new Error("publisher tree differs from selection");
    const index = requiredPublisherGit(yield* g(["ls-files", "--stage", "-z"]))
      .split("\0")
      .filter(Boolean);
    if (
      index.length !== expected.size ||
      index.some((row) => {
        const tab = row.indexOf("\t"),
          meta = row.slice(0, tab).split(" ");
        return (
          tab < 0 ||
          meta.length !== 3 ||
          meta[2] !== "0" ||
          expected.get(row.slice(tab + 1)) !== `${meta[0]} ${meta[1]}`
        );
      })
    )
      throw new Error("publisher index differs from selection");
    const flags = requiredPublisherGit(yield* g(["ls-files", "-v", "-z"]))
      .split("\0")
      .filter(Boolean);
    if (
      flags.length !== expected.size ||
      flags.some((row) => !row.startsWith("H ") || !expected.has(row.slice(2)))
    )
      throw new Error("publisher index flags differ");
    const selectedNames = selection
      .filter((row) => row.selected)
      .map((row) => row.path + "\0")
      .join("");
    const attributes = requiredPublisherGit(
      yield* g(
        ["-c", "core.attributesFile=/dev/null", "check-attr", "--cached", "--all", "--stdin", "-z"],
        undefined,
        { stdin: selectedNames },
      ),
    ).split("\0");
    if (attributes.at(-1) === "") attributes.pop();
    if (
      attributes.length % 3 !== 0 ||
      attributes.some((value, i) => i % 3 === 1 && value === "filter")
    )
      throw new Error("publisher selected filter attributes are forbidden");
    const checkoutError = yield* checkoutSelected(dir, selection, g);
    if (checkoutError !== undefined) throw new Error(checkoutError);
    selectedSourceManifest(preparation, head, base, tree);
    return {
      head,
      base,
      tree,
      selectionSha256: preparation.sha256,
      selected: selection.filter((row) => row.selected).length,
    };
  });

export interface LocalChecksShape {
  readonly configuration: (
    repoDir: CheckSite,
    projectId?: ProjectId,
  ) => Effect.Effect<{
    readonly project: string;
    readonly config: LocalCheckRun | undefined;
    readonly reason: string;
  }>;

  /** The check of `head` merged onto `base`, in `repoDir`'s repository, if one ran or runs. */
  readonly lookup: (
    repoDir: CheckSite,
    head: string | undefined,
    base: string | undefined,
    projectId?: ProjectId,
  ) => Effect.Effect<LocalCheck | undefined>;
  /**
   * Starts that check unless it passed after the optional reconciliation cutoff, is running, or
   * failed at or after `since`; `onDone` hears how it ended. A running older check finishes in
   * the same managed queue; its pass cannot satisfy the cutoff. Undefined for unknown commits.
   */
  readonly ensure: (
    repoDir: CheckSite,
    head: string,
    base: string,
    options: {
      readonly projectId?: ProjectId;
      readonly since: number;
      /** An explicit merge-fence reconciliation retires every older pass. */
      readonly after?: number;
      readonly onDone: (check: LocalCheck) => Effect.Effect<void>;
    },
  ) => Effect.Effect<LocalCheck | undefined>;
  /**
   * The latest check of `head` on `base` with `repoDir`'s current command that Gram ran or runs,
   * from memory alone, for showing where it stands (the ledger). Never a merge's evidence: that is
   * `lookup`'s, which reads the merged tree.
   */
  readonly latest: (
    repoDir: CheckSite,
    head: string,
    base: string,
    project?: Project,
  ) => LocalCheck | undefined;
  /**
   * Applies the retention policy now (`keptCheck`, `LOG_BUDGET_BYTES`), as Gram does a while after
   * it starts and every `SWEEP_EVERY` after: what it removed.
   */
  readonly sweep: Effect.Effect<RetentionReport>;
}

/** What a retention sweep removed. */
interface RetentionReport {
  /** Finished checks forgotten. */
  readonly records: number;
  /** Logs deleted, and their bytes. */
  readonly logs: number;
  readonly logBytes: number;
  /** Abandoned work folders reclaimed. */
  readonly work: number;
  /** Gram's own repositories garbage-collected, and removed as unused. */
  readonly collected: number;
  readonly repos: number;
}

/** A pass is kept this long, and its commits with it: past it, its base has surely moved. */
export const PASS_KEEP_MS = 30 * DAY_MS;
/** Any other finished check is kept this long. */
export const OTHER_KEEP_MS = 7 * DAY_MS;
/** The most the logs of kept checks may take; the oldest finished ones' go first. */
const LOG_BUDGET_BYTES = 256 * 1024 * 1024;
/** A work folder or log nothing names, untouched this long, was left by a crash. */
const ABANDONED_MS = 60 * 60 * 1000;
/** How often Gram's own repositories are garbage-collected. */
const GC_EVERY_MS = DAY_MS;
/** Unreachable objects younger than this survive a collection: a fetch in flight needs them. */
const GC_PRUNE = "3.days.ago";
/** When the first sweep runs after a start, and how often after it. */
const SWEEP_FIRST = Duration.minutes(5);
const SWEEP_EVERY = Duration.hours(6);
/** In one of Gram's repositories, touched when it was last garbage-collected. */
const COLLECTED = "gram-gc";

/** Whether retention keeps `check`: every running one, passes `PASS_KEEP_MS`, others `OTHER_KEEP_MS`. */
export const keptCheck = (check: LocalCheck, now: number): boolean =>
  check.status === "running" ||
  (check.finishedAt ?? check.startedAt) >=
    now - (check.status === "passed" ? PASS_KEEP_MS : OTHER_KEEP_MS);

/**
 * The keys whose logs go so the rest fit `budget`: finished checks' only, the oldest first.
 */
export const logsOverBudget = (
  logs: ReadonlyArray<{ readonly key: string; readonly check: LocalCheck; readonly size: number }>,
  budget = LOG_BUDGET_BYTES,
): ReadonlyArray<string> =>
  dropOldest(logs, {
    olderFirst: (a, b) => (a.check.finishedAt ?? 0) - (b.check.finishedAt ?? 0),
    maxSize: budget,
    sizeOf: (log) => log.size,
    pinned: (log) => log.check.status === "running",
  }).map((log) => log.key);

/** A file's size and when it last changed, or undefined when it isn't a regular file. */
const fileStat = (path: string) => {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
};

/** The names in `dir`, or none when it can't be read. */
const entries = (dir: string): ReadonlyArray<string> => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

export class LocalChecks extends Context.Service<LocalChecks, LocalChecksShape>()(
  "@gram/server/LocalChecks",
) {}

/**
 * A check vouches for one head on one base, with one run (`LocalCheckRun`). Two bases can merge
 * with a head into the same tree (one moved by an empty commit, or by a commit the head has too),
 * and a pass on one doesn't carry over to the other: merge_when_ready pins the base it launches on
 * to the checked one. Nor does a pass of another run count.
 */
const keyOf = (
  head: string,
  base: string,
  tree: string | null,
  run: Parameters<typeof runIdOf>[0] & { readonly machine?: string | undefined },
) =>
  // A joined machine's check is asked for before its host says what tree it merged: the pair
  // names it, as the tree names nothing a pair doesn't already.
  run.machine === undefined
    ? `${head}:${base}:${tree ?? "conflict"}:${runIdOf(run)}`
    : `machine:${run.machine}:${head}:${base}:${runIdOf(run)}`;

/** A broken database is a defect, as in `ThreadStore`. */
const run = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.catch((error) => Effect.die(error)));

const fixedIdentity = {
  GIT_AUTHOR_NAME: "Gram",
  GIT_AUTHOR_EMAIL: "gram@localhost",
  GIT_COMMITTER_NAME: "Gram",
  GIT_COMMITTER_EMAIL: "gram@localhost",
  GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
};

// Shared native metadata-first selected tree preparation; both LocalChecks
// and the explicit private-publisher entry use this identical path.
type SelectedTreeGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: Record<string, string>,
  more?: { readonly stdin?: string; readonly tier?: "local" | "slow" },
) => Effect.Effect<ProcOutput | undefined>;
const selectedTreeOf = (
  own: string,
  repoDir: string,
  head: string,
  base: string,
  fetch: boolean,
  preparation: NonNullable<ProjectLocalCheck["preparation"]>,
  g: SelectedTreeGit,
  hasCommit: (dir: string, sha: string, noLazy?: boolean) => Effect.Effect<boolean>,
  trees: Map<string, string | null>,
) =>
  Effect.gen(function* () {
    // A partial source repository is kept separate from ordinary checks,
    // so an earlier full fetch cannot supply a selected check's objects.
    let selection: { tree: string; entries: Array<SelectedSource> };
    try {
      selection = selectedSourceManifest(preparation, head, base);
    } catch {
      return undefined;
    }
    const cachedKey = `selected:${preparation.sha256}:${head}:${base}`;
    if (!fetch) return trees.get(cachedKey);
    const env = {
      GIT_NO_LAZY_FETCH: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const upload =
      "--upload-pack=git -c uploadpack.allowFilter=true -c uploadpack.allowAnySHA1InWant=true upload-pack";
    // Git otherwise silently falls back to a full fetch if the server
    // does not advertise filtering. Check the local upload-pack's v2
    // capability before requesting any candidate objects.
    const advertise = yield* g(
      own,
      [
        "-c",
        "protocol.file.allow=always",
        "-c",
        "protocol.version=2",
        "ls-remote",
        upload,
        pathToFileURL(repoDir).href,
      ],
      { ...env, GIT_TRACE_PACKET: "1" },
    );
    // The client receives the server's v2 capability advertisement over
    // the transport. A separated upload-pack does not share its stderr.
    if (
      advertise?.status !== 0 ||
      advertise.truncated ||
      !/ls-remote< fetch=[^\r\n]*\bfilter\b/.test(advertise.stderr)
    )
      return undefined;
    for (const sha of [head, base]) {
      if (yield* hasCommit(own, sha, true)) continue;
      const result = yield* g(
        own,
        [
          "-c",
          "protocol.file.allow=always",
          "-c",
          "protocol.version=2",
          "fetch",
          "--quiet",
          "--no-tags",
          "--filter=blob:none",
          upload,
          pathToFileURL(repoDir).href,
          sha,
        ],
        env,
      );
      if (result?.status !== 0 || !(yield* hasCommit(own, sha, true))) return undefined;
    }
    const ancestor = yield* g(own, ["merge-base", base, head], env);
    const parent = ancestor?.status === 0 ? ancestor.stdout.trim() : "";
    if (!SHA.test(parent)) return undefined;
    const inputTrees: Array<Map<string, { mode: string; oid: string }>> = [];
    for (const rev of [parent, base, head]) {
      const census = yield* g(own, ["ls-tree", "-r", "-z", "--full-tree", rev], env);
      if (census?.status !== 0 || census.truncated) return undefined;
      const revTree = new Map<string, { mode: string; oid: string }>();
      for (const item of census.stdout.split("\0").filter(Boolean)) {
        const at = item.indexOf("\t");
        const meta = item.slice(0, at).split(" ");
        const path = item.slice(at + 1);
        if (
          at < 0 ||
          meta.length !== 3 ||
          meta[1] !== "blob" ||
          !["100644", "100755", "120000"].includes(meta[0]!) ||
          !SHA.test(meta[2]!) ||
          revTree.has(path)
        )
          return undefined;
        revTree.set(path, { mode: meta[0]!, oid: meta[2]! });
      }
      inputTrees.push(revTree);
    }
    const selected = new Map(
      selection.entries.filter((row) => row.selected).map((row) => [row.path, row]),
    );
    const omitted = new Map(
      selection.entries.filter((row) => !row.selected).map((row) => [row.path, row]),
    );
    const paths = new Set([
      ...selection.entries.map((row) => row.path),
      ...inputTrees.flatMap((tree) => [...tree.keys()]),
    ]);
    const needed = new Set<string>();
    const excluded = new Set<string>();
    for (const path of paths) {
      const values = inputTrees.map((tree) => tree.get(path));
      if (selected.has(path)) {
        for (const row of values) {
          if (row !== undefined && !["100644", "100755"].includes(row.mode)) return undefined;
          if (row !== undefined) needed.add(row.oid);
        }
      } else {
        // Only an unchanged omitted blob can pass to merge-tree; do not
        // give Git the opportunity to merge or lazily fetch its bytes.
        const target = omitted.get(path);
        if (target === undefined) return undefined;
        if (values.some((row) => row?.oid !== target.oid || row.mode !== target.mode))
          return undefined;
        excluded.add(target.oid);
      }
    }
    if ([...needed].some((oid) => excluded.has(oid))) return undefined;
    if (fetch) {
      const blobs = [...needed];
      for (let offset = 0; offset < blobs.length; offset += 128) {
        const result = yield* g(
          own,
          [
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--quiet",
            "--no-tags",
            upload,
            pathToFileURL(repoDir).href,
            ...blobs.slice(offset, offset + 128),
          ],
          env,
        );
        if (result?.status !== 0) return undefined;
      }
    }
    const merged = yield* g(own, ["merge-tree", "--write-tree", "--no-messages", base, head], env);
    const tree = merged?.status === 0 ? merged.stdout.split("\n")[0]!.trim() : undefined;
    if (tree !== selection.tree) return undefined;
    trees.set(cachedKey, tree);
    return tree;
  });

/** Create a fresh isolated selected-only Git store and empty indexed publisher.
 * This does not materialize selected source or run a local check.
 */
export const prepareSelectedPrivatePublisher = (
  sourceRepo: string,
  own: string,
  publisher: string,
  head: string,
  base: string,
  tree: string,
  preparation: NonNullable<ProjectLocalCheck["preparation"]>,
) =>
  Effect.gen(function* () {
    const parent = nodePath.dirname(own);
    if (
      ![sourceRepo, own, publisher].every(
        (p) => nodePath.isAbsolute(p) && nodePath.normalize(p) === p && realPathSync(p) === p,
      ) ||
      own === publisher ||
      nodePath.dirname(publisher) !== parent ||
      realPathSync(parent) !== parent ||
      lstatSync(parent).uid !== process.getuid?.() ||
      (lstatSync(parent).mode & 0o777) !== 0o700 ||
      !lstatSync(own).isDirectory() ||
      !lstatSync(publisher).isDirectory() ||
      readdirSync(own).length !== 0 ||
      readdirSync(publisher).length !== 0
    )
      throw new Error("private selected publisher paths are not fresh and owned");
    selectedSourceManifest(preparation, head, base, tree);
    const proc = yield* Proc;
    const g: SelectedTreeGit = (cwd, args, env, more) =>
      git(cwd, args, {
        ...more,
        omitEnv: isGitControl,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_GRAFT_FILE: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_NO_LAZY_FETCH: "1",
          ...env,
        },
      }).pipe(
        Effect.provideService(Proc, proc),
        Effect.option,
        Effect.map((out) => (out._tag === "Some" ? out.value : undefined)),
      );
    requirePreparedGit(yield* g(own, ["init", "--quiet", "--bare", "--template=", own]));
    const hasCommit = (dir: string, sha: string, noLazy = false) =>
      g(
        dir,
        ["cat-file", "-e", `${sha}^{commit}`],
        noLazy ? { GIT_NO_LAZY_FETCH: "1" } : undefined,
      ).pipe(Effect.map((out) => out?.status === 0));
    const selected = yield* selectedTreeOf(
      own,
      sourceRepo,
      head,
      base,
      true,
      preparation,
      g,
      hasCommit,
      new Map(),
    );
    if (selected !== tree) throw new Error("private selected tree unavailable or differs");
    requirePreparedGit(
      yield* g(own, [
        "-c",
        "core.hooksPath=/dev/null",
        "worktree",
        "add",
        "--no-checkout",
        "--detach",
        publisher,
        head,
      ]),
    );
    requirePreparedGit(yield* g(publisher, ["read-tree", head]));
    if (
      !lstatSync(nodePath.join(publisher, ".git")).isFile() ||
      readdirSync(publisher).some((n) => n !== ".git")
    )
      throw new Error("private publisher unexpectedly materialized source");
    selectedSourceManifest(preparation, head, base, tree);
    return { head, base, tree, selectionSha256: preparation.sha256, own, publisher };
  });

export const LocalChecksLive = Layer.effect(
  LocalChecks,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const sql = yield* SqlClient.SqlClient;
    const proc = yield* Proc;
    const runner = yield* LocalCheckRunner;
    const { dataDir } = yield* ServerConfig;
    /** The machines joined to this Gram, whose threads' checks run through their hosts. */
    const remoteHosts = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
    const reattachMs = yield* MachineReattachMs;
    const machineName = (id: string) => remoteHosts?.machines.get(id)?.name ?? id;
    const records = new Map<string, LocalCheck>();
    /** `${head}:${base}` to the latest of its records. */
    const latestByPair = new Map<string, LocalCheck>();
    const remember = (key: string, check: LocalCheck) => {
      records.set(key, check);
      const pair = `${check.head}:${check.base}:${runIdOf(check)}`;
      if ((latestByPair.get(pair)?.startedAt ?? -1) <= check.startedAt)
        latestByPair.set(pair, check);
    };
    const waiters = new Map<string, Array<(check: LocalCheck) => Effect.Effect<void>>>();
    const fibers = yield* FiberMap.make<number>();
    let runs = 0;
    /**
     * Set as Gram's scope closes, before the checks' fibers are interrupted: a check whose process
     * was recorded is then left running (`DurableCheck`), and taken back on the next start.
     */
    let closing = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closing = true;
      }),
    );
    // A cap on Gram's own checks at once on this machine (`localCheckConcurrencyOf`): each runs a
    // project's whole check, and several at once starve each other into their timeouts. The rest
    // wait their turn in order, reading as queued; a check's timeout starts once it runs.
    const cores = availableParallelism();
    const capacity = store.getSettings.pipe(
      Effect.map((settings) => localCheckConcurrencyOf(settings, cores)),
    );
    /** Each queued check reads how many wait ahead of it. */
    const queuedNote = (waiting: ReadonlyArray<string>) =>
      waiting.forEach((key, ahead) => {
        const queued = records.get(key);
        if (queued?.status === "running")
          remember(key, { ...queued, reason: `queued for local check (${ahead} ahead)` });
      });
    const admission = makeAdmission<string>(capacity, queuedNote);
    /**
     * Each joined machine's own slot, one check at a time there: a check on another machine never
     * waits behind this one's, nor this one's behind it.
     */
    const machineAdmissions = new Map<string, ReturnType<typeof makeAdmission<string>>>();
    const machineAdmission = (hostId: string) => {
      let found = machineAdmissions.get(hostId);
      if (found === undefined) {
        found = makeAdmission<string>(Effect.succeed(1), queuedNote);
        machineAdmissions.set(hostId, found);
      }
      return found;
    };
    /**
     * Runs `effect` once a slot is free, in turn; `record` is how the check reads once it runs.
     * Gram quitting interrupts a wait as readily as a run.
     */
    const inTurn = <A, E, R>(
      key: string,
      record: () => LocalCheck,
      effect: Effect.Effect<A, E, R>,
    ) =>
      admission.inTurn(
        key,
        Effect.suspend(() => {
          remember(key, record());
          return effect;
        }),
      );

    /** Running checks a previous run of Gram left, taken back once everything is defined. */
    const left: Array<{ readonly key: string; readonly check: LocalCheck }> = [];
    /** `${head}:${base}` to its merged tree, or `null` when they conflict. */
    const trees = new Map<string, string | null>();

    // Keyed by what each record says it checked: a row under any other key comes back under that
    // one, the latest of them winning, and is written back under it.
    const rekeyed = new Set<string>();
    for (const row of yield* run(
      sql<{ key: string; data: string }>`SELECT key, data FROM local_checks`,
    )) {
      const record = decode(row.data);
      if (record._tag === "None") continue;
      if (record.value.status === "running") {
        left.push({ key: row.key, check: record.value });
        continue;
      }
      const { head, base, tree } = record.value;
      const key = keyOf(head, base, tree === "" ? null : tree, record.value);
      if (key !== row.key) {
        rekeyed.add(key);
        yield* run(sql`DELETE FROM local_checks WHERE key = ${row.key}`);
      }
      const other = records.get(key);
      if (other === undefined || (other.finishedAt ?? 0) <= (record.value.finishedAt ?? 0))
        remember(key, record.value);
    }
    for (const key of rekeyed) {
      const check = records.get(key)!;
      yield* run(
        sql`INSERT INTO local_checks (key, data) VALUES (${key}, ${encode(check)})
          ON CONFLICT(key) DO UPDATE SET data = excluded.data`,
      );
    }

    // Everything an agent's checkout shares with its repository (refs, config, attributes, hooks,
    // `info`, the object files themselves) can be written from that checkout. So the merge and its
    // worktree are made in a bare repository of Gram's own, which takes objects from the agent's
    // repository only by fetch: each arrives hashed again, so none can be anything but what its id
    // names. Replace refs and grafts are ignored besides, no hook runs, and no git variable Gram
    // inherited points it elsewhere (`isGitControl`); what the user's own global and system git
    // config do (LFS, say) still applies, as it does for any git they run.
    const g = (
      cwd: string,
      args: ReadonlyArray<string>,
      env?: Record<string, string>,
      more?: { readonly stdin?: string; readonly tier?: "local" | "slow" },
    ) =>
      git(cwd, args, {
        ...more,
        omitEnv: isGitControl,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_GRAFT_FILE: "/dev/null",
          ...env,
        },
      }).pipe(
        Effect.provideService(Proc, proc),
        Effect.option,
        Effect.map((out) => (out._tag === "Some" ? out.value : undefined)),
      );
    const configuration: LocalChecksShape["configuration"] = (repoDir, projectId) =>
      Effect.gen(function* () {
        if (typeof repoDir !== "string") return yield* machineConfiguration(repoDir, projectId);
        const common = yield* g(repoDir, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        const projects = yield* store.listProjects;
        let found: (typeof projects)[number] | undefined;
        if (common?.status === 0)
          for (const project of projects.filter(
            (p) => projectId === undefined || p.id === projectId,
          )) {
            const other = yield* g(project.repoRoot ?? project.root, [
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir",
            ]);
            if (other?.status === 0 && other.stdout.trim() === common.stdout.trim()) {
              found = project;
              break;
            }
          }
        const project = found?.name ?? nodePath.basename(repoDir);
        const config = localCheckRunFor(
          found?.localCheck,
          found?.id,
          found?.localCheckUnavailable,
          found?.localCheckRevision,
        );
        return {
          project,
          config,
          reason:
            config === undefined
              ? `no local check configured for ${project}; local gate OFF — CI and GitHub rules apply`
              : (config.refusal ?? `local check configured for ${project}`),
        };
      });

    const checksDir = nodePath.join(dataDir, "local-checks");

    /** Gram's own bare repository for the one `repoDir` belongs to, made on first use. */
    const ownRepoOf = (repoDir: string, wanted?: LocalCheckRun) =>
      Effect.gen(function* () {
        const common = yield* g(repoDir, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        const source = common?.status === 0 ? common.stdout.trim() : repoDir;
        const own = nodePath.join(
          checksDir,
          "repos",
          `${createHash("sha256")
            .update(source)
            .update(
              wanted?.preparation === undefined
                ? ""
                : "\0selected-metadata-v1\0" + wanted.preparation.sha256,
            )
            .digest("hex")
            .slice(0, 16)}.git`,
        );
        if (!existsSync(nodePath.join(own, "HEAD"))) {
          yield* Effect.sync(() => mkdirSync(own, { recursive: true }));
          yield* g(own, ["init", "--quiet", "--bare", "--template=", own]);
        }
        return own;
      });

    const hasCommit = (dir: string, sha: string, noLazy = false) =>
      g(
        dir,
        ["cat-file", "-e", `${sha}^{commit}`],
        noLazy ? { GIT_NO_LAZY_FETCH: "1" } : undefined,
      ).pipe(Effect.map((out) => out?.status === 0));

    /** Fetches `sha` into Gram's repository from `repoDir`'s, after fetching it there if need be. */
    const fetchInto = (own: string, repoDir: string, sha: string) =>
      Effect.gen(function* () {
        const take = g(own, [
          "-c",
          "protocol.file.allow=always",
          "fetch",
          "--no-tags",
          "--quiet",
          pathToFileURL(repoDir).href,
          sha,
        ]);
        yield* take;
        if (yield* hasCommit(own, sha)) return true;
        yield* g(repoDir, ["fetch", "--no-tags", "--quiet", "origin", sha]);
        yield* take;
        return yield* hasCommit(own, sha);
      });

    /**
     * The tree of `head` merged onto `base` in Gram's repository; `null` on conflicts; undefined
     * when unknowable, which it is until `fetch` brought both commits in.
     */
    const treeOf = (
      own: string,
      repoDir: string,
      head: string,
      base: string,
      fetch: boolean,
      wanted?: LocalCheckRun,
    ) =>
      Effect.gen(function* () {
        if (wanted?.preparation !== undefined)
          return yield* selectedTreeOf(
            own,
            repoDir,
            head,
            base,
            fetch,
            wanted.preparation,
            g,
            hasCommit,
            trees,
          );
        const cached = trees.get(`${head}:${base}`);
        if (cached !== undefined) return cached;
        for (const sha of [head, base]) {
          if (!(yield* hasCommit(own, sha)) && !(fetch && (yield* fetchInto(own, repoDir, sha))))
            return undefined;
        }
        const out = yield* g(own, ["merge-tree", "--write-tree", "--no-messages", base, head]);
        if (out === undefined || (out.status !== 0 && out.status !== 1)) return undefined;
        const tree = out.status === 1 ? null : out.stdout.split("\n")[0]!.trim();
        if (tree !== null && !SHA.test(tree)) return undefined;
        trees.set(`${head}:${base}`, tree);
        return tree;
      });

    const lookup: LocalChecksShape["lookup"] = (repoDir, head, base, projectId) =>
      Effect.gen(function* () {
        if (head === undefined || base === undefined || !SHA.test(head) || !SHA.test(base))
          return undefined;
        const { config: wanted } = yield* configuration(repoDir, projectId);
        if (wanted === undefined) return undefined;
        if (typeof repoDir !== "string") {
          const found = records.get(
            keyOf(head, base, null, { ...wanted, machine: repoDir.hostId }),
          );
          return found?.head === head &&
            found.base === base &&
            found.machine === repoDir.hostId &&
            found.isolation === wanted.isolation &&
            runIdOf(found) === runIdOf(wanted)
            ? found
            : undefined;
        }
        // Without fetching: a pair Gram never fetched has no check of it.
        const own = yield* ownRepoOf(repoDir, wanted);
        const tree = yield* treeOf(own, repoDir, head, base, false, wanted);
        if (tree === undefined) return undefined;
        const found = records.get(keyOf(head, base, tree, wanted));
        return found?.head === head &&
          found.base === base &&
          found.isolation === wanted.isolation &&
          runIdOf(found) === runIdOf(wanted)
          ? found
          : undefined;
      });

    // A running check is kept too, with what it needs to be taken back after a quit (`job`).
    const save = (key: string, check: LocalCheck) =>
      Effect.gen(function* () {
        remember(key, check);
        yield* run(
          sql`INSERT INTO local_checks (key, data) VALUES (${key}, ${encode(check)})
            ON CONFLICT(key) DO UPDATE SET data = excluded.data`,
        );
      });

    const finish = (key: string, check: LocalCheck) =>
      Effect.gen(function* () {
        yield* save(key, check);
        const listeners = waiters.get(key) ?? [];
        waiters.delete(key);
        for (const listener of listeners) yield* listener(check).pipe(Effect.ignore);
      });

    /**
     * Checks the merged tree in a worktree of Gram's repository `own`, in a folder no one can name
     * beforehand, removed afterwards whatever happens.
     */
    /** Removes a check's worktree, only one made under Gram's own `work` folder. */
    const removeWork = (own: string, dir: string) =>
      Effect.gen(function* () {
        const parent = nodePath.dirname(dir);
        if (
          nodePath.basename(dir) !== "src" ||
          nodePath.dirname(parent) !== nodePath.join(checksDir, "work")
        )
          return;
        yield* g(own, ["worktree", "remove", "--force", dir]);
        yield* Effect.sync(() => rmSync(parent, { recursive: true, force: true }));
        yield* g(own, ["worktree", "prune"]);
      });

    /** The record of how a run ended, from how it was recorded running. */
    const endedAs = (
      running: LocalCheck,
      result: LocalCheckOutcome,
      finishedAt: number,
    ): LocalCheck => {
      const { reason: _, failure: __, ...rest } = ended(running);
      return {
        ...rest,
        status: result.ok ? "passed" : "failed",
        finishedAt,
        ...(result.ok || result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.ok || result.failure === undefined ? {} : { failure: result.failure }),
      };
    };

    const check = (own: string, key: string, started: LocalCheck, wanted: LocalCheckRun) => {
      let retain = false;
      /** Left running as Gram quit: the next start takes it, and its worktree, back. */
      let detached = false;
      let current = started;
      const record = (next: LocalCheck) => {
        current = next;
        return save(key, next);
      };
      /** What the record keeps of how the run is going, for a start after a quit. */
      const job = (more: Partial<CheckJobRecord>) =>
        current.job === undefined ? current : { ...current, job: { ...current.job, ...more } };
      const body = Effect.gen(function* () {
        if (wanted.refusal !== undefined) {
          yield* Effect.sync(() =>
            writeFileSync(started.log!, `${wanted.refusal}\n`, { mode: 0o600 }),
          );
          return {
            ok: false,
            reason: wanted.refusal,
            failure: { kind: "unstartable" },
          } satisfies LocalCheckOutcome;
        }
        const commit = yield* g(
          own,
          [
            "commit-tree",
            started.tree,
            "-p",
            started.base,
            "-p",
            started.head,
            "-m",
            `Gram local check of ${started.head} on ${started.base}`,
          ],
          fixedIdentity,
        );
        const sha = commit?.status === 0 ? commit.stdout.trim() : undefined;
        if (sha === undefined || !SHA.test(sha))
          return {
            ok: false,
            reason: "couldn't commit the merged tree",
            failure: { kind: "unstartable" },
          } satisfies LocalCheckOutcome;
        yield* record({ ...current, mergedCommit: sha });
        let selection: Array<SelectedSource> | undefined;
        if (wanted.preparation !== undefined) {
          try {
            selection = selectedSourceManifest(
              wanted.preparation,
              started.head,
              started.base,
              started.tree!,
            ).entries;
          } catch {
            return {
              ok: false,
              reason: "selected-source manifest refused",
              failure: { kind: "unstartable" },
            } satisfies LocalCheckOutcome;
          }
          const census = yield* g(own, ["ls-tree", "-r", "-z", "--full-tree", sha]);
          if (census?.status !== 0 || census.truncated)
            return {
              ok: false,
              reason: "selected-source tree unavailable",
              failure: { kind: "unstartable" },
            } satisfies LocalCheckOutcome;
          const expected = new Map(
            selection.map((row) => [row.path, `${row.mode} blob ${row.oid}`]),
          );
          const actual = census.stdout.split("\0").filter(Boolean);
          if (
            actual.length !== expected.size ||
            actual.some((item) => {
              const split = item.indexOf("\t");
              return split < 0 || expected.get(item.slice(split + 1)) !== item.slice(0, split);
            })
          )
            return {
              ok: false,
              reason: "selected-source tree membership differs",
              failure: { kind: "unstartable" },
            } satisfies LocalCheckOutcome;
          yield* record({
            ...current,
            omittedSources: selection
              .filter((row) => !row.selected)
              .map((row) => ({
                path: row.path,
                mode: row.mode,
                oid: row.oid,
                contents: "NOT_READ_OR_VERIFIED" as const,
              })),
          });
        }
        const work = nodePath.join(checksDir, "work");
        yield* Effect.sync(() => mkdirSync(work, { recursive: true }));
        const dir = nodePath.join(
          yield* Effect.sync(() =>
            mkdtempSync(nodePath.join(work, `${started.head.slice(0, 12)}-`)),
          ),
          "src",
        );
        const status = nodePath.join(nodePath.dirname(dir), "status");
        // Recorded before git writes it: a start after a crash knows the worktree is Gram's.
        yield* record(job({ work: dir, status }));
        const remove = Effect.gen(function* () {
          if (retain || detached) return;
          yield* removeWork(own, dir);
        });
        return yield* Effect.acquireUseRelease(
          // No checkout hook may change the tree after git wrote it.
          g(own, [
            "-c",
            "core.hooksPath=/dev/null",
            "worktree",
            "add",
            ...(selection === undefined ? [] : ["--no-checkout"]),
            "--detach",
            dir,
            sha,
          ]),
          (added) =>
            added?.status === 0
              ? Effect.gen(function* () {
                  if (selection !== undefined) {
                    const index = yield* g(dir, ["read-tree", sha], { GIT_NO_LAZY_FETCH: "1" });
                    const checkoutError =
                      index?.status === 0
                        ? yield* checkoutSelected(dir, selection, (args, env, more) =>
                            g(dir, args, env, more),
                          )
                        : "selected-source checkout failed";
                    if (checkoutError !== undefined)
                      return {
                        ok: false,
                        reason: checkoutError,
                        failure: { kind: "unstartable" },
                      } satisfies LocalCheckOutcome;
                  }
                  const outcome = yield* runner.run(dir, started.log!, wanted, {
                    head: started.head,
                    base: started.base,
                    tree: started.tree,
                    commit: sha,
                    retain: () => {
                      retain = true;
                      markRetained(dir);
                    },
                    durable: {
                      status,
                      started: (process) => record(job(process)).pipe(Effect.as(true)),
                      detach: () => {
                        if (!closing) return false;
                        detached = true;
                        return true;
                      },
                    },
                  });
                  if (selection !== undefined && wanted.preparation !== undefined) {
                    try {
                      selectedSourceManifest(
                        wanted.preparation,
                        started.head,
                        started.base,
                        started.tree,
                      );
                    } catch {
                      return {
                        ok: false,
                        reason: "selected-source manifest changed",
                        failure: { kind: "unstartable" },
                      } satisfies LocalCheckOutcome;
                    }
                  }
                  return outcome;
                })
              : Effect.succeed<LocalCheckOutcome>({
                  ok: false,
                  reason: "couldn't check out the merged tree",
                  failure: { kind: "unstartable" },
                }),
          () => remove,
        );
      });
      return inTurn(key, () => current, body).pipe(
        Effect.catchDefect((defect) =>
          Effect.succeed<LocalCheckOutcome>({
            ok: false,
            reason: `Gram's check failed to run: ${String(defect)}`,
            failure: { kind: "unstartable" },
          }),
        ),
        Effect.flatMap((result) =>
          Effect.gen(function* () {
            yield* finish(key, endedAs(current, result, yield* Clock.currentTimeMillis));
          }),
        ),
      );
    };

    /**
     * The project's check as a joined machine runs it: the project is the thread's own, since this
     * machine can't read the checkout there. A host too old to run checks has none, as a project
     * without a command has none; a selected-source check doesn't run there yet.
     */
    const machineConfiguration = (site: MachineCheckSite, projectId: ProjectId | undefined) =>
      Effect.gen(function* () {
        const projects = yield* store.listProjects;
        const found =
          projectId === undefined ? undefined : projects.find((each) => each.id === projectId);
        const project = found?.name ?? nodePath.basename(site.path);
        const name = machineName(site.hostId);
        const off = (why: string) => ({
          project,
          config: undefined,
          reason: `${why}; local gate OFF — CI and GitHub rules apply`,
        });
        if (remoteHosts?.machines.get(site.hostId) === undefined)
          return off(`no local check on ${name}: it isn't joined to this Gram`);
        const config = localCheckRunFor(
          found?.localCheck,
          found?.id,
          found?.localCheckUnavailable,
          found?.localCheckRevision,
        );
        if (config === undefined) return off(`no local check configured for ${project}`);
        // Offline, it can't say what it runs: the check waits for it rather than the gate opening.
        const online = yield* remoteHosts.connection(site.hostId).pipe(Effect.option);
        if (Option.isSome(online) && online.value.checks === undefined)
          return off(
            `no local check on ${name}: its gram-host is older than this Gram and runs none (run the install command there again to update it)`,
          );
        const refused =
          config.refusal === undefined && config.preparation !== undefined
            ? { ...config, refusal: `a selected-source check doesn't run on ${name} yet` }
            : config;
        return {
          project,
          config: refused,
          reason: refused.refusal ?? `local check configured for ${project}, on ${name}`,
        };
      });

    /** How a joined machine's run ended, as its record keeps it. */
    const machineEnded = (
      running: LocalCheck,
      result: HostCheckResult,
      finishedAt: number,
    ): LocalCheck => ({
      ...endedAs(running, result, finishedAt),
      tree: result.tree ?? "",
      ...(result.mergedCommit === undefined ? {} : { mergedCommit: result.mergedCommit }),
      host: result.host,
    });

    /**
     * Runs the check on the machine `site` is on, through its host, in that machine's own slot.
     * The host is asked under one id throughout: a connection that drops while it runs is waited
     * for (`MachineReattachMs`) and asked again, which joins the run still going there or hears
     * how it ended. Only the host's own answer is a result; a machine that doesn't come back in
     * time leaves the check unknown, a failure that runs again when asked, never a pass.
     */
    const machineCheck = (
      site: MachineCheckSite,
      key: string,
      started: LocalCheck,
      wanted: LocalCheckRun,
    ) => {
      const name = machineName(site.hostId);
      const request = {
        id: randomUUID(),
        path: site.path,
        ...(site.repoRoot === undefined ? {} : { repoRoot: site.repoRoot }),
        head: started.head,
        base: started.base,
        command: wanted.command,
        ...(wanted.setup === undefined ? {} : { setup: wanted.setup }),
        timeoutMs: wanted.timeoutMs ?? DEFAULT_LOCAL_CHECK_TIMEOUT_MS,
      };
      const failed = (
        reason: string,
        kind: LocalCheckFailure["kind"],
      ): HostCheckResult & LocalCheckOutcome => ({
        tree: null,
        ok: false,
        reason,
        failure: { kind },
        host: name,
      });
      const body = Effect.gen(function* () {
        if (wanted.refusal !== undefined) return failed(wanted.refusal, "unstartable");
        if (remoteHosts === undefined)
          return failed(`${name} isn't joined to this Gram`, "unstartable");
        const deadline = (yield* Clock.currentTimeMillis) + request.timeoutMs + MACHINE_SLACK_MS;
        /** Since when the machine has been away, while the check waits for it. */
        let away: number | undefined;
        let asked = false;
        for (;;) {
          const now = yield* Clock.currentTimeMillis;
          if (now >= deadline)
            return failed(
              `no word from ${name} on how its check ended, past its timeout; run local_check again`,
              "stopped",
            );
          if (away !== undefined && now - away >= reattachMs)
            return asked
              ? failed(
                  `the connection to ${name} dropped while its check ran and didn't come back in time, so how it ended is unknown; run local_check again`,
                  "stopped",
                )
              : failed(
                  `${name} is offline, so its check couldn't run; run local_check again once it is back`,
                  "unstartable",
                );
          const connection = yield* remoteHosts.connection(site.hostId).pipe(Effect.option);
          if (Option.isNone(connection)) {
            away ??= now;
            yield* Effect.sleep(Math.min(MACHINE_POLL_MS, reattachMs));
            continue;
          }
          const checks = connection.value.checks;
          if (checks === undefined)
            return failed(
              `${name}'s gram-host is older than this Gram and runs no local checks; run the install command there again to update it`,
              "unstartable",
            );
          asked = true;
          // A host that stays connected but never answers holds the slot no longer than this.
          const answer = yield* checks.run(request).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(Math.max(0, deadline - now)),
              orElse: () =>
                Effect.succeed(
                  failed(
                    `no word from ${name} on how its check ended, past its timeout; run local_check again`,
                    "stopped",
                  ),
                ),
            }),
            Effect.exit,
          );
          if (Exit.isSuccess(answer)) {
            const result = answer.value;
            // Only a pass that names what it checked counts as one.
            return result.ok &&
              (result.tree === null ||
                !SHA.test(result.tree) ||
                result.mergedCommit === undefined ||
                !SHA.test(result.mergedCommit))
              ? failed(`${name}'s pass named no merged tree and commit`, "unstartable")
              : result;
          }
          const error = Cause.findErrorOption(answer.cause);
          if (Option.isSome(error) && error.value._tag === "HostFailed")
            return failed(`${name} couldn't run it: ${error.value.message}`, "unstartable");
          if (Option.isNone(error)) return yield* Effect.failCause(answer.cause);
          // The connection went before the host answered: wait for it, then ask again.
          away = yield* Clock.currentTimeMillis;
          yield* Effect.logInfo(
            "local check: a joined machine's connection dropped mid-check",
          ).pipe(Effect.annotateLogs({ hostId: site.hostId, head: started.head }));
          yield* Effect.sleep(Math.min(MACHINE_POLL_MS, reattachMs));
        }
      });
      return machineAdmission(site.hostId)
        .inTurn(
          key,
          Effect.suspend(() => {
            remember(key, started);
            return body;
          }),
        )
        .pipe(
          Effect.catchDefect((defect) =>
            Effect.succeed(failed(`Gram's check failed to run: ${String(defect)}`, "unstartable")),
          ),
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (started.log !== undefined) {
                const text = result.log ?? result.reason ?? "";
                yield* Effect.sync(() => {
                  try {
                    writeFileSync(started.log!, text.endsWith("\n") ? text : `${text}\n`, {
                      mode: 0o600,
                    });
                  } catch {
                    // The record keeps how it ended regardless.
                  }
                });
              }
              yield* finish(key, machineEnded(started, result, yield* Clock.currentTimeMillis));
            }),
          ),
        );
    };

    /** `ensure` for a thread on a joined machine: the same reuse, the run on that machine. */
    const machineEnsure = (
      site: MachineCheckSite,
      head: string,
      base: string,
      wanted: LocalCheckRun,
      options: {
        readonly since: number;
        readonly after?: number | undefined;
        readonly onDone: (check: LocalCheck) => Effect.Effect<void>;
      },
    ) =>
      Effect.gen(function* () {
        const key = keyOf(head, base, null, { ...wanted, machine: site.hostId });
        const known = records.get(key);
        if (
          known?.status === "passed" &&
          (options.after === undefined || known.startedAt > options.after)
        )
          return known;
        if (known?.status === "running") {
          waiters.set(key, [...(waiters.get(key) ?? []), options.onDone]);
          return known;
        }
        if (known?.status === "failed" && (known.finishedAt ?? 0) >= options.since) return known;
        const logs = nodePath.join(dataDir, "local-checks");
        yield* Effect.sync(() => mkdirSync(logs, { recursive: true }));
        const started: LocalCheck = {
          head,
          base,
          tree: "",
          status: "running",
          ...wanted,
          machine: site.hostId,
          startedAt: yield* Clock.currentTimeMillis,
          host: machineName(site.hostId),
          log: nodePath.join(
            logs,
            `${head.slice(0, 12)}-${base.slice(0, 12)}-${createHash("sha256").update(site.hostId).digest("hex").slice(0, 12)}-${runIdOf(wanted)}.log`,
          ),
        };
        yield* save(key, started);
        waiters.set(key, [options.onDone]);
        yield* FiberMap.run(fibers, ++runs, machineCheck(site, key, started, wanted));
        return started;
      });

    const ensure: LocalChecksShape["ensure"] = (
      repoDir,
      head,
      base,
      { since, onDone, projectId, after },
    ) =>
      Effect.gen(function* () {
        if (!SHA.test(head) || !SHA.test(base)) return undefined;
        const { config: wanted } = yield* configuration(repoDir, projectId);
        if (wanted === undefined) return undefined;
        if (typeof repoDir !== "string")
          return yield* machineEnsure(repoDir, head, base, wanted, { since, onDone, after });
        const own = yield* ownRepoOf(repoDir, wanted);
        const tree = yield* treeOf(own, repoDir, head, base, true, wanted);
        const startedAt = yield* Clock.currentTimeMillis;
        if (tree === undefined) {
          if (wanted.preparation === undefined) return undefined;
          const key = keyOf(head, base, null, wanted);
          const failed: LocalCheck = {
            head,
            base,
            tree: "",
            status: "failed",
            ...wanted,
            startedAt,
            finishedAt: startedAt,
            host: hostname(),
            reason: "selected-source metadata preparation refused",
            failure: { kind: "unstartable" },
          };
          yield* save(key, failed);
          yield* onDone(failed).pipe(Effect.ignore);
          return failed;
        }
        if (tree === null) {
          // Conflicts: nothing to check until the branch is brought up to date.
          const key = keyOf(head, base, null, wanted);
          const known = records.get(key);
          if (known !== undefined) return known;
          const failed: LocalCheck = {
            head,
            base,
            tree: "",
            status: "failed",
            ...wanted,
            startedAt,
            finishedAt: startedAt,
            host: hostname(),
            reason: "the branch conflicts with its base; merge or rebase it first",
            failure: { kind: "conflict" },
          };
          yield* save(key, failed);
          yield* onDone(failed).pipe(Effect.ignore);
          return failed;
        }
        const key = keyOf(head, base, tree, wanted);
        const known = records.get(key);
        if (known?.status === "passed" && (after === undefined || known.startedAt > after))
          return known;
        if (known?.status === "running") {
          waiters.set(key, [...(waiters.get(key) ?? []), onDone]);
          return known;
        }
        if (known?.status === "failed" && (known.finishedAt ?? 0) >= since) return known;
        const logs = nodePath.join(dataDir, "local-checks");
        yield* Effect.sync(() => mkdirSync(logs, { recursive: true }));
        const started: LocalCheck = {
          head,
          base,
          tree,
          status: "running",
          ...wanted,
          startedAt,
          host: hostname(),
          log: nodePath.join(
            logs,
            `${head.slice(0, 12)}-${base.slice(0, 12)}-${tree.slice(0, 12)}-${runIdOf(wanted)}.log`,
          ),
          job: { own, repoDir },
        };
        yield* save(key, started);
        waiters.set(key, [onDone]);
        // Each run under its own id: the last one may still be telling its listeners.
        yield* FiberMap.run(fibers, ++runs, check(own, key, started, wanted));
        return started;
      });

    // Running checks a previous run of Gram left. One still running, verifiably the process it
    // recorded, is followed to its end; one that ended while Gram was closed keeps the status its
    // wrapper wrote; one whose process is gone without a word was cut off, and runs again once,
    // from the start, saying so. Each reads as running meanwhile, so asking for it waits for it.
    /** Ends a check a previous run left, as `outcome` says, its worktree removed unless kept. */
    const endLeft = (key: string, running: LocalCheck, outcome: LocalCheckOutcome, keep = false) =>
      Effect.gen(function* () {
        const work = running.job?.work;
        if (work !== undefined) {
          if (keep) markRetained(work);
          else yield* removeWork(running.job!.own, work);
        }
        yield* finish(key, endedAs(running, outcome, yield* Clock.currentTimeMillis));
      });
    const timedOutLeft = (running: LocalCheck) =>
      timedOut(running.log ?? "", running.timeoutMs ?? DEFAULT_LOCAL_CHECK_TIMEOUT_MS);
    /**
     * Follows a check Gram left running to its end: the status its wrapper writes, then what it
     * left in its group stopped, as a live check's are; or its deadline, then the group stopped.
     * `seen`: its leader was verified, so the group is the check's even once the leader is gone.
     */
    const follow = (key: string, running: LocalCheck, job: RecordedJob, seen: boolean) =>
      Effect.gen(function* () {
        let verified = seen;
        for (;;) {
          let state = yield* Effect.sync(() => recordedGroup(job, false));
          // Without its leader, a group verified by nothing yet: by a process in the worktree,
          // or by being gone a moment later, as a watchdog that outlived its wrapper soon is.
          if (!verified)
            for (let n = 0; state === "leaderless" && n < LEADERLESS_WAITS; n++) {
              state = yield* Effect.sync(() => recordedGroup(job, true));
              if (state === "leaderless") yield* Effect.sleep("1 second");
            }
          if (state === "ours") verified = true;
          const code = readExitStatus(job.status);
          const ours = state === "ours" || (state === "leaderless" && verified);
          if (!ours)
            return yield* endLeft(
              key,
              running,
              code !== undefined
                ? recordedOutcome(code, running.log ?? "", job.pathValue ?? "")
                : Date.now() >= (job.deadline ?? Infinity)
                  ? timedOutLeft(running)
                  : lost("its processes ended without saying how, while Gram was closed"),
              // A group no one can vouch for may still be in the worktree.
              state !== "gone",
            );
          const exited = code !== undefined;
          if (exited || Date.now() >= (job.deadline ?? Infinity)) {
            const gone = yield* Effect.promise(() => stopVerifiedGroup(job.pid));
            return yield* endLeft(
              key,
              running,
              exited
                ? recordedOutcome(code, running.log ?? "", job.pathValue ?? "")
                : timedOutLeft(running),
              !gone,
            );
          }
          yield* Effect.sleep("1 second");
        }
      });
    /** Runs a check a quit cut off again, unless the project's check changed since. */
    const restart = (key: string, running: LocalCheck, job: CheckJobRecord) =>
      Effect.gen(function* () {
        if (job.work !== undefined) yield* removeWork(job.own, job.work);
        const { config: wanted } = yield* configuration(
          job.repoDir,
          running.projectId as ProjectId | undefined,
        );
        if (wanted === undefined || keyOf(running.head, running.base, running.tree, wanted) !== key)
          return yield* endLeft(
            key,
            running,
            lost(
              "Gram quit while it ran, and the project's check changed since, so it wasn't run again",
            ),
          );
        yield* check(job.own, key, running, wanted);
      });
    const restartedAt = yield* Clock.currentTimeMillis;
    for (const { key, check: running } of left) {
      const job = running.job;
      const recorded: RecordedJob | undefined =
        job?.pid !== undefined &&
        job.processStart !== undefined &&
        job.work !== undefined &&
        job.status !== undefined
          ? {
              ...job,
              pid: job.pid,
              processStart: job.processStart,
              work: job.work,
              status: job.status,
            }
          : undefined;
      const state = recorded === undefined ? "gone" : recordedGroup(recorded);
      const ending = (outcome: LocalCheckOutcome, keep = false) => {
        remember(key, running);
        return FiberMap.run(fibers, ++runs, endLeft(key, running, outcome, keep));
      };
      if (
        recorded !== undefined &&
        (state === "ours" ||
          state === "leaderless" ||
          readExitStatus(recorded.status) !== undefined)
      ) {
        const kept: LocalCheck = { ...running, afterQuit: "kept", reason: KEPT_AFTER_QUIT };
        remember(key, kept);
        // Already running: it takes a slot at once, whatever the cap, and frees it as it ends.
        const held = yield* admission.takeSlot(follow(key, kept, recorded, state === "ours"));
        yield* FiberMap.run(fibers, ++runs, held);
        continue;
      }
      // Its start time matches but its folder can't be shown to: never a second run beside it.
      if (state === "unsure") {
        yield* ending(
          lost(
            "Gram couldn't verify that its process after a restart was the check's, so it left it alone",
          ),
          true,
        );
        continue;
      }
      // Its watchdog stopped it at its deadline, before the wrapper could say so.
      if (job?.deadline !== undefined && restartedAt >= job.deadline) {
        yield* ending(timedOutLeft(running));
        continue;
      }
      if (job === undefined || running.afterQuit === "restarted") {
        yield* ending(
          lost(
            running.afterQuit === "restarted"
              ? "Gram quit while it ran, again after running it once more; run local_check to run it again"
              : "Gram quit while it ran",
          ),
        );
        continue;
      }
      const { reason: _, mergedCommit: __, job: ___, ...rest } = running;
      const again: LocalCheck = {
        ...rest,
        startedAt: restartedAt,
        afterQuit: "restarted",
        reason: RESTARTED_AFTER_QUIT,
        job: { own: job.own, repoDir: job.repoDir },
      };
      yield* save(key, again);
      yield* FiberMap.run(fibers, ++runs, restart(key, again, job));
    }

    // Retention: what checks leave grows with every head, base and run, so it is bounded by age and
    // bytes. Running checks and the passes a merge may still reuse stay; so do a pass's commits, by
    // a ref in Gram's repository, which a collection then keeps. Only what Gram made is touched: a
    // work folder by its name, place and worktree link into one of Gram's repositories.
    const sweeping = Semaphore.makeUnsafe(1);
    const sweep: LocalChecksShape["sweep"] = sweeping.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        let forgotten = 0;
        let logs = 0;
        let logBytes = 0;
        let work = 0;
        let collected = 0;
        let repos = 0;
        for (const [key, record] of records) {
          if (keptCheck(record, now)) continue;
          records.delete(key);
          yield* run(sql`DELETE FROM local_checks WHERE key = ${key}`);
          forgotten++;
        }
        latestByPair.clear();
        for (const [key, record] of records) remember(key, record);

        const named = new Set<string>();
        for (const record of records.values()) if (record.log !== undefined) named.add(record.log);
        const unlink = (path: string, size: number) =>
          Effect.sync(() => {
            try {
              unlinkSync(path);
              logs++;
              logBytes += size;
            } catch {
              // Gone already.
            }
          });
        for (const name of entries(checksDir)) {
          if (!name.endsWith(".log")) continue;
          const path = nodePath.join(checksDir, name);
          const stat = fileStat(path);
          if (stat !== undefined && !named.has(path) && stat.mtimeMs < now - ABANDONED_MS)
            yield* unlink(path, stat.size);
        }
        const sized = [...records].flatMap(([key, record]) => {
          const size = record.log === undefined ? undefined : fileStat(record.log)?.size;
          return size === undefined ? [] : [{ key, check: record, size }];
        });
        for (const key of logsOverBudget(sized)) {
          const listed = sized.find((each) => each.key === key)!;
          const record = records.get(key);
          // Asked for again since the listing: its log is a running check's now.
          if (record?.status !== listed.check.status || record.log !== listed.check.log) continue;
          yield* unlink(record.log!, listed.size);
          const { log: _, ...rest } = record;
          yield* save(key, rest);
        }

        const running = [...records.values()].filter((record) => record.status === "running");
        const workDir = nodePath.join(checksDir, "work");
        const reposDir = nodePath.join(checksDir, "repos");
        const busy = new Set(
          running.flatMap((record) =>
            record.job?.work === undefined ? [] : [nodePath.dirname(record.job.work)],
          ),
        );
        for (const name of entries(workDir)) {
          const folder = nodePath.join(workDir, name);
          if (!/^[0-9a-f]{1,12}-[A-Za-z0-9]{6}$/.test(name) || busy.has(folder)) continue;
          let stat;
          try {
            stat = lstatSync(folder);
          } catch {
            continue;
          }
          if (
            !stat.isDirectory() ||
            stat.mtimeMs >= now - ABANDONED_MS ||
            existsSync(nodePath.join(folder, RETAINED))
          )
            continue;
          const src = nodePath.join(folder, "src");
          const link = fileStat(nodePath.join(src, ".git"));
          if (link === undefined) {
            // Made, but never checked out: nothing of a worktree in it.
            if (entries(src).length === 0) {
              yield* Effect.sync(() => rmSync(folder, { recursive: true, force: true }));
              work++;
            }
            continue;
          }
          const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(nodePath.join(src, ".git"), "utf8"));
          const own =
            gitdir?.[1] === undefined ? undefined : nodePath.dirname(nodePath.dirname(gitdir[1]));
          if (
            own === undefined ||
            canonicalizeOrOwned(nodePath.dirname(own)) !== canonicalizeOrOwned(reposDir) ||
            !/^[0-9a-f]{16}\.git$/.test(nodePath.basename(own))
          )
            continue;
          yield* removeWork(own, src);
          work++;
        }

        const kept = [...records.values()].flatMap((record) =>
          record.mergedCommit !== undefined && SHA.test(record.mergedCommit)
            ? [record.mergedCommit]
            : [],
        );
        for (const name of entries(reposDir)) {
          const own = nodePath.join(reposDir, name);
          if (!/^[0-9a-f]{16}\.git$/.test(name) || !existsSync(nodePath.join(own, "HEAD")))
            continue;
          // A check under way fetches and checks out here; the next sweep comes back.
          if (running.some((record) => record.job?.own === own)) continue;
          yield* g(own, ["worktree", "prune"]);
          const found = yield* g(own, ["cat-file", "--batch-check"], undefined, {
            stdin: kept.map((sha) => `${sha}\n`).join(""),
          });
          const present = new Set(
            (found?.stdout ?? "")
              .split("\n")
              .map((line) => line.split(" "))
              .filter(([sha, type]) => type === "commit" && SHA.test(sha ?? ""))
              .map(([sha]) => sha!),
          );
          const refs = yield* g(own, ["for-each-ref", "--format=%(refname)", "refs/gram/keep/"]);
          const existing = new Set(
            (refs?.status === 0 ? refs.stdout : "").split("\n").filter((ref) => ref !== ""),
          );
          const updates = [
            ...[...present]
              .filter((sha) => !existing.has(`refs/gram/keep/${sha}`))
              .map((sha) => `update refs/gram/keep/${sha} ${sha}\n`),
            ...[...existing]
              .filter((ref) => !present.has(ref.slice("refs/gram/keep/".length)))
              .map((ref) => `delete ${ref}\n`),
          ];
          if (updates.length > 0)
            yield* g(own, ["update-ref", "--stdin"], undefined, { stdin: updates.join("") });
          const used = Math.max(
            ...["HEAD", "FETCH_HEAD", COLLECTED].map(
              (file) => fileStat(nodePath.join(own, file))?.mtimeMs ?? 0,
            ),
          );
          if (present.size === 0 && used < now - PASS_KEEP_MS) {
            // Unused for as long as a pass is kept, and keeping none: the next check fetches anew.
            // Its own entry (`bare`) aside, git must list no worktree; an unreadable list keeps it.
            const listed = yield* g(own, ["worktree", "list", "--porcelain"]);
            const folders = (listed?.stdout ?? "")
              .split("\n\n")
              .filter((entry) => entry.startsWith("worktree ") && !/^bare$/m.test(entry));
            if (listed?.status === 0 && folders.length === 0) {
              yield* Effect.sync(() => rmSync(own, { recursive: true, force: true }));
              repos++;
            }
            continue;
          }
          if ((fileStat(nodePath.join(own, COLLECTED))?.mtimeMs ?? 0) >= now - GC_EVERY_MS)
            continue;
          const gc = yield* g(own, ["gc", "--quiet", `--prune=${GC_PRUNE}`], undefined, {
            tier: "slow",
          });
          if (gc?.status !== 0) continue;
          yield* Effect.sync(() => {
            const marker = nodePath.join(own, COLLECTED);
            writeFileSync(marker, "");
            utimesSync(marker, new Date(now), new Date(now));
          });
          collected++;
        }
        // A merged tree remembered for a pair whose commits a collection may have pruned is worked
        // out again, with a fetch where `ensure` asks for one.
        trees.clear();
        return { records: forgotten, logs, logBytes, work, collected, repos };
      }),
    );
    yield* Effect.sleep(SWEEP_FIRST).pipe(
      Effect.andThen(
        sweep.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("local check retention failed").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            ),
          ),
          Effect.andThen(Effect.sleep(SWEEP_EVERY)),
          Effect.forever,
        ),
      ),
      Effect.forkScoped,
    );

    const latest: LocalChecksShape["latest"] = (_repoDir, head, base, project) => {
      const wanted = localCheckRunFor(
        project?.localCheck,
        project?.id,
        project?.localCheckUnavailable,
        project?.localCheckRevision,
      );
      return wanted === undefined
        ? undefined
        : latestByPair.get(`${head}:${base}:${runIdOf(wanted)}`);
    };

    return { lookup, ensure, latest, configuration, sweep };
  }),
);
