/**
 * The condition kinds Gram can wait on (`WakeCondition`), one `WakeConditionSource` each. A new kind
 * is a source here and a line in `WakeConditionSourcesLive`; the engine (`conditions.ts`) runs them.
 */
import {
  AppToolError,
  RELEASE_MIN_AGE_DAYS,
  type ReleasePublishedCondition,
  type Thread,
  type ThreadId,
  type ThreadStatus,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import type { AutoMerges } from "../git/auto-merges.ts";
import { MergeFreezes, MergeFreezesLive } from "../git/merge-freezes.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { compareVersions } from "../agent-runtime/policy.ts";
import { DAY_MS } from "../zone-time.ts";
import { BranchHeads } from "./branch-heads.ts";
import { type CiJobs, ciStuckSource } from "./ci-stuck.ts";
import { folderOf } from "./condition-folders.ts";
import { InstalledVersions } from "./installed-versions.ts";
import { type UpstreamRelease, UpstreamReleases } from "./upstream-releases.ts";
import {
  type ConditionLook,
  WakeConditionsLive,
  WakeConditionSources,
  type WakeConditionSource,
} from "./conditions.ts";
import { type MachineState, machineSource } from "./machine.ts";

const met = (facts: Readonly<Record<string, string>>): ConditionLook => ({ met: true, facts });
const notMet = (seen?: Readonly<Record<string, string>>): ConditionLook =>
  seen === undefined ? { met: false } : { met: false, seen: { ...seen } };

const refuse = (message: string) => new AppToolError({ tool: "schedule_wake", message });

/** How long one branch's head, read for one wake, answers for the others on it. */
const HEAD_READ_REUSE_MS = 20_000;

/**
 * `branchMoved`: the head of a repo's branch changes. Set, it reads the head as the baseline, its
 * default branch's when none is named; each poll reads it again (once per branch, however many wait
 * on it) and fires on a head that differs, or on the branch being deleted. The debounce lets a
 * burst of merges land, and the notice names the head it settled on.
 */
export const branchMovedSource = Effect.gen(function* () {
  const heads = yield* BranchHeads;
  const store = yield* ThreadStore;
  const reads = new Map<
    string,
    { readonly at: number; readonly head: string | null | undefined }
  >();

  const headOf = (cwd: string, repo: string, branch: string) =>
    Effect.gen(function* () {
      const key = `${repo.toLowerCase()}\u0000${branch}`;
      const now = yield* Clock.currentTimeMillis;
      const kept = reads.get(key);
      if (kept !== undefined && now - kept.at < HEAD_READ_REUSE_MS) return kept.head;
      const head = yield* heads.head(cwd, repo, branch);
      if (head !== undefined) reads.set(key, { at: now, head });
      return head;
    });

  const source: WakeConditionSource<"branchMoved"> = {
    kind: "branchMoved",
    pollEvery: Duration.minutes(2),
    debounce: Duration.seconds(30),
    arm: (caller, spec) =>
      Effect.gen(function* () {
        const cwd = yield* folderOf(caller);
        const branch = spec.branch ?? (yield* heads.defaultBranch(cwd, spec.repo));
        if (branch === undefined) {
          return yield* refuse(
            `GitHub couldn't say what ${spec.repo}'s default branch is; name the \`branch\`.`,
          );
        }
        const head = yield* heads.head(cwd, spec.repo, branch);
        if (head === null) return yield* refuse(`${spec.repo} has no branch ${branch}.`);
        // Unreadable now: the first look that reads it is the baseline.
        return {
          spec: { ...spec, branch },
          ...(head === undefined ? {} : { seen: { head } }),
        };
      }),
    look: (wake) =>
      Effect.gen(function* () {
        const branch = wake.spec.branch;
        if (branch === undefined) return undefined;
        const waiter = yield* store.getThread(wake.threadId).pipe(Effect.option);
        if (Option.isNone(waiter)) return undefined;
        const head = yield* headOf(yield* folderOf(waiter.value), wake.spec.repo, branch);
        if (head === undefined) return undefined;
        const facts = { repo: wake.spec.repo, branch };
        if (head === null) return met({ ...facts, head: "deleted" });
        const before = wake.seen?.head;
        if (before === undefined) return notMet({ head });
        if (head === before) return notMet();
        return met({ ...facts, head, previous: before });
      }),
  };
  return source;
});

/** At rest: the thread runs no turn and waits on nothing. */
const AT_REST: ReadonlyArray<ThreadStatus> = ["idle", "cold", "ended"];

/**
 * `threadFinished`: another thread is done with its work. It reports `done`, or is marked completed,
 * or is at rest after a report of any kind; each counts only after the wake was set. A thread that
 * is archived or closed ends the wait too, and says so. Set on one that is archived, or at rest with
 * `done` as its latest report, it is refused as finished already. Its thread's upserts and the
 * workspace's reports ask for a look; the debounce lets a thread that reported and kept going show
 * it isn't at rest.
 */
export const threadFinishedSource = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const runtimes = yield* ThreadRuntimes;
  const hub = yield* EventHub;
  /** The threads some wake waits on, which their upserts are let through for. */
  const targets = new Set<ThreadId>();

  const lastReport = (thread: Thread) =>
    thread.workspaceId === undefined
      ? Effect.succeed(undefined)
      : store
          .latestWorkerReports(thread.workspaceId, [thread.id])
          .pipe(Effect.map((reports) => reports[0]?.report));

  const atRest = (threadId: ThreadId) =>
    runtimes.status(threadId).pipe(
      Effect.map((status) => AT_REST.includes(status)),
      Effect.orElseSucceed(() => false),
    );

  const source: WakeConditionSource<"threadFinished"> = {
    kind: "threadFinished",
    pollEvery: Duration.minutes(2),
    debounce: Duration.seconds(20),
    arm: (caller, spec) =>
      Effect.gen(function* () {
        if (spec.threadId === caller.id) return yield* refuse("A thread can't wait for itself.");
        const target = yield* store.getThread(spec.threadId).pipe(Effect.option);
        if (Option.isNone(target)) return yield* refuse(`No thread has the id ${spec.threadId}.`);
        const title = target.value.title;
        if (target.value.parked) return yield* refuse(`"${title}" is archived already.`);
        const report = yield* lastReport(target.value);
        if (report?.state === "done" && (yield* atRest(target.value.id))) {
          return yield* refuse(`"${title}" reported done already and is at rest.`);
        }
        targets.add(spec.threadId);
        return { spec };
      }),
    look: (wake) =>
      Effect.gen(function* () {
        const threadId = wake.spec.threadId;
        targets.add(threadId);
        const found = yield* store.getThread(threadId).pipe(Effect.option);
        const facts = (outcome: string, title?: string): Record<string, string> => ({
          thread: threadId,
          ...(title === undefined ? {} : { title }),
          outcome,
        });
        if (Option.isNone(found)) return met(facts("closed"));
        const target = found.value;
        if (target.parked) return met(facts("archived", target.title));
        if (target.completedAt !== undefined && target.completedAt >= wake.setAt) {
          return met(facts("marked completed", target.title));
        }
        const report = yield* lastReport(target);
        if (report === undefined || report.at < wake.setAt) return notMet();
        if (report.state === "done") {
          return met(facts("reported done", target.title));
        }
        if (yield* atRest(threadId)) {
          return met(facts(`at rest after a ${report.state} report`, target.title));
        }
        return notMet();
      }),
    changes: hub
      .internalEvents(
        (event) =>
          event.type === "orchestration.changed" ||
          ((event.type === "thread.upsert" || event.type === "thread.removed") &&
            targets.has(event.type === "thread.upsert" ? event.thread.id : event.threadId)),
        "thread finished wakes",
      )
      .pipe(Stream.debounce(Duration.seconds(2))),
  };
  return source;
});

