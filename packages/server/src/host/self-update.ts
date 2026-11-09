/**
 * A joined machine's host updating itself to a release its main Gram names (`host.update.start`).
 *
 * It takes only a release of Gram's own: the address is this file's constant and the release's
 * number, never a URL from the wire. The download is checked against that release's
 * `SHA256SUMS.txt` before anything in it runs, unpacked into a staging folder beside the app it
 * runs now, and tested there (`gram-host --help`, as the installer does) before it is moved into
 * place. Then the host writes its plan, the service it runs now and the one it moves to, and starts
 * a supervisor outside its own service (a transient systemd unit, or a launchd job of its own),
 * which the restart doesn't take down. The supervisor moves the service to the new app and waits
 * for the new host to dial in: once its hello has passed, the main Gram asks it `host.update.check`,
 * which marks the plan confirmed, and the supervisor removes the old app. If that doesn't happen
 * within `CONFIRM_MS` the supervisor moves the service back and keeps why. The previous app stays
 * on disk until then, and a host that is busy (a turn, a terminal running a command, a clone)
 * doesn't start.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type {
  HostBusy,
  HostUpdateCheck,
  HostUpdateOutcome,
  HostUpdateProgress,
} from "@gram/contracts";
import { relativeInside } from "@gram/git";
import type { Admission } from "./admission.ts";
import { lockConflict, lockPort, takeUpdateLock, updateLockState } from "./update-lock.ts";
import { RELEASES } from "./install-script.ts";
import { LAUNCHD_LABEL, type ServiceCommand } from "./service.ts";

/** A release number as Gram tags them: `1.17.0`, or `1.17.0-beta.1`. */
export const RELEASE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,32})?$/;

/** How long the new host gets to dial in and be asked `host.update.check` before a rollback. */
export const CONFIRM_MS = 2 * 60_000;
/** The largest download taken: a release's app is a few hundred megabytes. */
const MAX_DOWNLOAD = 1024 * 1024 * 1024;
/** How long a download may go without a byte before it is given up. */
const STALL_MS = 60_000;
/** The file the plan and the last outcome are kept in, in the host's folder. */
export const UPDATE_FILE = "update.json";
/** The launchd job the supervisor runs as on a Mac. */
export const SUPERVISOR_LABEL = `${LAUNCHD_LABEL}.update`;

/** A release's parts, for ordering: its numbers, and its prerelease identifiers, if any. */
const parts = (release: string) => {
  const at = release.indexOf("-");
  const core = at === -1 ? release : release.slice(0, at);
  return {
    numbers: core.split(".").map(Number),
    pre: at === -1 ? undefined : release.slice(at + 1).split("."),
  };
};

const NUMERIC = /^\d+$/;

/**
 * Negative when `a` is an earlier release than `b`, positive when later, 0 when the same, as
 * semver orders them: a prerelease before its release, and its identifiers one by one, numeric
 * ones by value and before any that aren't (`rc.2` before `rc.10`).
 */
export const compareReleases = (a: string, b: string): number => {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === undefined || y.pre === undefined)
    return x.pre === y.pre ? 0 : x.pre === undefined ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = NUMERIC.test(p);
    const qn = NUMERIC.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
};

/** The release's download for this platform, or undefined where Gram makes none. */
export const releaseAsset = (
  release: string,
  platform: NodeJS.Platform,
  arch: string,
): string | undefined =>
  platform === "darwin" && arch === "arm64"
    ? `gram_${release}_darwin-arm64_signed.zip`
    : platform === "linux" && arch === "x64"
      ? `gram_${release}_x86_64.AppImage`
      : undefined;

/** Where an app unpacked in `dir` keeps its binary and the host's entry. */
export const appLayout = (platform: NodeJS.Platform, dir: string) => {
  const resources =
    platform === "darwin" ? join(dir, "Gram.app", "Contents", "Resources") : join(dir, "resources");
  return {
    bin:
      platform === "darwin"
        ? join(dir, "Gram.app", "Contents", "MacOS", "Gram")
        : join(dir, "gram"),
    entry: join(resources, "app.asar", "out", "server", "gram-host.js"),
  };
};

