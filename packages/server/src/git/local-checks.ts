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
  localCheckConcurrencyOf,
  redactText,
  DEFAULT_LOCAL_CHECK_TIMEOUT_MS,
  type Project,
  type ProjectLocalCheck,
  type ProjectId,
} from "@gram/contracts";
import { canonicalizeOrOwned, git, isInside, PathProbe, Proc, realPathSync } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, hostname } from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { ServerConfig } from "../config.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient, type SqlError } from "../platform/unstable.ts";
import { dropOldest } from "../bounded.ts";
import { DAY_MS } from "../zone-time.ts";
import { makeAdmission } from "./keyed-lock.ts";

/** All configuration affecting reuse; a record without a project never authorizes a project's gate. */
export interface LocalCheckRun {
  /** How the source was isolated from the agent's repository (`LOCAL_CHECK_ISOLATION`). */
  readonly isolation: string;
  readonly command: string;
  readonly preparation?: NonNullable<ProjectLocalCheck["preparation"]>;
  readonly projectId?: string;
  readonly setup?: string;
  readonly timeoutMs?: number;
  /** Only `unavailable/v1`, for a stored recipe that can't be read; it never runs. */
  readonly profile?: string;
  readonly qualification?: string;
  readonly refusal?: string;
}

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
          : [run.preparation.manifest, run.preparation.sha256, ...(run.preparation.inputConfigSha256 === undefined ? [] : [run.preparation.inputConfigSha256])]),
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
  const seen = new Set<string>();
  const visit = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (!prefix && name === ".git") continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = nodePath.join(dir, name);
      const metadata = lstatSync(path);
      if (metadata.isDirectory()) {
        if (![...expected.keys()].some((candidate) => candidate.startsWith(relative + "/")))
          throw new Error("unexpected selected worktree directory");
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
        if (!before.isFile() || mode !== row.mode || before.dev !== metadata.dev || before.ino !== metadata.ino)
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
        if (bytes !== before.size || hash.digest("hex") !== row.oid ||
            before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
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
  tree: string,
): Array<SelectedSource> {
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
      v.tree !== tree ||
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
      tree,
      entries: rows.map((row) => ({
        path: row.path,
        mode: row.mode,
        oid: row.oid,
        selected: row.selected,
      })),
    });
    if (raw.toString("utf8") !== canonical)
      throw new Error("noncanonical selected-source manifest");
    return rows;
  } finally {
    closeSync(fd);
  }
}

/** How long a stopped check's processes get to end on SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 10_000;

const SHA = /^[a-f0-9]{40}$/;

/** Why a check didn't pass, as the worker and the ledger are told it. */
const LocalCheckFailure = Schema.Struct({
  kind: Schema.Literals([
    /** A command the check runs wasn't on its PATH. */
    "not-found",
    /** It ran past the configured timeout and was stopped. */
    "timed-out",
    /** It ran and exited non-zero: a failing check. */
    "exited",
    /** A signal stopped it. */
    "stopped",
    /** Gram couldn't start it, or prepare the source for it. */
    "unstartable",
    /** The head conflicts with its base: nothing to check. */
    "conflict",
  ]),
  /** The command that wasn't found. */
  command: Schema.optionalKey(Schema.String),
  /** The PATH the check ran on. */
  path: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  /** The output's last lines. */
  tail: Schema.optionalKey(Schema.String),
});
type LocalCheckFailure = typeof LocalCheckFailure.Type;