/**
 * `freezeLifted`: a merge freeze (`merge_freeze`) on a repo's branch ends, lifted or expired. Set
 * without a branch, it waits on the freeze standing on the repo then; set on a branch that isn't
 * frozen, it is refused. Every change of a freeze asks for a look.
 */
export const freezeLiftedSource = Effect.gen(function* () {
  const freezes = yield* MergeFreezes;
  const source: WakeConditionSource<"freezeLifted"> = {
    kind: "freezeLifted",
    pollEvery: Duration.minutes(1),
    debounce: Duration.seconds(5),
    arm: (_caller, spec) =>
      Effect.gen(function* () {
        const held = yield* freezes.active(spec.repo, spec.branch);
        if (held === undefined) {
          return yield* refuse(
            `${spec.repo}${spec.branch === undefined ? "" : ` ${spec.branch}`} isn't frozen.`,
          );
        }
        return { spec: { ...spec, branch: held.branch } };
      }),
    look: (wake) =>
      Effect.gen(function* () {
        const branch = wake.spec.branch;
        if (branch === undefined) return undefined;
        const held = yield* freezes.active(wake.spec.repo, branch);
        return held === undefined ? met({ repo: wake.spec.repo, branch }) : notMet();
      }),
    changes: freezes.changes,
  };
  return source;
});

