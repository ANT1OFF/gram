import { withAnchoredFiles } from "./anchored-files.ts";
import { ReadingAs, SERVER } from "../embedding/readable-by.ts";
import {
  AutomaticDreamDeferred,
  makeAutomaticDream,
  memoryUpdateModel,
} from "./automatic-dream.ts";

import {
  DREAM_REPORT_EXCERPT_MAX,
  DREAM_SESSIONS_MAX,
  InvalidState,
  NotFound,
  type AgentUnavailable,
  type AutomaticDreamStatus,
  type Dream,
  type DreamAgentSession,
  type DreamFailure,
  type DreamFileDiff,
  type DreamId,
  type DreamWatermark,
  type DreamKind,
  type DreamMode,
  type DreamMerge,
  type DreamReport,
  type DreamResolution,
  type DreamReview,
  effectiveCheckout,
  type FsError,
  type HostId,
  hostOf,
  isPinned,
  LOCAL_HOST_ID,
  type ImportPreview,
  type ModelRef,
  type Project,
  type ProjectId,
  type ServerEvent,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceState,
  memoryUpdateModeOf,
  memoryUpdateRuleOf,
} from "@gram/contracts";
import { Worktrees } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { createHash, randomUUID } from "node:crypto";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore, type MessageMark } from "../persistence/thread-store.ts";
import { dreamSupportFor } from "@gram/agents";
import { RoutedFor } from "../host/ownership.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { ThreadRuntimes, type ObservedTurnEnd } from "../runtime/thread-runtimes.ts";
import { ThreadArchive, threadSource, type ArchivedThread } from "./archive.ts";
import {
  adoptionSet,
  DreamFiles,
  reviewDream,
  type ConflictSide,
  type DreamOutput,
  type DreamSessionFile,
  dreamSessionFileName,
} from "./dream-files.ts";
import { mergeConflict } from "./dream-merge.ts";
import { dreamCheckPrompt, dreamPrompt } from "./dream-prompt.ts";
import { lintLines, lintMemory, seriousLintProblems } from "./memory-lint.ts";
import { DELTA_CONTEXT_MESSAGES, capDigest, foldMarks, selectDelta } from "./dream-reads.ts";
import { discoverHistory, importPreview, type ImportDeps } from "./import.ts";
import {
  AUTOMATIC_RUNS_KEPT,
  changes,
  cursorAfter,
  RECENT_FILE_NAME,
  RECENT_MORE_NOTE,
  recentCount,
  recentIndex,
  revertSet,
  summaryOf,
  textSha,
  UNCHANGED_RUNS_KEPT,
} from "./dream-recent.ts";
import { makePlanRecent } from "./dream-recent-items.ts";
import { makeMemoryUpdateSchedule } from "./dream-schedule.ts";
import {
  archiveHeader,
  gatheredOf,
  plural,
  sessionIndex,
  type Gathered,
  type Unread,
} from "./dream-sessions.ts";

export {
  archiveHeader,
  digestOf,
  readingOrder,
  sessionIndex,
  type Unread,
} from "./dream-sessions.ts";
export {
  cursorAfter,
  dreamWaitsForReview,
  latestRecap,
  recentIndex,
  summaryOf,
} from "./dream-recent.ts";
import {
  OrchestrationMemory,
  memorySnapshotDigest,
  type MemoryError,
  type MemorySetFile,
} from "./memory.ts";
import { ADMITTED, admittedForRole, outwardGateFor } from "./rules.ts";
import { Orchestration } from "./service.ts";
import { blocksOf, fromStoredMessages, parseArchived, renderTranscript } from "./transcripts.ts";

/** What `dream.start` asks for once the handler has decoded it. */
export interface StartDreamInput {
  readonly workspaceId: WorkspaceId;
  readonly kind: DreamKind;
  readonly mode?: DreamMode | undefined;
  readonly threadIds?: ReadonlyArray<ThreadId> | undefined;
  readonly agentSessions?: ReadonlyArray<DreamAgentSession> | undefined;
  readonly instructions?: string | undefined;
  readonly model?: ModelRef | undefined;
  readonly projectIds?: ReadonlyArray<ProjectId> | undefined;
  readonly perRepo?: number | undefined;
  readonly includeMemory?: boolean | undefined;
  readonly budgetTokens?: number | undefined;
}

export interface DreamsShape {
  readonly automaticConfigurationChanged: Effect.Effect<void>;
  automaticStatus(workspaceId: WorkspaceId): Effect.Effect<AutomaticDreamStatus, NotFound>;
  /**
   * What an import, or with `kind: "dream"` a dream, would read, counted before anything runs.
   */
  preview(input: {
    readonly workspaceId: WorkspaceId;
    readonly kind?: DreamKind | undefined;
    readonly budgetTokens?: number | undefined;
    readonly projectIds?: ReadonlyArray<ProjectId> | undefined;
    readonly perRepo?: number | undefined;
    readonly includeMemory?: boolean | undefined;
  }): Effect.Effect<ImportPreview, NotFound | InvalidState>;
  /** Lays the dream out and starts its thread. One runs per workspace at a time. */
  start(
    input: StartDreamInput,
  ): Effect.Effect<Dream, NotFound | InvalidState | FsError | AgentUnavailable>;
  /** Newest first. */
  list(workspaceId: WorkspaceId): Effect.Effect<ReadonlyArray<Dream>, NotFound | InvalidState>;
  /** The output against the memory the dream started from and the memory there is now. */
  review(dreamId: DreamId): Effect.Effect<DreamReview, NotFound | InvalidState | FsError>;
  /** Stops a running dream; its partial output stays, to look at and then discard. */
  cancel(dreamId: DreamId): Effect.Effect<Dream, NotFound | InvalidState>;
  /**
   * Makes a completed dream's output the next memory version. `basedOn` and `outputDigest` are the
   * review the user saw (`DreamReview.memoryVersion` and `.outputDigest`): memory adopted or
   * restored since, or an output rewritten since, refuses with "review again".
   */
  adopt(
    dreamId: DreamId,
    options?: {
      readonly resolutions?: Readonly<Record<string, DreamResolution>> | undefined;
      readonly basedOn?: string | undefined;
      readonly outputDigest?: string | undefined;
      readonly memoryDigest?: string | undefined;
    },
  ): Effect.Effect<Dream, NotFound | InvalidState | FsError>;
  /**
   * Starts a model's merge of one conflict of a completed dream, on the dream's own model, and
   * returns it running; `dreams.changed` says when it ends. One already running on the same sides
   * is returned as it is; any other is started over.
   */
  merge(
    dreamId: DreamId,
    path: string,
  ): Effect.Effect<DreamMerge, NotFound | InvalidState | FsError>;
  /**
   * Points memory back at the version an adopted update was made from, while memory is still at
   * the version it made; answers its workspace. Nothing is deleted.
   */
  revert(dreamId: DreamId): Effect.Effect<WorkspaceId, NotFound | InvalidState | FsError>;
  /** Closes the dream's thread if it is still there, and deletes its folder, manifest and row. */
  discard(dreamId: DreamId): Effect.Effect<void, NotFound | InvalidState | FsError>;
}

export class Dreams extends Context.Service<Dreams, DreamsShape>()("@gram/server/Dreams") {}

type Signal =
  | { readonly type: "turnEnd"; readonly thread: Thread; readonly end: ObservedTurnEnd }
  | { readonly type: "hub"; readonly event: ServerEvent };

const refuse = (message: string) => new InvalidState({ message });
const SCHEDULE_CHECK_EVERY = "10 minutes";

const refuseOrDefer = (automatic: boolean, message: string) =>
  automatic ? new AutomaticDreamDeferred({ message }) : refuse(message);