export const LocalCheck = Schema.Struct({
  head: Schema.String,
  base: Schema.String,
  /** The tree of `head` merged onto `base`: what was checked. */
  tree: Schema.String,
  status: Schema.Literals(["running", "passed", "failed"]),
  command: Schema.String,
  preparation: Schema.optionalKey(
    Schema.Struct({ manifest: Schema.String, sha256: Schema.String, inputConfigSha256: Schema.optionalKey(Schema.String) }),
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

/** How a run ended: `reason` is its line, `failure` what a reader can act on. */
export interface LocalCheckOutcome {
  readonly ok: boolean;
  readonly reason?: string | undefined;
  readonly failure?: LocalCheckFailure | undefined;
}

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

/**
 * Git's variables that locate a repository, its objects, index or config, or inject config: one
 * inherited from Gram's own launch would point a git call made for the check (Gram's or the
 * check's own) at another repository, the agent's say, whatever folder it runs in. Only how git
 * reaches a remote and asks for credentials is kept.
 */
const isGitControl = (name: string): boolean =>
  name.toUpperCase().startsWith("GIT_") &&
  !["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_ASKPASS"].includes(name.toUpperCase());

/** Gram's own variables stay out of the check, whose tests set what they need themselves. */
const checkEnv = (
  base: Readonly<Record<string, string | undefined>>,
  pathValue: string,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (
      value === undefined ||
      name === "CI" ||
      isGitControl(name) ||
      (name.startsWith("GRAM_") && !name.startsWith("GRAM_CHECK_")) ||
      name.startsWith("SB_") ||
      name.startsWith("ELECTRON_")
    )
      continue;
    env[name] = value;
  }
  if (pathValue !== "") env["PATH"] = pathValue;
  return env;
};

export interface CheckEnvironment {
  /** The server's environment, filtered by `checkEnv`. */
  readonly base: Readonly<Record<string, string | undefined>>;
  /** The login-shell PATH; empty keeps `base`'s. */
  readonly pathValue: string;
  /** Grace for stopping remaining command processes; tests may shorten it. */
  readonly killGraceMs?: number | undefined;
  /** Keeps the check's source when its stopped processes couldn't be shown gone. */
  readonly retain?: (() => void) | undefined;
  /** Makes the check survive a quit, for Gram's own runs (`LocalChecksLive`). */
  readonly durable?: DurableCheck | undefined;
}

/** At most this much of the log's end is read to explain a failure. */
const TAIL_BYTES = 64 * 1024;

/** The end of `log`; empty when it can't be read. */
const readTail = (log: string): string => {
  try {
    const fd = openSync(log, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
};

/**
 * `text` as plain lines: terminal escape sequences (colours, titles) and other control characters
 * gone, and a carriage return's overwrite kept as its last state.
 */
const plainLines = (text: string): Array<string> =>
  text
    // oxlint-disable-next-line no-control-regex -- terminal escape sequences
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g, "")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r").filter((part) => part !== "");
      // oxlint-disable-next-line no-control-regex -- the control characters left
      return (parts.at(-1) ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trimEnd();
    });

/**
 * The last few non-blank lines of `text`, plain and bounded for a message, with anything shaped
 * like a secret redacted: the check runs with the server's environment, which a test may print.
 */
export const lastLines = (text: string, lines = 12, chars = 1500): string => {
  const kept = redactText(
    plainLines(text)
      .filter((line) => line.trim() !== "")
      .slice(-lines)
      .join("\n"),
  );
  return kept.length > chars ? `…${kept.slice(-chars)}` : kept;
};

/**
 * The command a shell or `env` said it couldn't find, the last one named in `output`: bash's
 * `sh: line 1: foo: command not found`, dash's `sh: 1: foo: not found`, zsh's and Bun's
 * `command not found: foo` and `env: foo: No such file or directory`. Only a line a shell or `env`
 * starts counts, so a test's own `Error: command not found` blames nothing.
 */
export const missingCommand = (output: string): string | undefined => {
  const shell = String.raw`(?:\S*/)?(?:ba|z|da|k)?sh`;
  const name = String.raw`([^\s:'"‘’]+)`;
  const patterns = [
    // A script names itself by its path: `./scripts/x.sh: line 3: foo: command not found` in bash,
    // `./scripts/x.sh: 3: foo: not found` in dash (`/bin/sh` on Debian and Ubuntu).
    new RegExp(String.raw`^(?:${shell}|\S*/\S*): (?:line \d+: )?${name}: command not found$`),
    new RegExp(String.raw`^(?:${shell}|\S*/\S*): \d+: ${name}: not found$`),
    new RegExp(String.raw`^(?:${shell}|(?:\S*/)?bun): command not found: ${name}$`),
    new RegExp(String.raw`^(?:\S*/)?env: ['"‘]?${name}['"’]?: No such file or directory$`),
  ];
  let found: string | undefined;
  for (const line of plainLines(output)) {
    for (const pattern of patterns) {
      const match = pattern.exec(line.trim());
      if (match !== null) {
        found = match[1];
        break;
      }
    }
  }
  return found;
};

/** What an exit means, from its code, signal and output: the line a worker can act on. */
export const diagnoseExit = (
  code: number | null,
  signal: NodeJS.Signals | null,
  output: string,
  pathValue: string,
): LocalCheckOutcome => {
  if (code === 0) return { ok: true };
  const tail = lastLines(output);
  const withTail = (failure: LocalCheckFailure): LocalCheckFailure =>
    tail === "" ? failure : { ...failure, tail };
  if (signal !== null)
    return {
      ok: false,
      reason: `stopped by ${signal}`,
      failure: withTail({ kind: "stopped" }),
    };
  if (code === 127) {
    const command = missingCommand(output);
    return {
      ok: false,
      reason: `${command === undefined ? "a command" : `\`${command}\``} was not found on the check's PATH (exit 127); install it or add its folder to PATH in your shell profile, then restart Gram. PATH=${pathValue}`,
      failure: withTail({
        kind: "not-found",
        ...(command === undefined ? {} : { command }),
        path: pathValue,
        exitCode: 127,
      }),
    };
  }
  return {
    ok: false,
    reason: `exited ${code}`,
    failure: withTail({ kind: "exited", ...(code === null ? {} : { exitCode: code }) }),
  };
};

/**
 * What makes a check's command durable across a quit (`LocalChecksLive`): where its wrapper writes
 * how it ended, a record of its process made before Gram waits on it, and whether a stop is Gram
 * quitting, which leaves the recorded process running for the next start to take back.
 */
export interface DurableCheck {
  /** The file the wrapper writes the exit status to, outside the checked tree. */
  readonly status: string;
  /** Records the started process; false when it couldn't be, and a quit then stops it. */
  readonly started: (process: CheckProcess) => Effect.Effect<boolean>;
  /** Whether Gram is quitting, so a recorded process is left running. */
  readonly detach: () => boolean;
}

/** A check's running wrapper, as recorded to take it back after a restart. */
interface CheckProcess {
  readonly pid: number;
  /** `ps`'s start time of `pid`: with the PID and its folder, what proves it is still this one. */
  readonly processStart: string;
  /** Epoch ms when Gram stops it. */
  readonly deadline: number;
  /** The PATH it runs on, for explaining a missing command after a restart. */
  readonly pathValue: string;
}

/**
 * The setup and the command, each in its own shell, in one wrapper that leads the check's process
 * group and writes the exit status (`$1`) once they end: a check Gram left running when it quit
 * still says how it ended to the next start. A watchdog in the group stops it, SIGTERM then
 * SIGKILL after `$5` seconds, once `$4` seconds pass with the wrapper still there: the timeout Gram
 * isn't running to enforce. It ignores SIGTERM only once it sent its own, so Gram's stops it at once.
 */
const WRAPPER = `status=$1 setup=$2 command=$3 limit=$4 grace=$5
(
  n=0
  while [ "$n" -lt "$limit" ]; do
    sleep 1
    kill -0 $$ 2>/dev/null || exit 0
    n=$((n + 1))
  done
  trap '' TERM
  kill -TERM 0
  sleep "$grace"
  kill -KILL 0
) &
code=0
if [ -n "$setup" ]; then /bin/sh -c "$setup"; code=$?; fi
if [ "$code" -eq 0 ]; then /bin/sh -c "$command"; code=$?; fi
if [ -n "$status" ]; then printf '%s\\n' "$code" > "$status.tmp" && mv -f "$status.tmp" "$status"; fi
exit "$code"`;

/** How long past its timeout the watchdog waits for Gram to stop a check, before doing it. */
const WATCHDOG_SLACK_S = 30;

/** Configured setup then check on the resolved login-shell PATH, with shared diagnostics. */
export const spawnCheck = (
  dir: string,
  log: string,
  environment: CheckEnvironment,
  run: LocalCheckRun,
) =>
  Effect.gen(function* () {
    const env = checkEnv(environment.base, environment.pathValue);
    // Only the approved recipe can supply this binding; never inherit a caller's claim.
    delete env["GRAM_CHECK_SOURCE_SELECTION_MANIFEST"];
    delete env["GRAM_CHECK_SOURCE_SELECTION_SHA256"];
    delete env["GRAM_CHECK_APPROVED_INPUT_SHA256"];
    if (run.preparation !== undefined) {
      env["GRAM_CHECK_SOURCE_SELECTION_MANIFEST"] = run.preparation.manifest;
      env["GRAM_CHECK_SOURCE_SELECTION_SHA256"] = run.preparation.sha256;
      if (run.preparation.inputConfigSha256 !== undefined) {
        env["GRAM_CHECK_APPROVED_INPUT_SHA256"] = run.preparation.inputConfigSha256;
      }
    }
    const timeoutMs = run.timeoutMs ?? DEFAULT_LOCAL_CHECK_TIMEOUT_MS;
    const graceMs = environment.killGraceMs ?? KILL_GRACE_MS;
    return yield* spawnCommand(
      dir,
      log,
      env,
      run.setup ?? "",
      run.command,
      timeoutMs,
      graceMs,
      environment.retain,
      environment.durable,
    );
  });

/** `90 minutes`, `1 minute`, `500 ms`. */
const spell = (ms: number) =>
  ms >= 60_000 && ms % 60_000 === 0
    ? `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`
    : `${ms} ms`;

const timedOut = (log: string, timeoutMs: number): LocalCheckOutcome => {
  const tail = lastLines(readTail(log));
  return {
    ok: false,
    reason: `timed out: still running after ${spell(timeoutMs)}, so Gram stopped it`,
    failure: { kind: "timed-out", ...(tail === "" ? {} : { tail }) },
  };
};

/**
 * How long a group sent SIGKILL gets to be gone, its leader reaped, before Gram stops waiting and
 * keeps the check's source (`CheckEnvironment.retain`): a process stuck in the kernel outlives it.
 */
const REAP_MS = 5_000;

/** Sends `signal` to the process group `pgid`; false when there is none. */
const signalGroup = (pgid: number, signal: NodeJS.Signals | 0) => {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stops a check's process group: SIGTERM, SIGKILL for whatever is still there after `graceMs`,
 * then a wait of up to `REAP_MS` for it to be gone. True once `present` says it is gone; false when
 * it couldn't be shown gone, or `present` stopped vouching that the group is the check's.
 */
const stopGroup = (
  pgid: number,
  present: () => "ours" | "gone" | "unsure",
  graceMs: number,
): Promise<boolean> =>
  new Promise<boolean>((done) => {
    const first = present();
    if (first !== "ours") return done(first === "gone");
    signalGroup(pgid, "SIGTERM");
    const stoppedAt = Date.now();
    let killed = false;
    const poll = setInterval(() => {
      const now = present();
      if (now !== "ours") {
        clearInterval(poll);
        return done(now === "gone");
      }
      const waited = Date.now() - stoppedAt;
      if (!killed && waited >= graceMs) {
        killed = true;
        signalGroup(pgid, "SIGKILL");
      }
      if (waited >= graceMs + REAP_MS) {
        clearInterval(poll);
        done(false);
      }
    }, 50);
  });

/**
 * The wrapper in its own process group. However it ends (exit, timeout, interruption), what is
 * left of the group, such as a watcher it started in the background, is stopped before the result
 * is told, the interruption ends and the worktree is removed (`stopGroup`). A group that can't be
 * shown gone keeps the source (`retain`). Only this group is signalled, by the id it was spawned
 * with; a process that left it (`setsid`) is beyond what Gram can follow. Interrupted while Gram
 * quits, a durable check that was recorded is left running instead (`DurableCheck`).
 */
const spawnCommand = (
  dir: string,
  log: string,
  env: Record<string, string>,
  setup: string,
  command: string,
  timeoutMs: number,
  graceMs: number,
  retain?: () => void,
  durable?: DurableCheck,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const pathValue = env["PATH"] ?? "";
      const deadline = Date.now() + timeoutMs;
      const running = yield* Effect.sync(() => {
        const fd = openSync(log, "w");
        const child = (() => {
          try {
            return spawn(
              "/bin/sh",
              [
                "-c",
                WRAPPER,
                "gram-check",
                durable?.status ?? "",
                setup,
                command,
                String(Math.ceil(timeoutMs / 1000) + WATCHDOG_SLACK_S),
                String(Math.ceil(graceMs / 1000)),
              ],
              { cwd: dir, env, detached: true, stdio: ["ignore", fd, fd] },
            );
          } finally {
            closeSync(fd);
          }
        })();
        /** Node reaped the leader: until then its zombie keeps the group's id taken. */
        let reaped = child.pid === undefined;
        const present = () =>
          !reaped || (child.pid !== undefined && signalGroup(child.pid, 0)) ? "ours" : "gone";
        let stopping: Promise<void> | undefined;
        /** Stops what is left of the group and waits for it to be gone, once however often asked. */
        const stop = () =>
          (stopping ??=
            child.pid === undefined
              ? Promise.resolve()
              : stopGroup(child.pid, present, graceMs).then((gone) => {
                  if (!gone) retain?.();
                }));
        let settled = false;
        let release: (() => void) | undefined;
        const outcome = new Promise<LocalCheckOutcome>((resolve) => {
          /** Stops what is left of the group, then tells `outcome`, once. */
          const settle = (told: () => LocalCheckOutcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void stop().then(() => resolve(told()));
          };
          const timer = setTimeout(() => settle(() => timedOut(log, timeoutMs)), timeoutMs);
          release = () => {
            settled = true;
            clearTimeout(timer);
          };
          child.once("error", (error) => {
            if (child.pid === undefined) reaped = true;
            settle(() => ({
              ok: false,
              reason: `couldn't start: ${error.message}`,
              failure: { kind: "unstartable", path: pathValue },
            }));
          });
          child.once("exit", (code, signal) => {
            reaped = true;
            // Read now: what the group's leftovers print while they are stopped is not the check's.
            const output = readTail(log);
            settle(() => diagnoseExit(code, signal, output, pathValue));
          });
        });
        return {
          pid: child.pid,
          outcome,
          stop: () => {
            release?.();
            return stop();
          },
          /** Lets it run on past Gram: nothing of it keeps this process alive. */
          leave: () => {
            release?.();
            child.unref();
          },
        };
      });
      let recorded = false;
      return yield* restore(
        Effect.gen(function* () {
          if (durable !== undefined && running.pid !== undefined) {
            const processStart = processStartOf(running.pid);
            if (processStart !== undefined)
              recorded = yield* durable.started({
                pid: running.pid,
                processStart,
                deadline,
                pathValue,
              });
          }
          return yield* Effect.promise(() => running.outcome);
        }),
      ).pipe(
        // Interrupted, the group is stopped the same way, and the interruption waits for it;
        // unless Gram is quitting and the next start can take it back.
        Effect.onInterrupt(() =>
          recorded && durable?.detach() === true
            ? Effect.sync(running.leave)
            : Effect.promise(running.stop),
        ),
      );
    }),
  );