const HOUR_MS = 3_600_000;
/** How long a package's releases, read once, answer for every wake on it. */
export const RELEASE_READ_EVERY_MS = 6 * HOUR_MS;
/** The longest a failing registry is left before it is asked again. */
export const RELEASE_BACKOFF_MAX_MS = 24 * HOUR_MS;
/** Setting a wake reads afresh, unless a read this recent answered. */
const RELEASE_ARM_REUSE_MS = 60_000;

/** `1.2.3` for `v1.2.3`. */
const bareVersion = (version: string) => version.replace(/^v/, "");

/** The newest of `releases` by version; `undefined` for none. */
const newest = (releases: ReadonlyArray<UpstreamRelease>) =>
  releases.reduce<UpstreamRelease | undefined>(
    (best, each) =>
      best === undefined || compareVersions(each.version, best.version) > 0 ? each : best,
    undefined,
  );

/** The releases a wake counts: stable ones, and prereleases when it asked for them. */
const counted = (spec: ReleasePublishedCondition, releases: ReadonlyArray<UpstreamRelease>) =>
  releases.filter((release) => spec.includePrerelease === true || !release.prerelease);

/** The newest release newer than `after` and old enough by `now`, if any. */
export const releaseDue = (
  spec: ReleasePublishedCondition,
  after: string,
  releases: ReadonlyArray<UpstreamRelease>,
  now: number,
): UpstreamRelease | undefined => {
  const minAge = (spec.minAgeDays ?? RELEASE_MIN_AGE_DAYS) * DAY_MS;
  return newest(
    counted(spec, releases).filter(
      (release) =>
        compareVersions(release.version, after) > 0 && now - release.publishedAt >= minAge,
    ),
  );
};

const where = (spec: ReleasePublishedCondition) => (spec.source === "npm" ? "npm" : "GitHub");

/**
 * `releasePublished`: a package on npm, or a GitHub repo, publishes a version newer than `after`
 * that is at least `minAgeDays` old (seven by default, as Gram's own Dependabot waits). Set without
 * `after`, the latest release now is the baseline. A package's releases are read once for every
 * wake on it and kept six hours; a failed read is retried after twelve, then a day, and is never
 * met. Looks run hourly over what was read, so a release crosses its age within the hour without
 * asking the registry again.
 */
export const releasePublishedSource = Effect.gen(function* () {
  const upstream = yield* UpstreamReleases;
  /** Per package: the last answer that read, when, and when to ask again. */
  const reads = new Map<
    string,
    {
      readonly list: ReadonlyArray<UpstreamRelease> | null | undefined;
      readonly at: number;
      readonly nextAt: number;
      readonly failures: number;
    }
  >();

  /** The package's releases: the kept answer while it is due no read, else a new one. */
  const releasesOf = (spec: ReleasePublishedCondition, reuseMs?: number) =>
    Effect.gen(function* () {
      const key = `${spec.source}\u0000${spec.name.toLowerCase()}`;
      const now = yield* Clock.currentTimeMillis;
      const kept = reads.get(key);
      if (
        kept !== undefined &&
        (reuseMs === undefined
          ? now < kept.nextAt
          : kept.list !== undefined && now - kept.at < reuseMs)
      ) {
        return kept.list;
      }
      const list = yield* upstream.list(spec.source, spec.name);
      if (list === undefined) {
        const failures = (kept?.failures ?? 0) + 1;
        const wait = Math.min(RELEASE_READ_EVERY_MS * 2 ** failures, RELEASE_BACKOFF_MAX_MS);
        // A failure keeps the last answer that read, if there was one.
        reads.set(key, { list: kept?.list, at: kept?.at ?? now, nextAt: now + wait, failures });
        return kept?.list;
      }
      reads.set(key, { list, at: now, nextAt: now + RELEASE_READ_EVERY_MS, failures: 0 });
      return list;
    });

  const source: WakeConditionSource<"releasePublished"> = {
    kind: "releasePublished",
    pollEvery: Duration.hours(1),
    // A published release doesn't flap.
    debounce: Duration.zero,
    arm: (_caller, spec) =>
      Effect.gen(function* () {
        // An owner never starts with a dot; a repo may (`.github`), but isn't `.` or `..`.
        if (spec.source === "github" && !/^[\w-][\w.-]*\/(?!\.\.?$)[\w.-]+$/.test(spec.name)) {
          return yield* refuse(`Name a GitHub repo as owner/repo, not ${spec.name}.`);
        }
        if (
          spec.minAgeDays !== undefined &&
          !(Number.isInteger(spec.minAgeDays) && spec.minAgeDays >= 0 && spec.minAgeDays <= 90)
        ) {
          return yield* refuse("`minAgeDays` is a whole number of days from 0 to 90.");
        }
        const filled: ReleasePublishedCondition = {
          ...spec,
          ...(spec.after === undefined ? {} : { after: bareVersion(spec.after) }),
          minAgeDays: spec.minAgeDays ?? RELEASE_MIN_AGE_DAYS,
        };
        const list = yield* releasesOf(filled, RELEASE_ARM_REUSE_MS);
        if (list === null) return yield* refuse(`${where(spec)} has no ${spec.name}.`);
        // Unreadable now: the first look that reads it takes the baseline.
        if (list === undefined) return { spec: filled };
        if (filled.after === undefined) {
          const latest = newest(counted(filled, list));
          return { spec: { ...filled, after: latest?.version ?? "0.0.0" } };
        }
        const due = releaseDue(filled, filled.after, list, yield* Clock.currentTimeMillis);
        if (due !== undefined) {
          return yield* refuse(
            `${spec.name} has ${due.version} already, published ${new Date(due.publishedAt).toISOString().slice(0, 10)}.`,
          );
        }
        return { spec: filled };
      }),
    look: (wake) =>
      Effect.gen(function* () {
        const spec = wake.spec;
        const list = yield* releasesOf(spec);
        if (list === undefined) return undefined;
        // Gone since: nothing will be published there to wait for; the fallback time still is.
        if (list === null) return notMet();
        const after = spec.after ?? wake.seen?.after;
        if (after === undefined) {
          return notMet({ after: newest(counted(spec, list))?.version ?? "0.0.0" });
        }
        const due = releaseDue(spec, after, list, yield* Clock.currentTimeMillis);
        if (due === undefined) return notMet();
        return met({
          source: spec.source,
          name: spec.name,
          version: due.version,
          published: new Date(due.publishedAt).toISOString(),
          url: due.url,
          after,
        });
      }),
  };
  return source;
});