const outputDigest = (output: DreamOutput): string => {
  const hash = createHash("sha256");
  for (const file of output.files.toSorted((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${file.path}\0${file.content.length}\0${file.content}\0`, "utf8");
  }
  return hash.digest("hex");
};

const dreamReportOf = (
  dream: Dream,
  files: ReadonlyArray<DreamFileDiff>,
  report: string | undefined,
): DreamReport => ({
  dreamId: dream.id,
  status: dream.status,
  ...(dream.mode !== "auto" ? {} : { mode: dream.mode }),
  ...(dream.adoptedVersion === undefined ? {} : { adoptedVersion: dream.adoptedVersion }),
  ...(dream.adoptionFailure === undefined ? {} : { adoptionFailure: dream.adoptionFailure }),
  ...(dream.failure === undefined ? {} : { failure: dream.failure }),
  files: files.map((file) => ({ path: file.path, status: file.status })),
  ...(report === undefined || report.trim() === ""
    ? {}
    : { reportExcerpt: report.trim().slice(0, DREAM_REPORT_EXCERPT_MAX) }),
});

const reportWithChecks = (output: {
  readonly files: ReadonlyArray<MemorySetFile>;
  readonly report?: string | undefined;
}): { readonly report?: string } => {
  const problems = lintMemory(output.files).filter(
    (problem) => problem.kind !== "no_description" && problem.kind !== "index_line_long",
  );
  if (problems.length === 0) return output.report === undefined ? {} : { report: output.report };
  const checks = `## Checks by Gram\n\nWhat Gram's check of this memory still finds:\n\n${lintLines(problems)}\n`;
  return {
    report:
      output.report === undefined || output.report.trim() === ""
        ? checks
        : `${output.report.trimEnd()}\n\n${checks}`,
  };
};

const conflictSides = (file: DreamFileDiff): string =>
  createHash("sha256")
    .update(JSON.stringify([file.before ?? null, file.after ?? null, file.current ?? null]), "utf8")
    .digest("hex");

const mergeKey = (dreamId: DreamId, path: string) => `${dreamId}\0${path}`;

/** What only a test gives: where Claude Code's config directories are. */
export interface DreamsOptions {
  readonly claudeConfigDirs?: ReadonlyArray<string> | undefined;
}

export const makeDreamsLive = (options: DreamsOptions = {}) =>
  Layer.effect(
    Dreams,
    Effect.gen(function* () {
      const store = yield* ThreadStore;
      const hub = yield* EventHub;
      const runtimes = yield* ThreadRuntimes;
      const memory = yield* OrchestrationMemory;
      const files = yield* DreamFiles;
      const archive = yield* ThreadArchive;
      const hosts = yield* AgentHosts;
      const orchestration = yield* Orchestration;
      const workerHosts = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
      const worktrees = Option.getOrUndefined(yield* Effect.serviceOption(Worktrees));
      const importDeps: ImportDeps = {
        hosts,
        worktrees,
        ...(options.claudeConfigDirs === undefined
          ? {}
          : { claudeConfigDirs: options.claudeConfigDirs }),
      };

      const signals = yield* Queue.unbounded<Signal>();
      const startLock = yield* Semaphore.make(1);
      const rowLock = yield* Semaphore.make(1);
      const adoptionLock = yield* Semaphore.make(1);
      const running = new Map<ThreadId, DreamId>();
      const checkedOnce = new Set<DreamId>();
      const merges = new Map<DreamId, Map<string, { readonly sides: string; state: DreamMerge }>>();
      const mergeFibers = yield* FiberMap.make<string>();
      const dropMerges = (dreamId: DreamId) =>
        Effect.gen(function* () {
          for (const path of merges.get(dreamId)?.keys() ?? []) {
            yield* FiberMap.remove(mergeFibers, mergeKey(dreamId, path));
          }
          merges.delete(dreamId);
        });

      const dreamsChanged = (workspaceId: WorkspaceId) =>
        hub.publish({ type: "dreams.changed", workspaceId });

      const projectsOf = (state: WorkspaceState, only?: ReadonlyArray<ProjectId>) =>
        Effect.gen(function* () {
          const all = new Map((yield* store.listProjects).map((p) => [p.id, p]));
          const outside = (only ?? []).filter((id) => !state.workspace.projectIds.includes(id));
          if (outside.length > 0) {
            return yield* refuse(
              `${plural(outside.length, "project")} named that the workspace ${state.workspace.name} doesn't hold`,
            );
          }
          return (only ?? state.workspace.projectIds).flatMap((id): ReadonlyArray<Project> => {
            const project = all.get(id);
            return project === undefined ? [] : [project];
          });
        });

      const currentMemory = (workspaceId: WorkspaceId) =>
        Effect.gen(function* () {
          const before = yield* memory.snapshot(workspaceId);
          const current: Array<MemorySetFile> = [];
          for (const file of yield* memory.list(workspaceId)) {
            current.push({ path: file.path, content: yield* memory.read(workspaceId, file.path) });
          }
          const after = yield* memory.snapshot(workspaceId);
          if (
            before.version !== after.version ||
            memorySnapshotDigest(before) !== memorySnapshotDigest(after)
          ) {
            return yield* refuse(
              "Memory changed while it was being read. Retry against the current memory.",
            );
          }
          return { version: after.version, files: current, digest: memorySnapshotDigest(after) };
        });

      const unreadOfThread = (
        thread: Thread,
        held: DreamWatermark | undefined,
        workspaceId: WorkspaceId,
      ): Effect.Effect<Unread | undefined> =>
        Effect.gen(function* () {
          const marks = yield* store.messageMarks(thread.id);
          const selection = selectDelta(marks, held);
          const first = selection.read[0];
          if (first === undefined) return undefined;
          const rows = yield* store.listMessagesFrom(
            thread.id,
            selection.before[0]?.seq ?? first.seq,
          );
          const wanted = new Set(selection.read.map((mark) => mark.seq));
          const fresh = rows.filter((row) => wanted.has(row.seq));
          const blocks = blocksOf(fromStoredMessages(fresh));
          if (blocks.length === 0) return undefined;
          const unsaved = fresh.some((row) =>
            row.message.parts.some(
              (part) => part.type === "data-handoff" && part.data.unsaved === true,
            ),
          );
          return {
            threadId: thread.id,
            source: "thread",
            title: thread.title,
            sourceLine: threadSource(thread),
            ownOrchestrator: thread.role === "orchestrator" && thread.workspaceId === workspaceId,
            at: thread.lastActivityAt,
            blocks,
            earlier:
              selection.before.length === 0
                ? undefined
                : blocksOf(fromStoredMessages(rows.filter((row) => row.seq < first.seq))).slice(
                    -DELTA_CONTEXT_MESSAGES,
                  ),
            read: selection.read,
            marks,
            held,
            ...(selection.rewound ? { rewound: true } : {}),
            ...(unsaved ? { unsaved: true } : {}),
          };
        });

      const unreadOfArchive = (
        workspaceId: WorkspaceId,
        entry: Pick<ArchivedThread, "threadId" | "archivedAt">,
        held: DreamWatermark | undefined,
      ): Effect.Effect<Unread | undefined> =>
        Effect.gen(function* () {
          const text = yield* archive
            .read(workspaceId, entry.threadId)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (text === undefined) return undefined;
          const threadId = entry.threadId as ThreadId;
          const common = {
            threadId,
            source: "archive" as const,
            at: entry.archivedAt,
            held,
            ownOrchestrator: /^Source: orchestrator thread /m.test(archiveHeader(text)),
          };
          const parsed = parseArchived(text);
          if (parsed === undefined) {
            if (held !== undefined && held.readAt >= entry.archivedAt) return undefined;
            return {
              ...common,
              title: `archived ${threadId}`,
              sourceLine: "",
              blocks: [],
              earlier: undefined,
              read: [],
              marks: [],
              whole: text,
            };
          }
          const marks = parsed.blocks.map((block): MessageMark => ({
            seq: block.seq,
            id: block.id,
            rev: 0,
            at: undefined,
            open: false,
          }));
          const selection = selectDelta(marks, held, { revs: false });
          const first = selection.read[0];
          if (first === undefined) return undefined;
          const wanted = new Set(selection.read.map((mark) => mark.seq));
          return {
            ...common,
            title: `archived ${parsed.title}`,
            sourceLine: parsed.source,
            blocks: parsed.blocks.filter((block) => wanted.has(block.seq)),
            earlier:
              selection.before.length === 0
                ? undefined
                : parsed.blocks
                    .filter((block) => block.seq < first.seq)
                    .slice(-DELTA_CONTEXT_MESSAGES),
            read: selection.read,
            marks,
            ...(selection.rewound ? { rewound: true } : {}),
          };
        });

      const marksOf = (
        state: WorkspaceState,
        version: string,
      ): Effect.Effect<ReadonlyArray<DreamWatermark>> =>
        store.listDreamWatermarks(state.workspace.id, version);

      const fromAgentSession = (
        session: DreamAgentSession,
        known: { readonly title?: string; readonly updatedAt?: number },
        notes: Array<string>,
      ): Effect.Effect<Gathered | undefined> =>
        Effect.gen(function* () {
          const label = `${session.agent} session ${session.agentSessionId}`;
          const host = yield* hosts.get(session.agent).pipe(Effect.orElseSucceed(() => undefined));
          if (host?.readSession === undefined) {
            notes.push(`${label} was left out: that agent's history can't be read.`);
            return undefined;
          }
          const transcript = yield* host
            .readSession({ cwd: session.cwd, agentSessionId: session.agentSessionId })
            .pipe(
              Effect.catch((error) => {
                notes.push(`${label} was left out: ${error.message ?? "it couldn't be read"}.`);
                return Effect.succeed(undefined);
              }),
            );
          if (transcript === undefined || transcript.messages.length === 0) return undefined;
          const title =
            known.title ??
            transcript.messages
              .find((message) => message.role === "user")
              ?.text.split("\n")[0]
              ?.slice(0, 80) ??
            label;
          return {
            name: title,
            text: renderTranscript({
              title,
              source: `${label} in ${session.cwd}`,
              messages: transcript.messages,
            }),
            at: known.updatedAt ?? transcript.messages.findLast((m) => m.at !== undefined)?.at ?? 0,
            kind: `${session.agent} session`,
            agentSession: {
              agent: session.agent,
              cwd: session.cwd,
              agentSessionId: session.agentSessionId,
            },
          };
        });

      const planRecent = makePlanRecent(store, memory);

      const gather = (
        state: WorkspaceState,
        input: StartDreamInput,
        version: string,
        notes: Array<string>,
      ) =>
        Effect.gen(function* () {
          const projects = yield* projectsOf(state, input.projectIds);
          const inWorkspace = new Set<ProjectId>(state.workspace.projectIds);
          const gathered: Array<Gathered> = [];
          const unread: Array<Unread> = [];
          const seeds: Array<DreamSessionFile> = [];
          const explicit = input.threadIds !== undefined || input.agentSessions !== undefined;

          if (explicit) {
            for (const threadId of new Set(input.threadIds ?? [])) {
              const thread = yield* store
                .getThread(threadId)
                .pipe(Effect.orElseSucceed(() => undefined));
              if (thread === undefined) {
                const one = yield* unreadOfArchive(
                  state.workspace.id,
                  { threadId, archivedAt: 0 },
                  undefined,
                );
                if (one === undefined) {
                  notes.push(`Thread ${threadId} was left out: it is neither open nor archived.`);
                } else {
                  unread.push(one);
                }
                continue;
              }
              if (!inWorkspace.has(thread.projectId) || thread.role === "dream") {
                return yield* refuse(
                  `${thread.title} is not a thread of ${state.workspace.name}'s projects, so a memory update there doesn't read it.`,
                );
              }
              const one = yield* unreadOfThread(thread, undefined, state.workspace.id);
              if (one !== undefined) unread.push(one);
            }
            for (const session of input.agentSessions ?? []) {
              const one = yield* fromAgentSession(session, {}, notes);
              if (one !== undefined) gathered.push(one);
            }
          } else if (input.kind === "import") {
            const discovery = yield* discoverHistory(importDeps, {
              projects,
              perRepo: input.perRepo,
              includeMemory: input.includeMemory,
            });
            notes.push(...discovery.notes);
            for (const session of discovery.sessions) {
              const one = yield* fromAgentSession(session, session, notes);
              if (one !== undefined) gathered.push(one);
            }
            seeds.push(
              ...discovery.seeds.map((seed) => ({
                name: seed.name,
                text: `<!-- Claude Code memory for ${seed.cwd}: ${seed.name} -->\n${seed.text}`,
              })),
            );
          } else {
            const planned = yield* planRecent(state, version);
            const since: Gathered = {
              name: RECENT_FILE_NAME,
              text: planned.recent.text,
              at: yield* Clock.currentTimeMillis,
            };
            return {
              sessions: [since],
              seeds,
              projects,
              plan: planned.plan,
              recent: planned.recent.read,
            };
          }

          const newestFirst = [...gathered, ...unread.map((one) => gatheredOf(one))].toSorted(
            (a, b) => b.at - a.at,
          );
          const cut = newestFirst
            .slice(0, DREAM_SESSIONS_MAX)
            .filter((one) => (one.left ?? 0) > 0).length;
          if (cut > 0) {
            notes.push(
              `${plural(cut, "thread")} had more new messages than one file holds: the oldest of them were read, and their watermarks stop there, so the next memory update reads on.`,
            );
          }
          const left = newestFirst.slice(DREAM_SESSIONS_MAX);
          if (left.length > 0) {
            notes.push(
              left.every((one) => one.read !== undefined)
                ? `${plural(left.length, "older thread")} with new messages left for the next memory update: one reads at most ${DREAM_SESSIONS_MAX}, and their watermarks stay where they are.`
                : `${plural(left.length, "older session")} left out: a memory update reads at most ${DREAM_SESSIONS_MAX}.`,
            );
          }
          return {
            sessions: newestFirst.slice(0, DREAM_SESSIONS_MAX),
            seeds,
            projects,
            plan: undefined,
            recent: undefined,
          };
        });

      const settle = (dreamId: DreamId, next: (dream: Dream, now: number) => Dream) =>
        rowLock.withPermits(1)(
          Effect.gen(function* () {
            const dream = yield* store
              .getDream(dreamId)
              .pipe(Effect.orElseSucceed(() => undefined));
            if (dream === undefined || dream.status !== "running") return undefined;
            const ended = next(dream, yield* Clock.currentTimeMillis);
            yield* store.putDream(ended);
            for (const [threadId, id] of running) if (id === dreamId) running.delete(threadId);
            return ended;
          }),
        );

      const usageOf = (threadId: ThreadId | undefined) =>
        threadId === undefined ? Effect.succeed(undefined) : store.lastTurnUsage(threadId);

      const announce = (
        dream: Dream,
        review: ReadonlyArray<DreamFileDiff>,
        report: string | undefined,
        notice: { readonly kind: "done" | "error" | "info"; readonly title: string },
      ) =>
        Effect.gen(function* () {
          if (dream.threadId !== undefined) {
            yield* runtimes
              .emitChunk(dream.threadId, {
                type: "data-dream-report",
                id: dream.id,
                data: dreamReportOf(dream, review, report),
              })
              .pipe(Effect.ignore);
          }
          yield* dreamsChanged(dream.workspaceId);
          yield* hub.publish({
            type: "notify",
            kind: notice.kind,
            title: notice.title,
            ...(dream.threadId === undefined ? {} : { threadId: dream.threadId }),
          });
        });

      const fail = (dreamId: DreamId, failure: DreamFailure, why: string) =>
        Effect.gen(function* () {
          const canceled = failure === "canceled";
          const dream = yield* settle(dreamId, (current, now) => ({
            ...current,
            status: canceled ? "canceled" : "failed",
            failure,
            endedAt: now,
          }));
          if (dream === undefined) return undefined;
          const usage = yield* usageOf(dream.threadId);
          const ended = usage === undefined ? dream : { ...dream, usage };
          if (usage !== undefined) yield* store.putDream(ended);
          yield* Effect.logInfo("dream ended without a result").pipe(
            Effect.annotateLogs({ dreamId, failure, why }),
          );
          yield* announce(ended, [], undefined, {
            kind: canceled ? "info" : "error",
            title: canceled ? "Memory update cancelled" : `Memory update failed: ${why}`,
          });
          return ended;
        });

      const closeFiles = (dreamId: DreamId) =>
        rowLock.withPermits(1)(
          store.withDreamFileCommit(
            Effect.gen(function* () {
              const dream = yield* store
                .getDream(dreamId)
                .pipe(Effect.orElseSucceed(() => undefined));
              if (dream === undefined || dream.status !== "running") return undefined;
              if (dream.filesClosedAt !== undefined) return dream;
              const closed = { ...dream, filesClosedAt: yield* Clock.currentTimeMillis };
              yield* store.putDream(closed);
              return closed;
            }),
          ),
        );

      const finish = (dreamId: DreamId) =>
        Effect.gen(function* () {
          const dream = yield* closeFiles(dreamId);
          if (dream === undefined) return;
          type Verdict =
            | { readonly failure: DreamFailure; readonly why: string }
            | { readonly output: DreamOutput; readonly review: ReadonlyArray<DreamFileDiff> };
          const verdict = yield* Effect.gen(function* () {
            const inputs = yield* files.verifyInputs(dream.workspaceId, dream.id);
            if (!inputs.ok) {
              const tampered: Verdict = {
                failure: "input_tampered",
                why: `its inputs were changed while it ran (${inputs.changed.slice(0, 3).join(", ")})`,
              };
              return tampered;
            }
            const output = yield* files.collectOutput(dream.workspaceId, dream.id);
            const baseline = yield* files.baseline(dream.workspaceId, dream.id);
            const current = yield* currentMemory(dream.workspaceId);
            const reviewed: Verdict = {
              output,
              review: reviewDream({
                baseline: baseline.files,
                current: current.files,
                output: output.files,
              }),
            };
            return reviewed;
          }).pipe(
            Effect.catchTag("DreamOutputRefused", (refused) =>
              Effect.succeed<Verdict>({ failure: refused.failure, why: refused.message }),
            ),
            Effect.catch((error: MemoryError) =>
              Effect.succeed<Verdict>({
                failure: "agent_error",
                why: error.message ?? error._tag,
              }),
            ),
          );
          if ("failure" in verdict) {
            yield* fail(dreamId, verdict.failure, verdict.why);
            return;
          }
          const usage = yield* usageOf(dream.threadId);
          const summary = summaryOf(verdict.review, verdict.output.report);
          const completed = yield* settle(dreamId, (current, now) => ({
            ...current,
            status: "completed",
            endedAt: now,
            summary,
            ...(usage === undefined ? {} : { usage }),
          }));
          if (completed === undefined) return;
          const nothing = !verdict.review.some(changes);
          const ended =
            completed.mode !== "auto"
              ? completed
              : nothing
                ? yield* settleUnchanged(completed)
                : yield* autoAdopt(completed, outputDigest(verdict.output));
          yield* announce(ended, verdict.review, reportWithChecks(verdict.output).report, {
            kind:
              ended.adoptionFailure === undefined
                ? ended.mode === "auto"
                  ? "info"
                  : "done"
                : "error",
            title:
              ended.mode !== "auto"
                ? "Memory update finished — review it"
                : ended.adoptionFailure !== undefined
                  ? "Memory update not applied automatically. It stays on the Memory page to look at."
                  : ended.adoptedVersion !== undefined
                    ? `Memory updated (${ended.adoptedVersion}): ${summary}`
                    : `Memory update: ${summary}`,
          });
          if (ended.mode === "auto" && ended.adoptionFailure === undefined) {
            if (ended.threadId !== undefined) {
              yield* runtimes.close(ended.threadId).pipe(Effect.ignore);
            }
            yield* pruneAutomatic(ended.workspaceId);
          }
        });

      const settleUnchanged = (dream: Dream) =>
        Effect.gen(function* () {
          if (dream.inputs.recent !== undefined) {
            yield* store.advanceDreamCursor(dream.workspaceId, cursorAfter(dream.inputs.recent));
          }
          const settled: Dream = { ...dream, unchanged: true };
          yield* store.putDream(settled);
          return settled;
        });

      const pruneAutomatic = (workspaceId: WorkspaceId) =>
        Effect.gen(function* () {
          const spent = (yield* store.listDreams(workspaceId))
            .filter(
              (dream) =>
                dream.mode === "auto" &&
                dream.status === "completed" &&
                dream.adoptionFailure === undefined,
            )
            .toSorted((a, b) => b.createdAt - a.createdAt);
          const applied = spent.filter((dream) => dream.unchanged !== true);
          const idle = spent.filter((dream) => dream.unchanged === true);
          for (const old of [
            ...applied.slice(AUTOMATIC_RUNS_KEPT),
            ...idle.slice(UNCHANGED_RUNS_KEPT),
          ]) {
            yield* discard(old.id).pipe(Effect.ignore);
          }
        });

      const checkThenFinish = (thread: Thread, dreamId: DreamId) =>
        Effect.gen(function* () {
          if (!checkedOnce.has(dreamId)) {
            checkedOnce.add(dreamId);
            const dream = yield* store.getDream(dreamId).pipe(Effect.option);
            const serious =
              dream._tag === "None" || dream.value.status !== "running"
                ? undefined
                : yield* files.peekOutput(dream.value.workspaceId, dreamId).pipe(
                    Effect.map((output) => seriousLintProblems(lintMemory(output))),
                    Effect.orElseSucceed(() => undefined),
                  );
            if (serious !== undefined) {
              const sent = yield* runtimes
                .send(thread.id, { text: dreamCheckPrompt(serious), author: "server" })
                .pipe(
                  Effect.as(true),
                  Effect.orElseSucceed(() => false),
                );
              if (sent) return;
            }
          }
          checkedOnce.delete(dreamId);
          yield* finish(dreamId);
        });

      const onTurnEnd = (thread: Thread, end: ObservedTurnEnd) => {
        const dreamId = running.get(thread.id);
        if (dreamId === undefined) return Effect.void;
        if (end.reason === "error") {
          return fail(dreamId, "agent_error", "its agent ended the turn in an error");
        }
        return end.reason === "completed" && !end.synthesized && end.queueEmpty
          ? checkThenFinish(thread, dreamId)
          : Effect.void;
      };

      const cancelRunning = (dream: Dream, why: string) =>
        Effect.gen(function* () {
          if (dream.threadId !== undefined) {
            running.delete(dream.threadId);
            yield* runtimes.interrupt(dream.threadId).pipe(Effect.ignore);
          }
          return yield* fail(dream.id, "canceled", why);
        });

      const onHub = (event: ServerEvent) =>
        Effect.gen(function* () {
          if (event.type === "workspaces.changed") yield* onModeChanges;
          if (event.type === "thread.removed") {
            const dreamId = running.get(event.threadId);
            if (dreamId !== undefined) yield* fail(dreamId, "canceled", "its thread was closed");
            return;
          }
          if (event.type === "thread.status" && event.status === "error") {
            const dreamId = running.get(event.threadId);
            if (dreamId !== undefined) {
              yield* fail(dreamId, "agent_error", "its agent couldn't be started");
            }
            return;
          }
        });

      const preview: DreamsShape["preview"] = (input) =>
        Effect.gen(function* () {
          const state = yield* store.getWorkspace(input.workspaceId);
          const projects = yield* projectsOf(state, input.projectIds);
          const dreaming = input.kind === "dream";
          const discovery = dreaming
            ? { sessions: [], seeds: [], notes: [], worktreesCovered: 0, worktreesTotal: 0 }
            : yield* discoverHistory(importDeps, {
                projects,
                perRepo: input.perRepo,
                includeMemory: input.includeMemory,
              });
          const wanted = new Set<ProjectId>(projects.map((project) => project.id));
          const closed = (yield* store.listClosed).filter((entry) =>
            wanted.has(entry.thread.projectId),
          );
          const archived = yield* archive
            .list(state.workspace.id)
            .pipe(Effect.orElseSucceed(() => []));
          const model = (yield* store.getSettings).agents.defaultModel;
          const counted = importPreview({
            projects,
            discovery,
            closedThreadsKept: closed.length,
            archivedThreads: archived.length,
            includeMemory: input.includeMemory === true,
            throughGateway:
              model !== undefined &&
              isPinned(model) &&
              model.profileId !== undefined &&
              admittedForRole(model.agent, "dream"),
          });
          if (!dreaming) return counted;
          const version = (yield* memory
            .snapshot(state.workspace.id)
            .pipe(Effect.orElseSucceed(() => ({ version: "" })))).version;
          const planned = yield* planRecent(state, version);
          return {
            ...counted,
            notes: planned.plan.more === true ? [RECENT_MORE_NOTE] : [],
            dream: planned.plan,
          };
        });

      const dreamMachine = (
        workspace: WorkspaceState["workspace"],
        model: ModelRef,
        automatic: boolean,
      ): Effect.Effect<HostId | undefined, InvalidState> =>
        Effect.gen(function* () {
          if (hosts.elsewhere !== true) return undefined;
          if (dreamSupportFor(model.agent, { kind: "implementation" }).mode !== "confined")
            return yield* refuseOrDefer(
              automatic,
              "This Gram runs no work itself, and a memory update runs on a machine in Claude Code only. Pick a Claude Code model for it.",
            );
          const orchestrator =
            workspace.orchestratorThreadId === undefined
              ? undefined
              : yield* store
                  .getThread(workspace.orchestratorThreadId)
                  .pipe(Effect.orElseSucceed(() => undefined));
          const machine =
            orchestrator === undefined ? undefined : hostOf(effectiveCheckout(orchestrator));
          if (machine === undefined || machine === LOCAL_HOST_ID)
            return yield* refuseOrDefer(
              automatic,
              `This Gram runs no work itself, and ${workspace.name}'s orchestrator has no machine for a memory update to run on yet. Start the orchestrator, then try again.`,
            );
          return machine;
        });

      const asWorkspaceOwner =
        (workspace: WorkspaceState) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
          hosts.elsewhere !== true || workerHosts === undefined
            ? effect
            : Effect.gen(function* () {
                const id = workspace.workspace.orchestratorThreadId;
                const orchestrator =
                  id === undefined
                    ? undefined
                    : yield* store.getThread(id).pipe(Effect.orElseSucceed(() => undefined));
                if (orchestrator === undefined) return yield* effect;
                return yield* effect.pipe(
                  Effect.provideService(RoutedFor, {
                    person: workerHosts.ownerOf(hostOf(effectiveCheckout(orchestrator))),
                  }),
                  Effect.provideService(ReadingAs, SERVER),
                );
              });

      const startUnlocked = (
        input: StartDreamInput,
        scheduled = false,
      ): ReturnType<DreamsShape["start"]> =>
        Effect.gen(function* () {
          const settings = yield* store.getSettings;
          const state = yield* store.getWorkspace(input.workspaceId);
          const { workspace } = state;
          if ((yield* store.listDreams(workspace.id)).some((d) => d.status === "running")) {
            return yield* refuse(
              `A memory update is already running for ${workspace.name}. Wait for it, or cancel it first.`,
            );
          }
          if (input.model !== undefined && !admittedForRole(input.model.agent, "dream")) {
            return yield* refuse(
              `A memory update runs on ${ADMITTED.dream.join(" or ")}; ${input.model.agent} isn't admitted for one. Pick a model of one of those.`,
            );
          }
          const model = input.model ?? (yield* memoryUpdateModel(settings, hosts));
          const dreamHost = yield* dreamMachine(workspace, model, scheduled);
          const home = (yield* store.listProjects).find((p) => p.id === workspace.homeProjectId);
          if (home === undefined) {
            return yield* new NotFound({ entity: "project", id: workspace.homeProjectId });
          }

          const notes: Array<string> = [];
          const current = yield* currentMemory(workspace.id);
          const { sessions, seeds, projects, recent } = yield* gather(
            state,
            input,
            current.version,
            notes,
          );
          if (recent !== undefined && recentCount(recent) === 0) {
            return yield* refuseOrDefer(
              scheduled,
              "Nothing new since the last memory update: no worker report, merge, answered question or finished thread.",
            );
          }
          if (recent?.more === true) notes.push(RECENT_MORE_NOTE);
          if (sessions.length === 0 && current.files.length === 0) {
            return yield* refuse(
              input.kind === "import"
                ? "No past session was found to import, so there is nothing for a memory update to read."
                : "There is no memory and no transcript yet, so there is nothing to consolidate.",
            );
          }

          const dreamId = randomUUID() as DreamId;
          const outputDir = yield* files.prepare({
            workspaceId: workspace.id,
            dreamId,
            memoryVersion: current.version,
            memory: current.files,
            sessions,
            index:
              recent === undefined ? sessionIndex(sessions, notes) : recentIndex(recent, notes),
            instructions: input.instructions,
            seeds,
          });
          const threadId = randomUUID() as ThreadId;
          const instructions = input.instructions?.trim();
          const dream: Dream = {
            id: dreamId,
            workspaceId: workspace.id,
            kind: input.kind,
            mode:
              input.mode ?? (input.kind === "dream" ? memoryUpdateModeOf(state.charter) : "review"),
            status: "running",
            inputs: {
              memoryVersion: current.version,
              memoryDigest: current.digest,
              threadIds: sessions.flatMap((s) => (s.threadId === undefined ? [] : [s.threadId])),
              agentSessions: sessions.flatMap((s) =>
                s.agentSession === undefined ? [] : [s.agentSession],
              ),
              reads: sessions.flatMap((s, index) =>
                s.read === undefined
                  ? []
                  : [{ ...s.read, file: dreamSessionFileName(index, s.name) }],
              ),
              ...(recent === undefined ? {} : { recent }),
            },
            ...(instructions === undefined || instructions === "" ? {} : { instructions }),
            model,
            threadId,
            outputDir,
            createdAt: yield* Clock.currentTimeMillis,
            ...(notes.length === 0 ? {} : { notes }),
          };
          yield* orchestration
            .whileWorkspaceStays(
              workspace.id,
              Effect.gen(function* () {
                if (scheduled) {
                  const available = yield* automaticDream.modelAvailable(model);
                  const standing = yield* store.getWorkspace(workspace.id);
                  const blocked = yield* automaticDream.gate(standing);
                  if (
                    memoryUpdateRuleOf(standing.charter) === undefined ||
                    !available ||
                    blocked !== undefined ||
                    JSON.stringify(yield* memoryUpdateModel(yield* store.getSettings, hosts)) !==
                      JSON.stringify(model)
                  ) {
                    return yield* new AutomaticDreamDeferred({
                      message:
                        blocked ??
                        (!available
                          ? "Waiting for the selected memory update model to become available. Check Settings → Agents."
                          : "Automatic memory update settings changed before launch."),
                    });
                  }
                }
                yield* store.putDream(dream);
                running.set(threadId, dreamId);
                yield* runtimes
                  .create({
                    id: threadId,
                    projectRoot: home.root,
                    checkout: { kind: "main", path: outputDir },
                    title: `${input.kind === "import" ? "Import" : "Memory update"} · ${workspace.name}`,
                    model,
                    mode: "acceptEdits",
                    role: "dream",
                    ...(dreamHost === undefined ? {} : { dreamHost }),
                    workspaceId: workspace.id,
                    input: {
                      text: dreamPrompt({
                        kind: input.kind,
                        mode: dream.mode,
                        workspaceName: workspace.name,
                        sessions: sessions.length,
                        memoryFiles: current.files.length,
                        seeds: seeds.length,
                        hasInstructions: dream.instructions !== undefined,
                        repos: projects.map((project) => project.name),
                        recent: recent !== undefined,
                      }),
                      author: "server",
                    },
                  })
                  .pipe(
                    Effect.onError(() =>
                      Effect.gen(function* () {
                        running.delete(threadId);
                        yield* store.removeDream(dreamId);
                      }),
                    ),
                  );
              }),
            )
            .pipe(Effect.tapError(() => files.discard(workspace.id, dreamId).pipe(Effect.ignore)));
          yield* Effect.logInfo("dream started").pipe(
            Effect.annotateLogs({
              dreamId,
              workspaceId: workspace.id,
              kind: input.kind,
              sessions: sessions.length,
            }),
          );
          yield* dreamsChanged(workspace.id);
          return dream;
        });

      const start: DreamsShape["start"] = (input) => startLock.withPermits(1)(startUnlocked(input));
      const automaticDream = makeAutomaticDream({ store, hosts });

      const verifiedRow = (dream: Dream): Effect.Effect<Dream> =>
        dream.status !== "completed" || dream.adoptedVersion !== undefined
          ? Effect.succeed(dream)
          : Effect.gen(function* () {
              const inputs = yield* files.verifyInputs(dream.workspaceId, dream.id);
              if (!inputs.ok)
                return { ...dream, status: "failed" as const, failure: "input_tampered" as const };
              yield* files.collectOutput(dream.workspaceId, dream.id);
              return dream;
            }).pipe(
              Effect.catchTag("DreamOutputRefused", (e) =>
                Effect.succeed({ ...dream, status: "failed" as const, failure: e.failure }),
              ),
              Effect.catch(() =>
                Effect.succeed({
                  ...dream,
                  status: "failed" as const,
                  failure: "agent_error" as const,
                }),
              ),
            );

      const list: DreamsShape["list"] = (workspaceId) =>
        Effect.gen(function* () {
          yield* store.getWorkspace(workspaceId);
          return yield* Effect.flatMap(store.listDreams(workspaceId), (rows) =>
            Effect.forEach(rows, verifiedRow),
          );
        });

      const reviewOf = (dream: Dream) =>
        Effect.gen(function* () {
          const baseline = yield* files.baseline(dream.workspaceId, dream.id);
          const current = yield* currentMemory(dream.workspaceId);
          const output = yield* files.collectOutput(dream.workspaceId, dream.id);
          const made = merges.get(dream.id);
          return {
            output,
            memoryVersion: current.version,
            memoryDigest: current.digest,
            files: reviewDream({
              baseline: baseline.files,
              current: current.files,
              output: output.files,
            }).map((file): DreamFileDiff => {
              const merge = file.status === "conflict" ? made?.get(file.path) : undefined;
              return merge === undefined || merge.sides !== conflictSides(file)
                ? file
                : { ...file, merge: merge.state };
            }),
          };
        }).pipe(withAnchoredFiles);

      const review: DreamsShape["review"] = (dreamId) =>
        Effect.gen(function* () {
          const dream = yield* Effect.flatMap(store.getDream(dreamId), verifiedRow);
          if (dream.status === "running" || dream.status === "pending") {
            return yield* refuse(
              "The memory update is still running; there is nothing to review yet.",
            );
          }
          const found = yield* reviewOf(dream).pipe(
            Effect.catchTag("DreamOutputRefused", (refused) =>
              dream.status === "completed"
                ? Effect.fail(refuse(refused.message))
                : Effect.succeed(undefined),
            ),
          );
          if (found === undefined) return { dream, files: [] };
          return {
            dream,
            memoryVersion: found.memoryVersion,
            memoryDigest: found.memoryDigest,
            outputDigest: outputDigest(found.output),
            files: found.files,
            ...reportWithChecks(found.output),
          };
        }).pipe(withAnchoredFiles);

      const cancel: DreamsShape["cancel"] = (dreamId) =>
        Effect.gen(function* () {
          const dream = yield* store.getDream(dreamId);
          if (dream.status !== "running") return yield* refuse("That memory update isn't running.");
          return (
            (yield* cancelRunning(dream, "cancelled by the user")) ??
            (yield* store.getDream(dreamId))
          );
        });

      const adoptResult = (
        dreamId: DreamId,
        adoption: Parameters<DreamsShape["adopt"]>[1] = {},
        automatic = false,
      ): ReturnType<DreamsShape["adopt"]> =>
        Effect.gen(function* () {
          const dream = yield* store.getDream(dreamId);
          if (dream.adoptedVersion !== undefined) {
            return yield* refuse(
              `That memory update was already adopted as version ${dream.adoptedVersion}.`,
            );
          }
          if (dream.mode === "auto" && (!automatic || dream.adoptionFailure !== undefined)) {
            return yield* refuse(
              "This run uses automatic adoption. Its result can be inspected or discarded.",
            );
          }
          if (automatic && dream.mode !== "auto")
            return yield* refuse("Auto mode was not selected for this run.");
          if (dream.status !== "completed") {
            return yield* refuse(
              dream.status === "running"
                ? "The memory update is still running."
                : "A memory update that failed or was cancelled can't be adopted, only discarded.",
            );
          }
          const inputs = yield* files.verifyInputs(dream.workspaceId, dream.id);
          if (!inputs.ok) {
            return yield* refuse(
              `The memory update's inputs were changed after it finished (${inputs.changed.slice(0, 3).join(", ")}), so its output can't be trusted. Discard it.`,
            );
          }
          const found = yield* reviewOf(dream).pipe(
            Effect.catchTag("DreamOutputRefused", (refused) =>
              Effect.fail(refuse(refused.message)),
            ),
          );
          if (automatic && found.memoryVersion !== dream.inputs.memoryVersion) {
            return yield* refuse(
              "Memory was adopted or restored since this automatic memory update started.",
            );
          }
          if (adoption.basedOn !== undefined && adoption.basedOn !== found.memoryVersion) {
            return yield* refuse(
              `Memory was adopted or restored since this review (it is version ${found.memoryVersion || "none"} now). Review the memory update again.`,
            );
          }
          if (adoption.memoryDigest !== undefined && adoption.memoryDigest !== found.memoryDigest) {
            return yield* refuse(
              "Memory files changed since this review. Review the memory update again.",
            );
          }
          if (
            adoption.outputDigest !== undefined &&
            adoption.outputDigest !== outputDigest(found.output)
          ) {
            return yield* refuse(
              "The memory update's output was changed since this review. Review the memory update again.",
            );
          }
          const unmerged: Array<string> = [];
          const sides: Record<string, ConflictSide> = {};
          for (const file of found.files) {
            if (automatic && file.status === "conflict") {
              sides[file.path] = "current";
              continue;
            }
            const side = adoption.resolutions?.[file.path];
            if (file.status !== "conflict" || side === undefined) continue;
            if (side !== "merged") {
              sides[file.path] = side === "output" ? "dream" : "current";
              continue;
            }
            const merged = file.merge?.status === "done" ? file.merge.merged : undefined;
            if (merged === undefined) unmerged.push(file.path);
            else sides[file.path] = { merged };
          }
          if (unmerged.length > 0) {
            return yield* refuse(
              `There is no finished merge of ${unmerged.join(", ")} as memory and the memory update's output hold it now. Merge it again, or choose a side.`,
            );
          }
          const set = adoptionSet(found.files, sides);
          if (!set.ok) {
            return yield* refuse(
              `The orchestrator changed ${set.unresolved.join(", ")} after the memory update started. Choose the memory update's version or the current one for each.`,
            );
          }
          const state = yield* store.getWorkspace(dream.workspaceId);
          const reads = dream.inputs.reads ?? [];
          const written = yield* files
            .readDigests(
              dream.workspaceId,
              dream.id,
              reads.flatMap((read) => (read.file === undefined ? [] : [read.file])),
            )
            .pipe(Effect.orElseSucceed(() => new Map<string, string>()));
          const digests = new Map<ThreadId, string>();
          for (const read of reads) {
            const digest =
              read.file === undefined ? undefined : capDigest(written.get(read.file) ?? "");
            if (digest !== undefined) digests.set(read.threadId, digest);
          }
          const live = new Set<string>([
            ...(yield* store.listThreads).map((thread) => thread.id),
            ...(yield* store.listClosed).map((closed) => closed.thread.id),
            ...(yield* archive.list(dream.workspaceId).pipe(Effect.orElseSucceed(() => []))).map(
              (entry) => entry.threadId,
            ),
          ]);
          const adopted = yield* startLock.withPermits(1)(
            orchestration.whileWorkspaceStays(
              dream.workspaceId,
              rowLock.withPermits(1)(
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    const base = yield* marksOf(state, found.memoryVersion);
                    const made = yield* store.withDreamFileCommit(
                      Effect.gen(function* () {
                        const fresh = yield* store.getDream(dream.id);
                        if (
                          fresh.workspaceId !== dream.workspaceId ||
                          fresh.status !== "completed" ||
                          fresh.adoptedVersion !== undefined ||
                          fresh.mode !== dream.mode ||
                          (automatic &&
                            (fresh.threadId !== dream.threadId ||
                              fresh.adoptionFailure !== undefined))
                        ) {
                          return yield* refuse(
                            "The memory update changed before adoption could commit.",
                          );
                        }
                        if (automatic) {
                          const thread =
                            fresh.threadId === undefined
                              ? undefined
                              : yield* store
                                  .getThread(fresh.threadId)
                                  .pipe(Effect.orElseSucceed(() => undefined));
                          if (
                            thread === undefined ||
                            thread.workspaceId !== fresh.workspaceId ||
                            thread.role !== "dream" ||
                            thread.checkout.path !== fresh.outputDir
                          ) {
                            return yield* refuse(
                              "The automatic memory update no longer owns its workspace thread and output folder.",
                            );
                          }
                        }
                        return yield* memory.adopt(dream.workspaceId, set.files, {
                          basedOn: found.memoryVersion,
                          basedOnDigest: found.memoryDigest,
                          source: {
                            dreamId: dream.id,
                            mode: automatic ? "auto" : "review",
                            ...(fresh.summary === undefined ? {} : { summary: fresh.summary }),
                          },
                        });
                      }),
                    );
                    if (dream.inputs.recent !== undefined) {
                      yield* store.advanceDreamCursor(
                        dream.workspaceId,
                        cursorAfter(dream.inputs.recent),
                      );
                    }
                    yield* store.putDreamWatermarks(
                      dream.workspaceId,
                      made,
                      foldMarks(base, reads, dream.createdAt, digests).filter((mark) =>
                        live.has(mark.threadId),
                      ),
                    );
                    const changedPaths = found.files
                      .filter(
                        (file) =>
                          file.status === "added" ||
                          file.status === "changed" ||
                          file.status === "removed" ||
                          (file.status === "conflict" &&
                            sides[file.path] !== undefined &&
                            sides[file.path] !== "current"),
                      )
                      .map((file) => file.path);
                    const changed = yield* Effect.forEach(changedPaths, (path) =>
                      memory.readVersion(dream.workspaceId, made, path).pipe(
                        Effect.map((text) => ({ path, sha256: textSha(text) })),
                        Effect.orElseSucceed(() => ({ path })),
                      ),
                    );
                    const saved: Dream = {
                      ...(yield* store.getDream(dream.id)),
                      adoptedVersion: made,
                      changed,
                    };
                    yield* store.putDream(saved);
                    return saved;
                  }),
                ),
              ),
            ),
          );
          yield* memory.versions(dream.workspaceId).pipe(
            Effect.flatMap((kept) =>
              store.pruneDreamWatermarks(
                dream.workspaceId,
                kept.map((each) => each.version),
              ),
            ),
            Effect.catch((error: MemoryError) =>
              Effect.logWarning("dream watermarks of pruned versions not removed").pipe(
                Effect.annotateLogs({ workspaceId: dream.workspaceId, error: error._tag }),
              ),
            ),
          );
          yield* dropMerges(dream.id);
          yield* Effect.logInfo("dream adopted").pipe(
            Effect.annotateLogs({
              dreamId,
              workspaceId: dream.workspaceId,
              version: adopted.adoptedVersion,
              threadsRead: reads.length,
              digests: digests.size,
            }),
          );
          yield* orchestration.addNote(
            dream.workspaceId,
            `Your memory was consolidated: ${automatic ? "auto mode" : "the user"} adopted a memory update as version ${adopted.adoptedVersion}. Re-read MEMORY.md before relying on what you remember of it.`,
          );
          yield* dreamsChanged(dream.workspaceId);
          yield* hub.publish({ type: "orchestration.changed", workspaceId: dream.workspaceId });
          return adopted;
        });

      const adopt: DreamsShape["adopt"] = (dreamId, adoption) =>
        adoptionLock.withPermits(1)(adoptResult(dreamId, adoption));

      const autoAdopt = (dream: Dream, digest: string): Effect.Effect<Dream> =>
        adoptionLock
          .withPermits(1)(adoptResult(dream.id, { outputDigest: digest }, true))
          .pipe(
            Effect.catchCause((cause) =>
              rowLock
                .withPermits(1)(
                  Effect.gen(function* () {
                    const fresh = yield* store.getDream(dream.id);
                    if (fresh.adoptedVersion !== undefined) return fresh;
                    const ended: Dream = {
                      ...fresh,
                      adoptionFailure: Cause.hasInterrupts(cause)
                        ? "interrupted"
                        : Option.getOrUndefined(Cause.findErrorOption(cause))?._tag ===
                            "InvalidState"
                          ? "refused"
                          : "persistence_error",
                    };
                    yield* store.putDream(ended);
                    return ended;
                  }),
                )
                .pipe(
                  Effect.catchCause(() =>
                    Effect.succeed({
                      ...dream,
                      adoptionFailure: "persistence_error" as const,
                    }),
                  ),
                ),
            ),
          );

      const discard: DreamsShape["discard"] = (dreamId) =>
        adoptionLock.withPermits(1)(
          Effect.gen(function* () {
            const dream = yield* store.getDream(dreamId);
            if (dream.status === "running") {
              return yield* refuse("The memory update is still running. Cancel it first.");
            }
            if (dream.threadId !== undefined) {
              yield* runtimes.close(dream.threadId).pipe(Effect.ignore);
            }
            yield* dropMerges(dream.id);
            yield* files.discard(dream.workspaceId, dream.id);
            yield* store.removeDream(dream.id);
            yield* dreamsChanged(dream.workspaceId);
          }),
        );

      const runMerge = (dream: Dream, file: DreamFileDiff, started: DreamMerge) =>
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* hosts.get(dream.model.agent);
            const cwd = yield* files.mergeFolder(dream.workspaceId, dream.id);
            return yield* mergeConflict(
              {
                host,
                cwd,
                model: dream.model,
                outwardGate: outwardGateFor({
                  thread: {
                    id: `merge-${dream.id}` as ThreadId,
                    role: "dream",
                    model: dream.model,
                  },
                  workspace: undefined,
                  charter: undefined,
                }),
              },
              { path: file.path, base: file.before, output: file.after!, current: file.current! },
            );
          }),
        ).pipe(
          Effect.map((merged): DreamMerge => ({ ...started, status: "done", merged })),
          Effect.catch((error) =>
            Effect.succeed<DreamMerge>({
              ...started,
              status: "failed",
              error: error.message ?? "The merge failed.",
            }),
          ),
          Effect.flatMap((ended) =>
            Effect.gen(function* () {
              const entry = merges.get(dream.id)?.get(file.path);
              if (entry?.state !== started) return;
              entry.state = { ...ended, endedAt: yield* Clock.currentTimeMillis };
              yield* Effect.logInfo("dream merge ended").pipe(
                Effect.annotateLogs({ dreamId: dream.id, status: ended.status }),
              );
              yield* dreamsChanged(dream.workspaceId);
            }),
          ),
        );

      const merge: DreamsShape["merge"] = (dreamId, path) =>
        Effect.gen(function* () {
          const dream = yield* store.getDream(dreamId);
          if (dream.adoptedVersion !== undefined) {
            return yield* refuse(
              `That memory update was already adopted as version ${dream.adoptedVersion}.`,
            );
          }
          if (dream.status !== "completed") {
            return yield* refuse("Only a completed memory update's conflicts can be merged.");
          }
          const found = yield* reviewOf(dream).pipe(
            Effect.catchTag("DreamOutputRefused", (refused) =>
              Effect.fail(refuse(refused.message)),
            ),
          );
          const file = found.files.find((candidate) => candidate.path === path);
          if (file?.status !== "conflict") {
            return yield* refuse(`${path} isn't a conflict of this memory update's review.`);
          }
          if (file.after === undefined || file.current === undefined) {
            return yield* refuse(
              `${file.after === undefined ? "The memory update" : "The orchestrator"} removed ${path}, so there are not two versions to merge. Take the memory update's or keep memory's.`,
            );
          }
          if (file.merge?.status === "running") return file.merge;
          const started: DreamMerge = {
            status: "running",
            model: dream.model,
            startedAt: yield* Clock.currentTimeMillis,
          };
          const made =
            merges.get(dream.id) ??
            new Map<string, { readonly sides: string; state: DreamMerge }>();
          made.set(path, { sides: conflictSides(file), state: started });
          merges.set(dream.id, made);
          yield* FiberMap.run(
            mergeFibers,
            mergeKey(dream.id, path),
            runMerge(dream, file, started),
          );
          yield* dreamsChanged(dream.workspaceId);
          return started;
        });

      const revert: DreamsShape["revert"] = (dreamId) =>
        adoptionLock.withPermits(1)(
          Effect.gen(function* () {
            const dream = yield* store.getDream(dreamId);
            const made = dream.adoptedVersion;
            if (made === undefined) {
              return yield* refuse(
                "That memory update made no memory version, so there is nothing to revert.",
              );
            }
            const before = dream.inputs.memoryVersion;
            let revertedTo = "";
            if (before === "") {
              return yield* refuse(
                "That memory update made the first memory version; there is none before it to go back to.",
              );
            }
            yield* startLock.withPermits(1)(
              orchestration.whileWorkspaceStays(
                dream.workspaceId,
                Effect.gen(function* () {
                  const current = yield* currentMemory(dream.workspaceId);
                  if (current.version !== made) {
                    return yield* refuse(
                      `Memory is at version ${current.version} now, not the ${made} this update made. Restore a version from History instead.`,
                    );
                  }
                  const changed = dream.changed;
                  if (changed === undefined) {
                    return yield* refuse(
                      "This update doesn't say which notes it changed. Restore a version from History instead.",
                    );
                  }
                  const kept = yield* memory.versions(dream.workspaceId);
                  const base = kept.find((one) => one.version === made)?.basedOn ?? before;
                  if (!kept.some((one) => one.version === base)) {
                    return yield* refuse(
                      `Version ${base}, which this update was made from, is no longer kept. Restore a version from History instead.`,
                    );
                  }
                  const readOf = (version: string) =>
                    Effect.forEach(changed, ({ path }) =>
                      memory.readVersion(dream.workspaceId, version, path).pipe(
                        Effect.map((text) => [path, text] as const),
                        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
                      ),
                    ).pipe(
                      Effect.map((pairs) => new Map(pairs.filter((pair) => pair !== undefined))),
                    );
                  const set = revertSet({
                    changed,
                    before: yield* readOf(base),
                    current: current.files,
                  });
                  if (set.undone.length === 0) {
                    return yield* refuse(
                      `Every note this update changed was written again since (${set.kept.join(", ")}), so there is nothing of it left to revert.`,
                    );
                  }
                  revertedTo = yield* memory.adopt(dream.workspaceId, set.files, {
                    basedOn: current.version,
                    basedOnDigest: current.digest,
                    source: {
                      dreamId: dream.id,
                      mode: "review",
                      summary: `Reverted ${set.undone.join(", ")}${
                        set.kept.length === 0
                          ? ""
                          : `; kept ${set.kept.join(", ")}, written again since`
                      }`,
                    },
                  });
                  yield* store.putDream({
                    ...(yield* store.getDream(dreamId)),
                    revertedAt: yield* Clock.currentTimeMillis,
                  });
                }),
              ),
            );
            yield* Effect.logInfo("dream reverted").pipe(
              Effect.annotateLogs({
                dreamId,
                workspaceId: dream.workspaceId,
                from: made,
                to: revertedTo,
              }),
            );
            yield* orchestration.addNote(
              dream.workspaceId,
              `The user reverted a memory update: version ${revertedTo} puts back what version ${made} changed, keeping notes written since. Re-read MEMORY.md before relying on what you remember of it.`,
            );
            yield* dreamsChanged(dream.workspaceId);
            return dream.workspaceId;
          }),
        );

      const schedule = makeMemoryUpdateSchedule({
        store,
        discard,
        gate: automaticDream.gate,
        start: (state) =>
          startLock
            .withPermits(1)(startUnlocked({ workspaceId: state.workspace.id, kind: "dream" }, true))
            .pipe(asWorkspaceOwner(state)),
      });
      const { onModeChanges, scheduledPass, seeModes } = schedule;
      const checkSchedule = scheduledPass.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("scheduled memory updates not checked").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      );

      const threads = new Set((yield* store.listThreads).map((thread) => thread.id));
      for (const dream of yield* store.listRunningDreams) {
        if (dream.threadId !== undefined && threads.has(dream.threadId)) {
          if (dream.filesClosedAt !== undefined) {
            yield* finish(dream.id);
          } else {
            running.set(dream.threadId, dream.id);
          }
        } else {
          yield* fail(dream.id, "agent_error", "its thread was gone after a restart");
        }
      }

      for (const state of yield* store.listWorkspaces) {
        for (const dream of yield* store.listDreams(state.workspace.id)) {
          if (
            dream.mode === "auto" &&
            dream.status === "completed" &&
            dream.adoptedVersion === undefined &&
            dream.adoptionFailure === undefined &&
            dream.unchanged !== true
          ) {
            const interrupted: Dream = { ...dream, adoptionFailure: "interrupted" };
            yield* store.putDream(interrupted);
            yield* announce(interrupted, [], undefined, {
              kind: "error",
              title: "Memory update automatic adoption interrupted",
            });
          }
        }
      }

      yield* seeModes;
      yield* checkSchedule.pipe(
        Effect.repeat(Schedule.spaced(SCHEDULE_CHECK_EVERY)),
        Effect.forkScoped,
      );

      yield* Queue.take(signals).pipe(
        Effect.flatMap((signal) =>
          (signal.type === "turnEnd"
            ? onTurnEnd(signal.thread, signal.end)
            : onHub(signal.event)
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("dream signal failed").pipe(
                Effect.annotateLogs({ signal: signal.type, cause: Cause.pretty(cause) }),
              ),
            ),
          ),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* hub
        .internalEvents(
          (event) =>
            (event.type === "thread.upsert" &&
              event.thread.role === undefined &&
              event.thread.completedAt !== undefined) ||
            event.type === "dreams.changed" ||
            event.type === "orchestration.changed" ||
            event.type === "profiles.changed" ||
            event.type === "thread.removed" ||
            event.type === "workspaces.changed" ||
            (event.type === "thread.status" && event.status === "error"),
          "dreams",
        )
        .pipe(
          Stream.runForEach((event) => Queue.offer(signals, { type: "hub", event })),
          Effect.forkScoped,
        );
      yield* runtimes.observe({
        onTurnEnd: (thread, end) =>
          running.has(thread.id)
            ? Queue.offer(signals, { type: "turnEnd", thread, end }).pipe(Effect.asVoid)
            : Effect.void,
      });

      return Dreams.of({
        automaticStatus: schedule.status,
        automaticConfigurationChanged: checkSchedule,
        preview,
        start,
        list,
        review,
        cancel,
        adopt,
        merge,
        discard,
        revert,
      });
    }),
  );

/** Dreams over the server's own services. */
export const DreamsLive = makeDreamsLive();