/** `ps`, at its path: an app opened from the Dock has launchd's PATH, and a shell may alias it. */
const PS = ["/bin/ps", "/usr/bin/ps"].find((path) => existsSync(path)) ?? "ps";

/** When `pid` started, as `ps` says it, in a fixed locale; undefined when it isn't there. */
const processStartOf = (pid: number): string | undefined => {
  try {
    const out = execFileSync(PS, ["-o", "lstart=", "-p", String(pid)], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
};

/** The folder `pid` runs in; undefined when it can't be read. */
const processCwdOf = (pid: number): string | undefined => {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    const out = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split("\n").find((each) => each.startsWith("n"));
    return line === undefined ? undefined : line.slice(1);
  } catch {
    return undefined;
  }
};

/**
 * Whether a process of the group `pgid` runs inside the worktree `work`: what a check leaves
 * behind inherits its folder, and no other process has a reason to be in Gram's own worktree.
 */
const memberInWork = (pgid: number, work: string): boolean => {
  try {
    const members = execFileSync(PS, ["-A", "-o", "pid=,pgid="], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([pid, group]) => group === pgid && Number.isInteger(pid))
      .map(([pid]) => pid!);
    const root = canonicalizeOrOwned(work);
    return members.some((pid) => {
      const cwd = processCwdOf(pid);
      if (cwd === undefined) return false;
      return isInside(root, canonicalizeOrOwned(cwd));
    });
  } catch {
    return false;
  }
};

/**
 * Whether the check's process group is still the one recorded. `ours`: its leader is there with
 * the recorded start time and, when `checkCwd`, folder. `gone`: no such group, or the PID now
 * names a process that started later, which it couldn't while the check's group was there.
 * Without its leader, the group is `ours` when, `checkCwd`, one of its processes runs inside the
 * worktree, and otherwise `leaderless`: only a caller who verified it before may take it as the
 * check's. `unsure`: the start time
 * matches but the folder doesn't, or can't be read.
 */
const recordedGroup = (
  job: { readonly pid: number; readonly processStart: string; readonly work: string },
  checkCwd = true,
): "ours" | "gone" | "leaderless" | "unsure" => {
  if (!signalGroup(job.pid, 0)) return "gone";
  const leaderless = () => (checkCwd && memberInWork(job.pid, job.work) ? "ours" : "leaderless");
  try {
    process.kill(job.pid, 0);
  } catch {
    return leaderless();
  }
  const start = processStartOf(job.pid);
  if (start === undefined) return signalGroup(job.pid, 0) ? leaderless() : "gone";
  if (start !== job.processStart) return "gone";
  if (!checkCwd) return "ours";
  const cwd = processCwdOf(job.pid);
  return cwd !== undefined && canonicalizeOrOwned(cwd) === canonicalizeOrOwned(job.work)
    ? "ours"
    : "unsure";
};

/**
 * Stops the group `pgid` of a check Gram took back, which the caller has just verified as the
 * check's: while any of it is left, no other process can take its id. True once it is gone.
 */
const stopVerifiedGroup = (pgid: number, graceMs = KILL_GRACE_MS) =>
  stopGroup(pgid, () => (signalGroup(pgid, 0) ? "ours" : "gone"), graceMs);

/** How many seconds a group without its leader, unverified, gets to be gone before it is kept. */
const LEADERLESS_WAITS = 5;

/** In a work folder, marks a worktree kept because its processes weren't shown gone. */
const RETAINED = "retained";

/** Marks the work folder of the worktree `dir` as kept: nothing reclaims it. */
const markRetained = (dir: string) => {
  try {
    writeFileSync(nodePath.join(nodePath.dirname(dir), RETAINED), "");
  } catch {
    // The worktree is kept regardless; only retention reads this.
  }
};

/** The status the wrapper wrote, or undefined when it wrote none. */
export const readExitStatus = (path: string): number | undefined => {
  try {
    const text = readFileSync(path, "utf8").trim();
    return /^\d{1,3}$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
};

/** How a check ended that Gram took back, from what its wrapper wrote and its log's end. */
const recordedOutcome = (code: number, log: string, pathValue: string): LocalCheckOutcome =>
  diagnoseExit(code, null, readTail(log), pathValue);

export interface LocalChecksShape {
  readonly configuration: (
    repoDir: string,
    projectId?: ProjectId,
  ) => Effect.Effect<{
    readonly project: string;
    readonly config: LocalCheckRun | undefined;
    readonly reason: string;
  }>;

  /** The check of `head` merged onto `base`, in `repoDir`'s repository, if one ran or runs. */
  readonly lookup: (
    repoDir: string,
    head: string | undefined,
    base: string | undefined,
    projectId?: ProjectId,
  ) => Effect.Effect<LocalCheck | undefined>;
  /**
   * Starts that check unless it passed, is running, or failed at or after `since`; `onDone` hears
   * how it ended. Undefined when the pair can't be checked (unknown commits).
   */
  readonly ensure: (
    repoDir: string,
    head: string,
    base: string,
    options: {
      readonly projectId?: ProjectId;
      readonly since: number;
      readonly onDone: (check: LocalCheck) => Effect.Effect<void>;
    },
  ) => Effect.Effect<LocalCheck | undefined>;
  /**
   * The latest check of `head` on `base` with `repoDir`'s current command that Gram ran or runs,
   * from memory alone, for showing where it stands (the ledger). Never a merge's evidence: that is
   * `lookup`'s, which reads the merged tree.
   */
  readonly latest: (
    repoDir: string,
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
  run: Parameters<typeof runIdOf>[0],
) => `${head}:${base}:${tree ?? "conflict"}:${runIdOf(run)}`;

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

export const LocalChecksLive = Layer.effect(
  LocalChecks,
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const sql = yield* SqlClient.SqlClient;
    const proc = yield* Proc;
    const runner = yield* LocalCheckRunner;
    const { dataDir } = yield* ServerConfig;
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
    const admission = makeAdmission<string>(capacity, (waiting) =>
      waiting.forEach((key, ahead) => {
        const queued = records.get(key);
        if (queued?.status === "running")
          remember(key, { ...queued, reason: `queued for local check (${ahead} ahead)` });
      }),
    );
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
    const ownRepoOf = (repoDir: string) =>
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
          `${createHash("sha256").update(source).digest("hex").slice(0, 16)}.git`,
        );
        if (!existsSync(nodePath.join(own, "HEAD"))) {
          yield* Effect.sync(() => mkdirSync(own, { recursive: true }));
          yield* g(own, ["init", "--quiet", "--bare", "--template=", own]);
        }
        return own;
      });

    const hasCommit = (dir: string, sha: string) =>
      g(dir, ["cat-file", "-e", `${sha}^{commit}`]).pipe(Effect.map((out) => out?.status === 0));

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
    const treeOf = (own: string, repoDir: string, head: string, base: string, fetch: boolean) =>
      Effect.gen(function* () {
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
        // Without fetching: a pair Gram never fetched has no check of it.
        const own = yield* ownRepoOf(repoDir);
        const tree = yield* treeOf(own, repoDir, head, base, false);
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
            );
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
                    const index = yield* g(dir, ["read-tree", sha]);
                    const files = selection
                      .filter((row) => row.selected)
                      .map((row) => row.path + "\0")
                      .join("");
                    const checkout =
                      index?.status === 0
                        ? yield* g(
                            dir,
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
                            { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
                            { stdin: files },
                          )
                        : undefined;
                    if (checkout?.status !== 0)
                      return {
                        ok: false,
                        reason: "selected-source checkout failed",
                        failure: { kind: "unstartable" },
                      } satisfies LocalCheckOutcome;
                    try {
                      verifySelectedWorktree(dir, selection);
                    } catch {
                      return {
                        ok: false,
                        reason: "selected-source materialization differs",
                        failure: { kind: "unstartable" },
                      } satisfies LocalCheckOutcome;
                    }
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

    const ensure: LocalChecksShape["ensure"] = (
      repoDir,
      head,
      base,
      { since, onDone, projectId },
    ) =>
      Effect.gen(function* () {
        if (!SHA.test(head) || !SHA.test(base)) return undefined;
        const { config: wanted } = yield* configuration(repoDir, projectId);
        if (wanted === undefined) return undefined;
        const own = yield* ownRepoOf(repoDir);
        const tree = yield* treeOf(own, repoDir, head, base, true);
        if (tree === undefined) return undefined;
        const startedAt = yield* Clock.currentTimeMillis;
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
        if (known?.status === "passed") return known;
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