const TARGET_NAMES = { gram: "Gram", claude: "Claude Code", codex: "Codex", gh: "gh" } as const;

/**
 * `versionChanged`: the installed version of Gram or a CLI changes from `from` (the installed one
 * when the wake is set, by default). It reads what Gram already knows and starts no probe: Gram's
 * own version, which changes with a restart into an update, and each CLI's from the launch checks'
 * runs, which ask for a look as they finish. One look shortly after the start sees an update.
 */
export const versionChangedSource = Effect.gen(function* () {
  const installed = yield* InstalledVersions;
  const source: WakeConditionSource<"versionChanged"> = {
    kind: "versionChanged",
    pollEvery: Duration.minutes(10),
    debounce: Duration.zero,
    arm: (_caller, spec) =>
      Effect.gen(function* () {
        const name = TARGET_NAMES[spec.target];
        const now = yield* installed.baseline(spec.target);
        if (now === undefined) {
          return yield* refuse(
            spec.target === "gram"
              ? "This Gram build doesn't report its version, so it can't tell an update."
              : `Gram's launch checks found no ${name} version on the PATH.`,
          );
        }
        const from = spec.from === undefined ? now : bareVersion(spec.from);
        if (from !== now) return yield* refuse(`${name} is ${now} already, not ${from}.`);
        return { spec: { ...spec, from } };
      }),
    look: (wake) =>
      Effect.gen(function* () {
        const now = yield* installed.current(wake.spec.target);
        const from = wake.spec.from;
        if (now === undefined || from === undefined) return undefined;
        if (now === from) return notMet();
        return met({ target: wake.spec.target, version: now, previous: from });
      }),
    // The hosts register as the server finishes starting: a look then sees an update.
    changes: Stream.fromEffect(Effect.sleep(Duration.seconds(10))).pipe(
      Stream.concat(installed.changes),
    ),
  };
  return source;
});

/** Every kind's source, for `WakeConditionsLive`. */
export const WakeConditionSourcesLive = Layer.effect(
  WakeConditionSources,
  Effect.all([
    branchMovedSource,
    threadFinishedSource,
    ciStuckSource,
    machineSource,
    freezeLiftedSource,
    releasePublishedSource,
    versionChangedSource,
  ]),
);

/**
 * The condition wakes' engine with its sources, and the merge freezes, which the merge gate reads
 * too; GitHub's branches are read through `branchHeads`, and its auto-merges through `autoMerges`.
 */
export const wakeConditionsLayer = <E, R>(
  io: Layer.Layer<
    BranchHeads | AutoMerges | CiJobs | MachineState | UpstreamReleases | InstalledVersions,
    E,
    R
  >,
) =>
  WakeConditionsLive.pipe(
    Layer.provide(WakeConditionSourcesLive),
    Layer.provideMerge(MergeFreezesLive),
    Layer.provide(io),
  );