/**
 * The folder the host keeps downloaded apps in, as the installer does: `apps` in the host's folder
 * on a Mac, the XDG data folder's `gram-host/apps` on Linux.
 */
export const appsFolder = (
  hostHome: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string => {
  if (platform === "darwin") return join(hostHome, "apps");
  const xdg = env["XDG_DATA_HOME"];
  return join(
    xdg?.startsWith("/") === true ? xdg : join(home, ".local", "share"),
    "gram-host",
    "apps",
  );
};

/** What the host keeps across the restart, owner-only in its folder. */
export interface UpdatePlan {
  readonly version: 1;
  /** This update's own id: its supervisor, confirmation and outcome act on this plan only. */
  readonly id: string;
  readonly release: string;
  /** The release it ran when it started; what a rollback goes back to. */
  readonly from?: string;
  readonly previous: ServiceCommand;
  readonly next: ServiceCommand;
  /**
   * `switching` until the new host is asked `host.update.check`, then `confirmed`; or
   * `rollingBack` once its supervisor gave up on it, which no late confirmation undoes; then
   * `done`. Each move between them is made under the plan lock (`update-lock.ts`).
   */
  readonly phase: "switching" | "confirmed" | "rollingBack" | "done";
  readonly startedAt: number;
  /** Once it is done: how it went. */
  readonly outcome?: HostUpdateOutcome;
}

/** An update's id, as its supervisor is started with it. */
export const PLAN_ID = /^[a-f0-9]{16}$/;

/**
 * How long an unfinished plan may go without a live supervisor before the host, starting again,
 * recovers it (a reboot or a crash took the supervisor): past the wait for confirmation, with room
 * for the supervisor to start.
 */
export const STALE_MS = CONFIRM_MS + 60_000;

const readPlan = (home: string): UpdatePlan | undefined => {
  let fd: number;
  try {
    fd = openSync(join(home, UPDATE_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 || stat.uid !== process.getuid?.())
      return undefined;
    const value = JSON.parse(readFileSync(fd, "utf8")) as Partial<UpdatePlan> | null;
    return value !== null &&
      value.version === 1 &&
      typeof value.id === "string" &&
      PLAN_ID.test(value.id) &&
      typeof value.release === "string" &&
      RELEASE.test(value.release) &&
      (value.phase === "switching" ||
        value.phase === "confirmed" ||
        value.phase === "rollingBack" ||
        value.phase === "done")
      ? (value as UpdatePlan)
      : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
};

const writePlan = (home: string, plan: UpdatePlan) => {
  const path = join(home, UPDATE_FILE);
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(plan, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
};

/**
 * Whether a supervisor holds the update's lock now. A port another program holds counts as held
 * too: no supervisor could take it, so no update should start.
 */
export const supervisorRunning = async (home: string): Promise<boolean> =>
  (await updateLockState(home, "supervisor")) !== "free";

/**
 * Runs `move` with the plan lock held: the one place the plan's phase changes, so a confirmation
 * and a rollback can't cross. Waits a few seconds for it; a lock held longer than that counts as a
 * failure to move.
 */
/** Whether the plan lock can be taken now: taken and let go at once. */
const planLockUsable = async (home: string): Promise<boolean> => {
  for (let tries = 0; tries < 50; tries += 1) {
    const lock = await takeUpdateLock(home, "plan");
    if (lock !== undefined) {
      await lock.release();
      return true;
    }
    if ((await updateLockState(home, "plan")) === "foreign") return false;
    await wait(20);
  }
  return false;
};

const withPlanLock = async <A>(home: string, move: () => A): Promise<A> => {
  for (let tries = 0; tries < 250; tries += 1) {
    const lock = await takeUpdateLock(home, "plan");
    if (lock !== undefined) {
      try {
        return move();
      } finally {
        await lock.release();
      }
    }
    await wait(20);
  }
  throw new Error("The update's plan stayed locked.");
};

/** The app folder in `apps` that `command` runs from, or undefined for one elsewhere. */
const appFolderOf = (apps: string, command: ServiceCommand): string | undefined => {
  const inside = relativeInside(apps, command.program[0] ?? "");
  const first = inside?.split(/[\\/]/)[0];
  return first === undefined || first === "" || first.startsWith(".")
    ? undefined
    : join(apps, first);
};

/** Why an update didn't start, as `HostUpdateRefused` carries it. */
export interface Refusal {
  readonly reason: "busy" | "invalid" | "unsupported" | "failed";
  readonly message: string;
  readonly busy?: HostBusy;
}

const refusal = (reason: Refusal["reason"], message: string, busy?: HostBusy): Refusal => ({
  reason,
  message,
  ...(busy === undefined ? {} : { busy }),
});

const isBusy = (busy: HostBusy) => busy.turns + busy.terminals + busy.clones + busy.checks > 0;

/** "1 running turn and 2 busy terminals": what keeps a machine from updating now. */
export const busyText = (busy: HostBusy): string => {
  const each = [
    [busy.turns, "running turn"],
    [busy.terminals, "busy terminal"],
    [busy.clones, "clone"],
    [busy.checks, "check"],
  ] as const;
  const named = each
    .filter(([count]) => count > 0)
    .map(([count, what]) => `${count} ${what}${count === 1 ? "" : "s"}`);
  return named.length <= 1
    ? (named[0] ?? "nothing")
    : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
};

/** How the supervisor is started: to move the service, or only to move it back. */
export type SupervisorMode = "switch" | "rollback";

/** What the updater needs from its machine, each a seam for tests. */
export interface SelfUpdateDeps {
  /** The release this host runs; undefined when it runs from source. */
  readonly release: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** The host's folder, where the plan is kept. */
  readonly home: string;
  /** Where apps are downloaded to and unpacked. */
  readonly apps: string;
  /** What runs this host now, as its service; undefined when it doesn't run as its service. */
  readonly current: ServiceCommand | undefined;
  /** What is running that an update would cut off. */
  readonly busy: () => Promise<HostBusy>;
  /** Whether the host takes new work; closed from the last look at what runs to the restart. */
  readonly admission: Pick<Admission, "close" | "open" | "inflight">;
  /** How long the closed gate settles before the last look, for work just admitted to show. */
  readonly settleMs?: number;
  readonly fetch: typeof fetch;
  /** Unpacks the verified download `archive` into the empty folder `into`. */
  readonly unpack: (archive: string, into: string) => Promise<void>;
  /** Whether the app's host starts: `gram-host --help` under its own binary. */
  readonly probe: (bin: string, entry: string) => Promise<boolean>;
  /** Starts the supervisor outside this host's service, which then moves the service. */
  readonly handOver: (plan: UpdatePlan, mode: SupervisorMode) => Promise<void>;
  readonly now: () => number;
}

/** The release's checksum for `asset`, from its `SHA256SUMS.txt`. */
const checksumOf = async (deps: SelfUpdateDeps, base: string, asset: string) => {
  const response = await deps.fetch(`${base}/SHA256SUMS.txt`, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Couldn't read the release's checksums (${response.status}).`);
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error("The release's checksum list is too large.");
  for (const line of text.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/, 2);
    if (
      hash !== undefined &&
      /^[a-f0-9]{64}$/i.test(hash) &&
      (name === asset || name === `*${asset}`)
    )
      return hash.toLowerCase();
  }
  throw new Error(`The release lists no checksum for ${asset}.`);
};

/** Downloads `url` to `path`, hashing it as it comes, and answers its SHA-256. */
const download = async (
  deps: SelfUpdateDeps,
  url: string,
  path: string,
  progress: (step: HostUpdateProgress) => void,
) => {
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(), STALL_MS);
  const response = await deps.fetch(url, { redirect: "follow", signal: stall.signal });
  if (!response.ok || response.body === null)
    throw new Error(`Couldn't download ${url.split("/").at(-1)} (${response.status}).`);
  const header = Number(response.headers.get("content-length"));
  const total = Number.isFinite(header) && header > 0 ? header : undefined;
  if (total !== undefined && total > MAX_DOWNLOAD) throw new Error("The download is too large.");
  const hash = createHash("sha256");
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  let received = 0;
  let told = 0;
  progress({ phase: "downloading", received, ...(total === undefined ? {} : { total }) });
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), STALL_MS);
      received += value.byteLength;
      if (received > MAX_DOWNLOAD) throw new Error("The download is too large.");
      hash.update(value);
      writeSync(fd, value);
      // About every 2%, or every 4 MB when the size isn't known.
      if (received - told >= (total === undefined ? 4 * 1024 * 1024 : total / 50)) {
        told = received;
        progress({ phase: "downloading", received, ...(total === undefined ? {} : { total }) });
      }
    }
    fsyncSync(fd);
  } finally {
    clearTimeout(timer);
    closeSync(fd);
  }
  return hash.digest("hex");
};

/** The service the new app runs: the one that runs now, on the new binary and entry. */
const nextCommand = (current: ServiceCommand, bin: string, entry: string): ServiceCommand => ({
  ...current,
  program: [bin, entry, ...current.program.slice(2)],
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The host's updater: `check` for `host.update.check`, `start` for `host.update.start`. One
 * update runs at a time: in this process, and across restarts while its plan is unfinished.
 */
export const makeSelfUpdate = (deps: SelfUpdateDeps) => {
  /** Set from the moment a start is taken until it is refused, or the service stops after it. */
  let running = false;
  /**
   * A host started on the release an unfinished update moves to takes no work until that update
   * is confirmed: its supervisor may still give up on it and move the service back.
   */
  const starting = readPlan(deps.home);
  let awaitingConfirmation =
    starting !== undefined &&
    starting.release === deps.release &&
    (starting.phase === "switching" || starting.phase === "rollingBack");
  if (awaitingConfirmation) deps.admission.close();

  /** Moves a staged, tested app into `apps/<release>`, and answers where its host is. */
  const prepare = async (
    release: string,
    asset: string,
    progress: (step: HostUpdateProgress) => void,
  ) => {
    const target = join(deps.apps, release);
    const ready = appLayout(deps.platform, target);
    // Unpacked and tested before, by an update that then found the machine busy.
    if (existsSync(join(target, ".complete")) && (await deps.probe(ready.bin, ready.entry)))
      return ready;
    const base = `${RELEASES}/v${release}`;
    const want = await checksumOf(deps, base, asset);
    const work = mkdtempSync(join(deps.apps, ".update-"));
    try {
      const archive = join(work, asset);
      const got = await download(deps, `${base}/${asset}`, archive, progress);
      progress({ phase: "verifying" });
      if (got !== want)
        throw new Error(`${asset} doesn't match its checksum; nothing was installed.`);
      progress({ phase: "unpacking" });
      const stage = join(work, "app");
      await deps.unpack(archive, stage);
      rmSync(archive, { force: true });
      progress({ phase: "testing" });
      const staged = appLayout(deps.platform, stage);
      if (!(await deps.probe(staged.bin, staged.entry)))
        throw new Error(`Gram ${release} didn't start here, so nothing was installed.`);
      writeFileSync(join(stage, ".complete"), "");
      rmSync(target, { recursive: true, force: true });
      renameSync(stage, target);
      return ready;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  const start = async (
    release: string,
    progress: (step: HostUpdateProgress) => void,
  ): Promise<Refusal | undefined> => {
    if (!RELEASE.test(release)) return refusal("invalid", "That isn't a Gram release.");
    if (deps.release === undefined)
      return refusal(
        "unsupported",
        "This machine's gram-host runs from source, so it has no release to update.",
      );
    if (compareReleases(release, deps.release) <= 0)
      return refusal("invalid", `This machine already runs Gram ${deps.release}.`);
    const asset = releaseAsset(release, deps.platform, deps.arch);
    if (asset === undefined)
      return refusal("unsupported", "Gram makes no release for this machine's platform.");
    const current = deps.current;
    if (current === undefined)
      return refusal(
        "unsupported",
        "gram-host isn't running as its background service here, so it can't move itself. Rerun the installer.",
      );
    // Taken before the first wait, so a second start can't slip in behind this one.
    if (running) return refusal("failed", "An update is already running.");
    running = true;
    let closed = false;
    let handedOver = false;
    try {
      const pending = readPlan(deps.home);
      if (pending !== undefined && pending.phase !== "done")
        return refusal("failed", `An update to ${pending.release} is still under way.`);
      // Both locks it will need, before anything is downloaded or changed.
      const conflict = await lockConflict(deps.home);
      if (conflict !== undefined) return refusal("failed", conflict);
      const before = await deps.busy();
      if (isBusy(before)) return refusal("busy", `It is busy: ${busyText(before)}.`, before);
      const ready = await prepare(release, asset, progress);
      // The download takes minutes, and work may have started meanwhile. From here no new work is
      // taken; work admitted just before counts until it has answered, and the app stays ready.
      deps.admission.close();
      closed = true;
      await wait(deps.settleMs ?? 2_000);
      const seen = await deps.busy();
      const inflight = deps.admission.inflight();
      const now = !isBusy(seen) && inflight > 0 ? { ...seen, turns: inflight } : seen;
      if (isBusy(now)) return refusal("busy", `It is busy: ${busyText(now)}.`, now);
      progress({ phase: "switching" });
      const plan: UpdatePlan = {
        version: 1,
        id: randomBytes(8).toString("hex"),
        release,
        from: deps.release,
        previous: current,
        next: nextCommand(current, ready.bin, ready.entry),
        phase: "switching",
        startedAt: deps.now(),
      };
      // Asked again just before anything changes: the download took minutes.
      const late = await lockConflict(deps.home);
      if (late !== undefined) return refusal("failed", late);
      writePlan(deps.home, plan);
      try {
        await deps.handOver(plan, "switch");
      } catch (error) {
        writePlan(deps.home, {
          ...plan,
          phase: "done",
          outcome: {
            release,
            outcome: "failed",
            message: `The update couldn't start: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
            at: deps.now(),
          },
        });
        throw error;
      }
      handedOver = true;
      // The gate stays closed until the service stops this process. One that is still running
      // well past the wait was left alone by its supervisor: it takes work again.
      setTimeout(() => {
        deps.admission.open();
        running = false;
      }, STALE_MS).unref?.();
      return undefined;
    } catch (error) {
      return refusal(
        "failed",
        error instanceof Error ? error.message.slice(0, 300) : String(error),
      );
    } finally {
      if (!handedOver) {
        if (closed) deps.admission.open();
        running = false;
      }
    }
  };

  /**
   * Whether it could update now and how its last update went. Asked once this host's hello has
   * passed, so a plan that moved to this release is confirmed here: its supervisor sees it and lets
   * the previous app go.
   */
  const check = async (): Promise<HostUpdateCheck> => {
    const busy = await deps.busy();
    let plan = readPlan(deps.home);
    if (plan?.phase === "switching" && plan.release === deps.release) {
      try {
        // Under the plan lock: a supervisor that already gave up on it has marked it rolling
        // back, and then this confirms nothing.
        plan = await withPlanLock(deps.home, () => {
          const now = readPlan(deps.home);
          if (now?.phase !== "switching" || now.release !== deps.release) return now;
          const confirmed: UpdatePlan = { ...now, phase: "confirmed" };
          writePlan(deps.home, confirmed);
          return confirmed;
        });
      } catch {
        // The supervisor rolls back; nothing else is lost.
      }
    }
    // Confirmed, so its supervisor won't move the service back: it takes work now.
    if (awaitingConfirmation && plan?.phase === "confirmed") {
      awaitingConfirmation = false;
      deps.admission.open();
    }
    const last: HostUpdateOutcome | undefined =
      plan?.outcome ??
      (plan?.phase === "confirmed" && plan.release === deps.release
        ? { release: plan.release, outcome: "updated", at: deps.now() }
        : undefined);
    return {
      ...(isBusy(busy) ? { busy } : {}),
      ...(last === undefined ? {} : { last }),
    };
  };

  return { start, check };
};

/** What the supervisor needs, each a seam for tests. */
export interface SuperviseDeps {
  readonly home: string;
  readonly apps: string;
  /** Writes the service and (re)starts it. */
  readonly install: (command: ServiceCommand) => Promise<void>;
  /** The `gram-host` command in `~/.local/bin`, rewritten to the new app when it is the installer's. */
  readonly shim?: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly confirmMs?: number;
  readonly log: (line: string) => void;
}

const SHIM_HEADER = "#!/bin/sh\n# Gram";

/** The installer's `gram-host` command, pointing at `command`'s app. */
const shimText = (command: ServiceCommand) => {
  const [bin = "", entry = ""] = command.program;
  return `#!/bin/sh\n# Gram's own app, run as Node: its gram-host.\nELECTRON_RUN_AS_NODE=1 exec '${bin}' '${entry}' "$@"\n`;
};

/**
 * The supervisor, `gram-host update-supervise <id>`: it runs the app the host ran before the
 * update, outside the host's service, so moving the service doesn't stop it. It acts only on the
 * plan with its id, only while it holds the lock, and only one at a time. With `rollback` it only
 * moves the service back: a host that started again found the plan's supervisor gone.
 */
export const superviseUpdate = async (
  deps: SuperviseDeps,
  id: string,
  mode: SupervisorMode = "switch",
): Promise<HostUpdateOutcome | undefined> => {
  // Held by the kernel for as long as this process runs: no second supervisor can take it, and
  // it is free again once this one ends, however it ends.
  const lock = await takeUpdateLock(deps.home, "supervisor");
  if (lock === undefined) {
    deps.log("gram-host: another update's supervisor is running; this one leaves it alone.");
    return undefined;
  }
  try {
    const plan = readPlan(deps.home);
    // A rollback picks up a plan left rolling back by a supervisor that died mid-way.
    if (
      plan === undefined ||
      plan.id !== id ||
      !(plan.phase === "switching" || (mode === "rollback" && plan.phase === "rollingBack"))
    ) {
      deps.log("gram-host: no update is waiting under that id.");
      return undefined;
    }
    const finish = async (outcome: HostUpdateOutcome) => {
      await withPlanLock(deps.home, () => {
        const now = readPlan(deps.home);
        if (now?.id === plan.id) writePlan(deps.home, { ...now, phase: "done", outcome });
      });
      deps.log(
        `gram-host: update to ${plan.release}: ${outcome.outcome}${outcome.message === undefined ? "" : ` (${outcome.message})`}`,
      );
      return outcome;
    };
    const nextApp = join(deps.apps, plan.release);
    const previousApp = appFolderOf(deps.apps, plan.previous);
    const back = plan.from === undefined ? "the app it ran" : plan.from;
    /** The new host confirmed it: the app it ran before goes. */
    const succeed = async (): Promise<HostUpdateOutcome | undefined> => {
      if (previousApp !== undefined && previousApp !== nextApp)
        rmSync(previousApp, { recursive: true, force: true });
      if (deps.shim !== undefined) {
        try {
          if (readFileSync(deps.shim, "utf8").startsWith(SHIM_HEADER)) {
            const temporary = `${deps.shim}.part`;
            writeFileSync(temporary, shimText(plan.next), { mode: 0o755 });
            chmodSync(temporary, 0o755);
            renameSync(temporary, deps.shim);
          }
        } catch {
          // No shim, or not the installer's: left as it is.
        }
      }
      return finish({ release: plan.release, outcome: "updated", at: deps.now() });
    };
    /**
     * Moves the service back, unless the new host was confirmed first. The choice is made under
     * the plan lock: once the plan reads rolling back, no confirmation lands, and the new host,
     * which takes no work until it is confirmed, has taken none.
     */
    const rollBack = async (message: string): Promise<HostUpdateOutcome | undefined> => {
      const decided = await withPlanLock(deps.home, () => {
        const now = readPlan(deps.home);
        if (now?.id !== plan.id) return "gone" as const;
        if (now.phase === "confirmed") return "confirmed" as const;
        if (now.phase === "switching") writePlan(deps.home, { ...now, phase: "rollingBack" });
        return "rollingBack" as const;
      });
      if (decided === "gone") return undefined;
      if (decided === "confirmed") return succeed();
      // Nothing to go back to: the new app stays, whatever the service names.
      if (!existsSync(plan.previous.program[0] ?? ""))
        return finish({
          release: plan.release,
          outcome: "failed",
          message: `${message} The app it ran before is gone, so nothing was moved back; rerun the installer there.`,
          at: deps.now(),
        });
      try {
        await deps.install(plan.previous);
      } catch (error) {
        // The service may still name the new app: both stay, and it says so.
        return finish({
          release: plan.release,
          outcome: "failed",
          message: `${message} Moving the service back to ${back} failed too (${String(error).slice(0, 160)}), so both apps are kept; rerun the installer there.`,
          at: deps.now(),
        });
      }
      if (previousApp !== nextApp) rmSync(nextApp, { recursive: true, force: true });
      return finish({ release: plan.release, outcome: "rolledBack", message, at: deps.now() });
    };
    if (mode === "rollback")
      return await rollBack(
        `The machine restarted before Gram ${plan.release} dialled in, so it went back to ${back}.`,
      );
    // Its plan lock must be takeable before the service moves: every decision after the move
    // needs it, and one it can't take would strand the update half-way.
    if (!(await planLockUsable(deps.home))) {
      // Written without that lock: the service hasn't moved, so only the host it runs now reads
      // the plan, and it confirms no release but its own.
      const outcome: HostUpdateOutcome = {
        release: plan.release,
        outcome: "failed",
        message: `gram-host couldn't take its update's plan lock (port ${lockPort(deps.home, "plan") ?? "unknown"}), so the service didn't move.`,
        at: deps.now(),
      };
      const now = readPlan(deps.home);
      if (now?.id === plan.id) writePlan(deps.home, { ...now, phase: "done", outcome });
      deps.log(`gram-host: update to ${plan.release}: failed (${outcome.message})`);
      return outcome;
    }
    try {
      await deps.install(plan.next);
    } catch (error) {
      return await rollBack(
        `The service couldn't move to Gram ${plan.release}: ${String(error).slice(0, 200)}`,
      );
    }
    const deadline = deps.now() + (deps.confirmMs ?? CONFIRM_MS);
    while (deps.now() < deadline) {
      await deps.sleep(2_000);
      const now = readPlan(deps.home);
      // Confirmed: the new host dialled in and passed its hello.
      if (now?.id === plan.id && now.phase === "confirmed") return await succeed();
    }
    return await rollBack(
      `Gram ${plan.release} didn't dial in within ${Math.round((deps.confirmMs ?? CONFIRM_MS) / 60_000)} minutes.`,
    );
  } finally {
    await lock.release();
  }
};

/**
 * What a host starting finds of an unfinished update whose supervisor is gone (a reboot or a
 * crash took it): `rollback` for one never confirmed, past the wait, which it hands to a new
 * supervisor; `finished` for one confirmed, which it records as updated; otherwise nothing.
 */
export const recoverUpdate = async (deps: {
  readonly home: string;
  readonly release: string | undefined;
  readonly now: () => number;
  readonly handOver: (plan: UpdatePlan, mode: SupervisorMode) => Promise<void>;
}): Promise<"rollback" | "finished" | undefined> => {
  const plan = readPlan(deps.home);
  if (plan === undefined || plan.phase === "done" || (await supervisorRunning(deps.home)))
    return undefined;
  if (plan.phase === "confirmed") {
    const finished = await withPlanLock(deps.home, () => {
      const now = readPlan(deps.home);
      if (now?.id !== plan.id || now.phase !== "confirmed") return false;
      writePlan(deps.home, {
        ...now,
        phase: "done",
        outcome: { release: now.release, outcome: "updated", at: deps.now() },
      });
      return true;
    });
    return finished ? "finished" : undefined;
  }
  if (deps.now() - plan.startedAt < STALE_MS) return undefined;
  // This host is the new release, up and asked nothing yet: it waits for its check instead.
  if (deps.release === plan.release && deps.now() - plan.startedAt < 2 * STALE_MS) return undefined;
  await deps.handOver(plan, "rollback");
  return "rollback";
};

/** Runs `file` and answers its exit code and the end of its output. */
const run = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
) =>
  new Promise<{ readonly code: number; readonly output: string }>((resolve) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-2000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });

/** Unpacks a release download as the installer does: `ditto` on a Mac, the AppImage's own extract on Linux. */
export const unpackRelease =
  (platform: NodeJS.Platform) =>
  async (archive: string, into: string): Promise<void> => {
    if (platform === "darwin") {
      const done = await run("ditto", ["-x", "-k", archive, into]);
      if (done.code !== 0)
        throw new Error(`Couldn't unpack the download: ${done.output.slice(-200)}`);
      return;
    }
    // Only ever run once its checksum matched. Unpacked, it needs no FUSE and starts no desktop.
    chmodSync(archive, 0o700);
    const work = dirname(into);
    const done = await run(archive, ["--appimage-extract"], { cwd: work });
    if (done.code !== 0)
      throw new Error(`Couldn't unpack the download: ${done.output.slice(-200)}`);
    renameSync(join(work, "squashfs-root"), into);
  };

/** Whether the app's gram-host starts, as the installer checks one: `--help`, as Node. */
export const probeHost = async (bin: string, entry: string): Promise<boolean> => {
  if (!existsSync(bin)) return false;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  return (await run(bin, [entry, "--help"], { env, timeoutMs: 30_000 })).code === 0;
};

const uid = () => userInfo().uid;

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** The supervisor's launchd job: run once, with the host's environment, logging to its log. */
export const supervisorPlist = (command: ServiceCommand): string => {
  const strings = command.program.map((word) => `    <string>${xml(word)}</string>`).join("\n");
  const env = Object.entries(command.env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  const log = xml(join(command.home, "host.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SUPERVISOR_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>LaunchOnlyOnce</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
};

/** The supervisor's command: the app running now, as Node, with `update-supervise`. */
export const supervisorCommand = (
  current: ServiceCommand,
  id: string,
  mode: SupervisorMode = "switch",
): ServiceCommand => {
  const { GRAM_HOST_SERVICE: _service, ...env } = current.env;
  return {
    program: [
      ...current.program.slice(0, 2),
      "update-supervise",
      id,
      ...(mode === "rollback" ? ["rollback"] : []),
    ],
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    home: current.home,
  };
};

/**
 * Starts the supervisor outside the host's service: a transient systemd user unit, or a launchd
 * job of its own, so the service's restart doesn't stop it.
 */
export const handOverToSupervisor =
  (platform: NodeJS.Platform) =>
  async (plan: UpdatePlan, mode: SupervisorMode): Promise<void> => {
    // Never a second supervisor beside one still running.
    if (await supervisorRunning(plan.previous.home))
      throw new Error("An update's supervisor is still running.");
    const command = supervisorCommand(plan.previous, plan.id, mode);
    if (platform === "darwin") {
      const file = join(command.home, "update-supervisor.plist");
      writeFileSync(file, supervisorPlist(command), { mode: 0o600 });
      // One left loaded by an earlier update has finished: its lock is free.
      await run("launchctl", ["bootout", `gui/${uid()}/${SUPERVISOR_LABEL}`]);
      const done = await run("launchctl", ["bootstrap", `gui/${uid()}`, file]);
      if (done.code !== 0) throw new Error(`Couldn't start the update: ${done.output.slice(-200)}`);
      return;
    }
    const done = await run("systemd-run", [
      "--user",
      "--collect",
      "--quiet",
      `--unit=gram-host-update-${plan.id}-${mode}`,
      ...Object.entries(command.env).map(([key, value]) => `--setenv=${key}=${value}`),
      "--",
      ...command.program,
    ]);
    if (done.code !== 0) throw new Error(`Couldn't start the update: ${done.output.slice(-200)}`);
  };

export type SelfUpdate = ReturnType<typeof makeSelfUpdate>;
