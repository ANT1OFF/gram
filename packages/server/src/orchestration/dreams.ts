import {
  AutomaticDreamDeferred,
  defaultDreamModel,
  makeAutomaticDream,
} from "./automatic-dream.ts";
// A dream's life: gathering what it reads, running it as a visible thread in a folder of its own,
// judging what it left behind, and the user's Adopt or Discard. The folder is `dream-files.ts`'s,
// discovery is `import.ts`'s, the words are `dream-prompt.ts`'s; this module owns the row and its
// transitions.
//
// Three invariants. **Adoption policy belongs to the user**: reviewed adoption is an RPC;
// explicit per-run auto adoption is server-owned, never an agent tool. **Nothing the
// dream could write is believed**: completion re-hashes the inputs against the manifest kept
// outside its folder, the output is read back under memory's rules, and the review is recomputed
// at adoption rather than remembered. And **a row leaves `running` exactly once**, through
// `settle`, which re-reads it under a lock, so a turn end, a closed thread, a cancel and the
// setting going off can race without a dream ending twice.
//
// A dream's cost is shown, never enforced: `usage` is what its thread reported.

import {
  DREAM_BUDGET_TOKENS_DEFAULT,
  DREAM_REPORT_EXCERPT_MAX,
  DREAM_SESSIONS_MAX,
  InvalidState,
  NotFound,
  type AgentUnavailable,
  type AutomaticDreamStatus,
  type Dream,
  type DreamAgentSession,
  type DreamBacklog,
  type DreamFailure,
  type DreamFileDiff,
  type DreamId,
  type DreamRead,
  type DreamWatermark,
  type DreamKind,
  type DreamMode,
  type DreamMerge,
  type DreamPlan,
  type DreamReport,
  type DreamResolution,
  type DreamReview,
  type FsError,
  type ImportPreview,
  type ModelRef,
  type Project,
  type ProjectId,
  type ServerEvent,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceState,
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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { createHash, randomUUID } from "node:crypto";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore, type MessageMark } from "../persistence/thread-store.ts";
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
import { dreamPrompt } from "./dream-prompt.ts";
import {
  DELTA_CONTEXT_MESSAGES,
  capDigest,
  fillBudget,
  foldMarks,
  revThrough,
  selectDelta,
  takeOldest,
} from "./dream-reads.ts";
import { discoverHistory, importPreview, type ImportDeps } from "./import.ts";
import {
  OrchestrationMemory,
  memorySnapshotDigest,
  type MemoryError,
  type MemorySetFile,
} from "./memory.ts";
import { ADMITTED, admittedForRole, outwardGateFor } from "./rules.ts";
import { Orchestration } from "./service.ts";
import {
  blocksOf,
  estimateTokens,
  fromStoredMessages,
  parseArchived,
  renderDelta,
  renderTranscript,
  TRANSCRIPT_CONTEXT_MAX_CHARS,
  TRANSCRIPT_MAX_CHARS,
  type TranscriptBlock,
} from "./transcripts.ts";

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
  /** Closes the dream's thread if it is still there, and deletes its folder, manifest and row. */
  discard(dreamId: DreamId): Effect.Effect<void, NotFound | InvalidState | FsError>;
}

export class Dreams extends Context.Service<Dreams, DreamsShape>()("@gram/server/Dreams") {}

/** What the consumer fiber works through, one at a time, in the order things happened. */
type Signal =
  | { readonly type: "turnEnd"; readonly thread: Thread; readonly end: ObservedTurnEnd }
  | { readonly type: "hub"; readonly event: ServerEvent };

const refuse = (message: string) => new InvalidState({ message });

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** One transcript on its way into a dream, with what orders it and what the row remembers of it. */
interface Gathered extends DreamSessionFile {
  /** Epoch ms of its last activity; 0 when nothing says. */
  readonly at: number;
  readonly threadId?: ThreadId;
  readonly agentSession?: DreamAgentSession;
  /** How far a Gram thread was read; its file name is given once the order is known. */
  readonly read?: Omit<DreamRead, "file">;
  /** New messages of it left for the next dream, past what one file holds. */
  readonly left?: number;
}

/** One thread's unread part, taken from the live thread or its archive. */
export interface Unread {
  readonly threadId: ThreadId;
  readonly source: DreamRead["source"];
  readonly title: string;
  /** The `Source:` line. */
  readonly sourceLine: string;
  /** Epoch ms of its last activity. */
  readonly at: number;
  /** The new messages that render to something, in seq order. */
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  /** The consolidated messages quoted ahead of them; absent when nothing of it was consolidated. */
  readonly earlier: ReadonlyArray<TranscriptBlock> | undefined;
  /** Every message selected as new, those that render to nothing included. */
  readonly read: ReadonlyArray<MessageMark>;
  readonly marks: ReadonlyArray<MessageMark>;
  readonly held: DreamWatermark | undefined;
  /** An archived transcript from before anchors, which can only be read whole. */
  readonly whole?: string;
  /** It was rewound below `held`: what was consolidated of it, digest included, no longer holds. */
  readonly rewound?: boolean;
  /**
   * Whether it is the dreaming workspace's own orchestrator, open or archived: another workspace
   * sharing a project has one too, and it doesn't come first here.
   */
  readonly ownOrchestrator: boolean;
}

/**
 * A fingerprint of a dream's candidate memory, so an adoption can tell the output the user
 * reviewed from one rewritten since: the dream's thread stays open after it completes, and one
 * more turn in it may write `output/` again.
 */
const outputDigest = (output: DreamOutput): string => {
  const hash = createHash("sha256");
  for (const file of output.files.toSorted((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${file.path}\0${file.content.length}\0${file.content}\0`, "utf8");
  }
  return hash.digest("hex");
};

/** The `data-dream-report` card of a dream that has ended. */
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

/**
 * A fingerprint of the three sides of a conflict, which a merge belongs to: a live write or a
 * rewritten output since makes it a merge of something else, so it is no longer offered.
 */
const conflictSides = (file: DreamFileDiff): string =>
  createHash("sha256")
    .update(JSON.stringify([file.before ?? null, file.after ?? null, file.current ?? null]), "utf8")
    .digest("hex");

const mergeKey = (dreamId: DreamId, path: string) => `${dreamId}\0${path}`;

/** `≈80k tokens`: a count of `estimateTokens`, rounded as the estimate deserves. */
const tokensText = (tokens: number): string =>
  `≈${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} tokens`;

/** `12 threads (340 new messages, ≈80k tokens)`. */
const backlogText = (backlog: DreamBacklog): string =>
  `${plural(backlog.threads, "thread")} (${
    backlog.messages === 0 ? "" : `${plural(backlog.messages, "new message")}, `
  }${tokensText(backlog.estimatedTokens)})`;

const WORKER_REPORT = "[worker report ·";

/**
 * The order unread parts are offered to the budget, and the order the dream reads them in: the
 * orchestrator's own thread first, which is where decisions are made, then workers that reported,
 * then the rest; within each, the oldest new message first, so a backlog drains in the order it
 * built up and a later decision is read after the one it supersedes.
 */
export const readingOrder = (unread: ReadonlyArray<Unread>): ReadonlyArray<Unread> => {
  const tier = (one: Unread) =>
    one.ownOrchestrator
      ? 0
      : one.blocks.some((block) => block.body.includes(WORKER_REPORT)) ||
          one.whole?.includes(WORKER_REPORT) === true
        ? 1
        : 2;
  const oldest = (one: Unread) => one.blocks[0]?.at ?? one.at;
  return unread.toSorted((a, b) => tier(a) - tier(b) || oldest(a) - oldest(b));
};

/**
 * The digest an unread part is given: its mark's, when some of the thread was consolidated before
 * it and the thread wasn't rewound below the mark since.
 */
export const digestOf = (unread: Unread): string | undefined =>
  unread.earlier === undefined || unread.rewound === true ? undefined : unread.held?.digest;

/** What a header's message range and dates can grow by past those of a file's first message. */
const DELTA_RANGE_SLACK = 32;

/** The header of an archived transcript: everything before the line that opens its record. */
export const archiveHeader = (text: string): string => {
  const end = text.indexOf("\nA record of a past conversation.");
  return end === -1 ? "" : text.slice(0, end);
};

/** Room in one session file for the new messages, besides its header and context. */
const DELTA_MAX_CHARS = TRANSCRIPT_MAX_CHARS - 4 * TRANSCRIPT_CONTEXT_MAX_CHARS;

/**
 * An unread part as the file a dream reads, with how far that takes its watermark. Past
 * `maxChars` only the oldest of the new messages are taken, at least one: the mark ends on the last
 * taken, so the rest wait for the next dream rather than being cut from the middle.
 */
const gatheredOf = (unread: Unread, maxChars = DELTA_MAX_CHARS): Gathered => {
  if (unread.whole !== undefined) {
    const held = unread.held;
    return {
      name: unread.title,
      text: unread.whole,
      at: unread.at,
      threadId: unread.threadId,
      read: {
        threadId: unread.threadId,
        source: unread.source,
        fromSeq: 0,
        throughSeq: held?.throughSeq ?? 0,
        ...(held?.throughId === undefined ? {} : { throughId: held.throughId }),
        ...(held?.throughRev === undefined ? {} : { throughRev: held.throughRev }),
        messages: 0,
        estimatedTokens: estimateTokens(unread.whole),
      },
    };
  }
  const { count, through } = takeOldest(unread.blocks, unread.read, maxChars);
  const blocks = unread.blocks.slice(0, count);
  const rev = Math.max(revThrough(unread.marks, through.seq) ?? 0, unread.held?.throughRev ?? 0);
  const text = renderDelta({
    title: unread.title,
    source: unread.sourceLine,
    blocks,
    earlier: unread.earlier,
    digest: digestOf(unread),
    left: unread.blocks.length - count,
  });
  return {
    name: unread.title,
    text,
    at: unread.at,
    threadId: unread.threadId,
    read: {
      threadId: unread.threadId,
      source: unread.source,
      fromSeq: unread.read[0]!.seq,
      throughSeq: through.seq,
      throughId: through.id,
      ...(rev === 0 ? {} : { throughRev: rev }),
      messages: blocks.length,
      estimatedTokens: estimateTokens(text),
      ...(unread.rewound === true ? { rewound: true } : {}),
    },
    left: unread.blocks.length - count,
  };
};

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
      // Absent in runtime-only layers, where an import asks for each project's root alone.
      const worktrees = Option.getOrUndefined(yield* Effect.serviceOption(Worktrees));
      const importDeps: ImportDeps = {
        hosts,
        worktrees,
        ...(options.claudeConfigDirs === undefined
          ? {}
          : { claudeConfigDirs: options.claudeConfigDirs }),
      };

      const signals = yield* Queue.unbounded<Signal>();
      /** Two starts for one workspace must not both find it free. */
      const startLock = yield* Semaphore.make(1);
      /** Serialises every transition of a dream's row. */
      const rowLock = yield* Semaphore.make(1);
      /** Serialises adoption and discard, including duplicate user requests. */
      const adoptionLock = yield* Semaphore.make(1);
      /** The running dreams by the thread each runs as: what a turn end is looked up in. */
      const running = new Map<ThreadId, DreamId>();
      /**
       * The merges asked for, by dream and path, with the sides each read. Held here and nowhere
       * else, so an adoption's `merged` can only take a text the server made: a restart forgets
       * them, and the user merges again.
       */
      const merges = new Map<DreamId, Map<string, { readonly sides: string; state: DreamMerge }>>();
      const mergeFibers = yield* FiberMap.make<string>();
      /** Forgets a dream's merges and stops the ones still running. */
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

      // -------------------------------------------------------------------------------------
      // Gathering (inputs are files)
      // -------------------------------------------------------------------------------------

      /** What of an open thread is past `held`, its watermark; `undefined` when nothing is. */
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
          const blocks = blocksOf(fromStoredMessages(rows.filter((row) => wanted.has(row.seq))));
          if (blocks.length === 0) return undefined;
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
          };
        });

      /**
       * What of an archived transcript is past `held`, by its anchors. One from before anchors is
       * read whole, unless it was archived no later than its mark was read.
       */
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
            // The archive is the workspace's own, so an orchestrator archived there was its own.
            // Only the header says what the thread was; a message may quote a `Source:` line.
            ownOrchestrator: /^Source: orchestrator thread /m.test(archiveHeader(text)),
          };
          const parsed = parseArchived(text);
          if (parsed === undefined) {
            // Read whole once: archived no later than its mark was read, it holds nothing new.
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

      /** The watermarks of memory `version`; none for a version no dream consolidated. */
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
            agentSession: {
              agent: session.agent,
              cwd: session.cwd,
              agentSessionId: session.agentSessionId,
            },
          };
        });

      /**
       * What a `dream` reads of `projects`' threads and the archive: what is past the watermarks of
       * memory `version`, offered to the budget in reading order (`readingOrder`) and filled by
       * `fillBudget`. What doesn't fit keeps its watermark, so it is the next dream's to read, and
       * is counted as the backlog.
       */
      const planDream = (
        state: WorkspaceState,
        version: string,
        projects: ReadonlyArray<Project>,
        budgetTokens: number,
      ) =>
        Effect.gen(function* () {
          const held = new Map(
            (yield* marksOf(state, version)).map((mark) => [mark.threadId, mark]),
          );
          const unread: Array<Unread> = [];
          const wanted = new Set<ProjectId>(projects.map((project) => project.id));
          const open = new Set<string>();
          for (const thread of yield* store.listThreads) {
            open.add(thread.id);
            if (!wanted.has(thread.projectId) || thread.role === "dream") continue;
            const one = yield* unreadOfThread(thread, held.get(thread.id), state.workspace.id);
            if (one !== undefined) unread.push(one);
          }
          const archived = yield* archive
            .list(state.workspace.id)
            .pipe(Effect.orElseSucceed(() => []));
          for (const entry of archived) {
            // A reopened thread is read where it lives now.
            if (open.has(entry.threadId)) continue;
            const one = yield* unreadOfArchive(
              state.workspace.id,
              entry,
              held.get(entry.threadId as ThreadId),
            );
            if (one !== undefined) unread.push(one);
          }
          const ordered = readingOrder(unread);
          const fill = fillBudget(
            ordered.map((one) => ({
              blocks: one.blocks,
              ...(one.whole === undefined
                ? {
                    // The header, the quoted context and the range lines each file is written with:
                    // rendered as for its first message alone with a `Later:` line, its body empty,
                    // since the bodies are what `fillBudget` counts itself.
                    overheadChars:
                      renderDelta({
                        title: one.title,
                        source: one.sourceLine,
                        blocks: one.blocks.slice(0, 1).map((block) => ({ ...block, body: "" })),
                        earlier: one.earlier,
                        digest: digestOf(one),
                        left: one.blocks.length > 1 ? one.blocks.length : 0,
                      }).length + DELTA_RANGE_SLACK,
                  }
                : { wholeChars: one.whole.length }),
            })),
            { budgetTokens, fileChars: DELTA_MAX_CHARS, maxFiles: DREAM_SESSIONS_MAX },
          );
          const sessions = fill.taken.map(({ index, maxChars }) =>
            gatheredOf(ordered[index]!, maxChars),
          );
          const backlog: DreamBacklog = {
            threads: fill.left.length,
            messages: fill.left.reduce((sum, one) => sum + one.messages, 0),
            estimatedTokens: fill.left.reduce((sum, one) => sum + one.tokens, 0),
          };
          const plan: DreamPlan = {
            memoryVersion: version,
            fromStart: held.size === 0,
            threads: sessions.length,
            messages: sessions.reduce((sum, one) => sum + (one.read?.messages ?? 0), 0),
            estimatedTokens: sessions.reduce(
              (sum, one) => sum + (one.read?.estimatedTokens ?? 0),
              0,
            ),
            budgetTokens,
            backlog,
          };
          const notes =
            backlog.threads === 0
              ? []
              : [
                  `${backlogText(backlog)} left for the next dream, past this one's budget of ${tokensText(budgetTokens)}. Their watermarks stay where they are, so the next dream reads them.`,
                ];
          return { sessions, plan, notes };
        });

      /**
       * The transcripts a dream reads. An explicit selection is read whole. Without one, an
       * `import` reads what discovery found, and a `dream` what of the workspace's threads and
       * archived transcripts is past the watermarks of the memory version it starts from: what that
       * memory has not consolidated yet.
       */
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
                  `${thread.title} is not a thread of ${state.workspace.name}'s projects, so a dream there doesn't read it.`,
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
            const planned = yield* planDream(
              state,
              version,
              projects,
              input.budgetTokens ?? DREAM_BUDGET_TOKENS_DEFAULT,
            );
            notes.push(...planned.notes);
            return { sessions: planned.sessions, seeds, projects, plan: planned.plan };
          }

          const newestFirst = [...gathered, ...unread.map((one) => gatheredOf(one))].toSorted(
            (a, b) => b.at - a.at,
          );
          const cut = newestFirst
            .slice(0, DREAM_SESSIONS_MAX)
            .filter((one) => (one.left ?? 0) > 0).length;
          if (cut > 0) {
            notes.push(
              `${plural(cut, "thread")} had more new messages than one file holds: the oldest of them were read, and their watermarks stop there, so the next dream reads on.`,
            );
          }
          const left = newestFirst.slice(DREAM_SESSIONS_MAX);
          if (left.length > 0) {
            notes.push(
              left.every((one) => one.read !== undefined)
                ? `${plural(left.length, "older thread")} with new messages left for the next dream: one reads at most ${DREAM_SESSIONS_MAX}, and their watermarks stay where they are.`
                : `${plural(left.length, "older session")} left out: a dream reads at most ${DREAM_SESSIONS_MAX}.`,
            );
          }
          return {
            sessions: newestFirst.slice(0, DREAM_SESSIONS_MAX),
            seeds,
            projects,
            plan: undefined,
          };
        });

      // -------------------------------------------------------------------------------------
      // Transitions
      // -------------------------------------------------------------------------------------

      /**
       * Takes a dream out of `running`, once. `next` is asked with the row as it is now, since a
       * closed thread has already had its `threadId` cleared by the store. `undefined` when the
       * dream had already ended, or is gone.
       */
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

      /** The card in the dream's own thread, and the word to everyone watching the workspace. */
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
            title: canceled ? "Dream cancelled" : `Dream failed: ${why}`,
          });
          return ended;
        });

      /**
       * Drain already authorized file operations and revoke staged/new ones before validation.
       * Match settlement's row -> store lock order. Release both before filesystem reads or
       * runtime actions, so cancellation can still win while validation is in progress.
       */
      const closeFiles = (dreamId: DreamId) =>
        rowLock.withPermits(1)(
          store.withDreamFileCommit(
            Effect.gen(function* () {
              const dream = yield* store
                .getDream(dreamId)
                .pipe(Effect.orElseSucceed(() => undefined));
              if (dream === undefined || dream.status !== "running") return undefined;
              // Closure is durable authority revocation, not proof that validation settled.
              // Reuse it on recovery without granting the agent file access again.
              if (dream.filesClosedAt !== undefined) return dream;
              const closed = { ...dream, filesClosedAt: yield* Clock.currentTimeMillis };
              yield* store.putDream(closed);
              return closed;
            }),
          ),
        );

      /** The dream said it is done. Whether it is, is for the manifest and the caps to say. */
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
          const completed = yield* settle(dreamId, (current, now) => ({
            ...current,
            status: "completed",
            endedAt: now,
            ...(usage === undefined ? {} : { usage }),
          }));
          if (completed === undefined) return;
          const ended =
            completed.mode === "auto"
              ? yield* autoAdopt(completed, outputDigest(verdict.output))
              : completed;
          yield* announce(ended, verdict.review, verdict.output.report, {
            kind: ended.adoptionFailure === undefined ? "done" : "error",
            title:
              ended.mode !== "auto"
                ? "Dream finished — review it"
                : ended.adoptedVersion !== undefined
                  ? "Dream automatically adopted"
                  : "Dream automatic adoption stopped",
          });
        });

      const onTurnEnd = (thread: Thread, end: ObservedTurnEnd) => {
        const dreamId = running.get(thread.id);
        if (dreamId === undefined) return Effect.void;
        if (end.reason === "error") {
          return fail(dreamId, "agent_error", "its agent ended the turn in an error");
        }
        // Only the adapter's own `completed` with nothing queued behind it is the dream saying
        // `done`. An interrupt is the user's, who may steer it and let it go on; a synthesized end
        // is the host giving up on a turn, not the agent finishing one.
        return end.reason === "completed" && !end.synthesized && end.queueEmpty
          ? finish(dreamId)
          : Effect.void;
      };

      const cancelRunning = (dream: Dream, why: string) =>
        Effect.gen(function* () {
          if (dream.threadId !== undefined) {
            // Forgotten first, so the interrupted turn's end isn't read as the dream's own.
            running.delete(dream.threadId);
            yield* runtimes.interrupt(dream.threadId).pipe(Effect.ignore);
          }
          return yield* fail(dream.id, "canceled", why);
        });

      const onHub = (event: ServerEvent) =>
        Effect.gen(function* () {
          if (event.type === "thread.upsert") {
            if (
              (yield* store.listWorkspaces).some(
                (w) => w.charter.automaticDreamThreshold !== undefined,
              )
            ) {
              yield* startLock.withPermits(1)(automaticDream.onCompletion(event.thread));
            }
            return;
          }
          if (event.type === "dreams.changed") {
            if ((yield* store.getAutomaticDreamState(event.workspaceId)) !== undefined) {
              yield* startLock.withPermits(1)(
                automaticDream.onDreamChanged(event.workspaceId, true),
              );
            }
            return;
          }
          if (
            event.type === "workspaces.changed" ||
            event.type === "orchestration.changed" ||
            event.type === "profiles.changed"
          ) {
            if (
              (yield* store.listWorkspaces).some(
                (w) => w.charter.automaticDreamThreshold !== undefined,
              )
            ) {
              yield* startLock.withPermits(1)(automaticDream.onConfiguration);
            }
          }
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

      // -------------------------------------------------------------------------------------
      // The user's calls
      // -------------------------------------------------------------------------------------

      const preview: DreamsShape["preview"] = (input) =>
        Effect.gen(function* () {
          const state = yield* store.getWorkspace(input.workspaceId);
          const projects = yield* projectsOf(state, input.projectIds);
          const dreaming = input.kind === "dream";
          // A dream reads Gram's own threads, so the agents' histories aren't searched.
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
            throughGateway: model?.profileId !== undefined && admittedForRole(model.agent, "dream"),
          });
          if (!dreaming) return counted;
          const version = (yield* memory
            .snapshot(state.workspace.id)
            .pipe(Effect.orElseSucceed(() => ({ version: "" })))).version;
          const planned = yield* planDream(
            state,
            version,
            projects,
            input.budgetTokens ?? DREAM_BUDGET_TOKENS_DEFAULT,
          );
          return {
            ...counted,
            notes: [...planned.notes, ...counted.notes],
            dream: planned.plan,
          };
        });

      const startUnlocked = (
        input: StartDreamInput,
        automaticThreshold?: number,
        automaticClaim?: string,
      ): ReturnType<DreamsShape["start"]> =>
        Effect.gen(function* () {
          const settings = yield* store.getSettings;
          const state = yield* store.getWorkspace(input.workspaceId);
          const { workspace } = state;
          if ((yield* store.listDreams(workspace.id)).some((d) => d.status === "running")) {
            return yield* refuse(
              `A dream is already running for ${workspace.name}. Wait for it, or cancel it first.`,
            );
          }
          if (input.model !== undefined && !admittedForRole(input.model.agent, "dream")) {
            return yield* refuse(
              `A dream runs on ${ADMITTED.dream.join(" or ")}; ${input.model.agent} isn't admitted for one. Pick a model of one of those.`,
            );
          }
          const model = input.model ?? (yield* defaultDreamModel(settings, hosts));
          const home = (yield* store.listProjects).find((p) => p.id === workspace.homeProjectId);
          if (home === undefined) {
            return yield* new NotFound({ entity: "project", id: workspace.homeProjectId });
          }

          const notes: Array<string> = [];
          const current = yield* currentMemory(workspace.id);
          const { sessions, seeds, projects, plan } = yield* gather(
            state,
            input,
            current.version,
            notes,
          );
          if (sessions.length === 0 && current.files.length === 0) {
            return yield* refuse(
              input.kind === "import"
                ? "No past session was found to import, so there is nothing for a dream to read."
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
            instructions: input.instructions,
            seeds,
          });
          const threadId = randomUUID() as ThreadId;
          const instructions = input.instructions?.trim();
          const dream: Dream = {
            id: dreamId,
            workspaceId: workspace.id,
            kind: input.kind,
            mode: input.mode ?? "review",
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
            },
            ...(instructions === undefined || instructions === "" ? {} : { instructions }),
            model,
            threadId,
            outputDir,
            createdAt: yield* Clock.currentTimeMillis,
            ...(notes.length === 0 ? {} : { notes }),
            ...(plan === undefined
              ? {}
              : { budgetTokens: plan.budgetTokens, backlog: plan.backlog }),
          };
          // Made where a removal can't come between: the workspace could otherwise go after it
          // was read here, and leave this dream's row, or its thread, with no workspace to end in.
          yield* orchestration
            .whileWorkspaceStays(
              workspace.id,
              Effect.gen(function* () {
                if (automaticThreshold !== undefined) {
                  const available = yield* automaticDream.modelAvailable(model);
                  const standing = yield* store.getWorkspace(workspace.id);
                  const blocked = yield* automaticDream.gate(standing);
                  const schedule = yield* store.getAutomaticDreamState(workspace.id);
                  if (
                    schedule?.lastAttemptId !== automaticClaim ||
                    standing.charter.automaticDreamThreshold !== automaticThreshold ||
                    !available ||
                    blocked !== undefined ||
                    JSON.stringify(yield* defaultDreamModel(yield* store.getSettings, hosts)) !==
                      JSON.stringify(model)
                  ) {
                    return yield* new AutomaticDreamDeferred({
                      message:
                        blocked ??
                        (!available
                          ? "Waiting for the selected Dream model to become available. Check Settings → Agents."
                          : "Automatic Dream settings changed before launch."),
                    });
                  }
                }
                // The row and the lookup exist before the thread does, so a turn that ends at
                // once is still this dream's.
                yield* store.putDream(dream);
                running.set(threadId, dreamId);
                // The dream's folder is not a git repository. A thread in a plain folder is a
                // `main` checkout with no branch, which is all `CheckoutService` makes of one too,
                // so the runtime is asked directly: there is no worktree to prepare and no guard
                // to take. It is filed under the workspace's home project rather than given one
                // of its own, which `create` would otherwise make for the dream's folder.
                yield* runtimes
                  .create({
                    id: threadId,
                    projectRoot: home.root,
                    checkout: { kind: "main", path: outputDir },
                    title: `${input.kind === "import" ? "Import" : "Dream"} · ${workspace.name}`,
                    model,
                    // Keep normal sandbox and approvals. The runtime selects file-only
                    // tools or guided native permissions through the shared Dream decision.
                    mode: "acceptEdits",
                    role: "dream",
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
          yield* automaticDream.consume(state, undefined, dream.id);
          yield* dreamsChanged(workspace.id);
          return dream;
        });

      const start: DreamsShape["start"] = (input) => startLock.withPermits(1)(startUnlocked(input));
      const automaticDream = makeAutomaticDream({
        store,
        hosts,
        archive,
        changed: dreamsChanged,
        start: (workspaceId, model, threshold, claim) =>
          startUnlocked({ workspaceId, kind: "dream", model }, threshold, claim),
      });

      // Revalidate old ready rows on read without rewriting their persisted run or transcript.
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

      /** The review, with each conflict's merge where it was made of the sides the review holds now. */
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
        });

      const review: DreamsShape["review"] = (dreamId) =>
        Effect.gen(function* () {
          const dream = yield* Effect.flatMap(store.getDream(dreamId), verifiedRow);
          if (dream.status === "running" || dream.status === "pending") {
            return yield* refuse("The dream is still running; there is nothing to review yet.");
          }
          const found = yield* reviewOf(dream).pipe(
            // A failed or cancelled dream's leftovers may be no memory at all. It is shown as it
            // is, which is nothing to adopt, rather than as an error.
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
            ...(found.output.report === undefined ? {} : { report: found.output.report }),
          };
        });

      const cancel: DreamsShape["cancel"] = (dreamId) =>
        Effect.gen(function* () {
          const dream = yield* store.getDream(dreamId);
          if (dream.status !== "running") return yield* refuse("That dream isn't running.");
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
              `That dream was already adopted as version ${dream.adoptedVersion}.`,
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
                ? "The dream is still running."
                : "A dream that failed or was cancelled can't be adopted, only discarded.",
            );
          }
          // Hashed again here as at completion: the folder has been the agent's to write since.
          const inputs = yield* files.verifyInputs(dream.workspaceId, dream.id);
          if (!inputs.ok) {
            return yield* refuse(
              `The dream's inputs were changed after it finished (${inputs.changed.slice(0, 3).join(", ")}), so its output can't be trusted. Discard it.`,
            );
          }
          const found = yield* reviewOf(dream).pipe(
            Effect.catchTag("DreamOutputRefused", (refused) =>
              Effect.fail(refuse(refused.message)),
            ),
          );
          if (automatic) {
            if (
              found.memoryVersion !== dream.inputs.memoryVersion ||
              found.memoryDigest !== dream.inputs.memoryDigest
            ) {
              return yield* refuse("Memory changed since this automatic dream started.");
            }
          }
          if (adoption.basedOn !== undefined && adoption.basedOn !== found.memoryVersion) {
            return yield* refuse(
              `Memory was adopted or restored since this review (it is version ${found.memoryVersion || "none"} now). Review the dream again.`,
            );
          }
          if (adoption.memoryDigest !== undefined && adoption.memoryDigest !== found.memoryDigest) {
            return yield* refuse("Memory files changed since this review. Review the dream again.");
          }
          if (
            adoption.outputDigest !== undefined &&
            adoption.outputDigest !== outputDigest(found.output)
          ) {
            return yield* refuse(
              "The dream's output was changed since this review. Review the dream again.",
            );
          }
          const unmerged: Array<string> = [];
          const sides: Record<string, ConflictSide> = {};
          for (const file of found.files) {
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
              `There is no finished merge of ${unmerged.join(", ")} as memory and the dream's output hold it now. Merge it again, or choose a side.`,
            );
          }
          const set = adoptionSet(found.files, sides);
          if (!set.ok) {
            return yield* refuse(
              `The orchestrator changed ${set.unresolved.join(", ")} after the dream started. Choose the dream's version or the current one for each.`,
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
          // A mark, and the digest with it, goes with its thread: one open, closed or archived
          // nowhere any more is not carried into the new version.
          const live = new Set<string>([
            ...(yield* store.listThreads).map((thread) => thread.id),
            ...(yield* store.listClosed).map((closed) => closed.thread.id),
            ...(yield* archive.list(dream.workspaceId).pipe(Effect.orElseSucceed(() => []))).map(
              (entry) => entry.threadId,
            ),
          ]);
          // Under the lock a start gathers by, so no dream starts from the new version before its
          // marks are written, and no second adoption folds onto a version still without them.
          const adopted = yield* startLock.withPermits(1)(
            orchestration.whileWorkspaceStays(
              dream.workspaceId,
              rowLock.withPermits(1)(
                Effect.uninterruptible(
                  Effect.gen(function* () {
                    const base = yield* marksOf(state, found.memoryVersion);
                    const made = yield* store.withDreamFileCommit(
                      Effect.gen(function* () {
                        // Re-read under the transaction before memory is touched: deletion, rebind and
                        // duplicate completions cannot reuse an earlier row's authority.
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
                          return yield* refuse("The dream changed before adoption could commit.");
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
                              "The automatic dream no longer owns its workspace thread and output folder.",
                            );
                          }
                        }
                        return yield* memory.adopt(dream.workspaceId, set.files, {
                          basedOn: found.memoryVersion,
                          basedOnDigest: found.memoryDigest,
                        });
                      }),
                    );
                    yield* store.putDreamWatermarks(
                      dream.workspaceId,
                      made,
                      foldMarks(base, reads, dream.createdAt, digests).filter((mark) =>
                        live.has(mark.threadId),
                      ),
                    );
                    const saved: Dream = {
                      ...(yield* store.getDream(dream.id)),
                      adoptedVersion: made,
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
            `Your memory was consolidated: ${automatic ? "auto mode" : "the user"} adopted a dream as version ${adopted.adoptedVersion}. Re-read MEMORY.md before relying on what you remember of it.`,
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
              return yield* refuse("The dream is still running. Cancel it first.");
            }
            // Its thread's cwd is the folder about to go, so the thread goes first.
            if (dream.threadId !== undefined) {
              yield* runtimes.close(dream.threadId).pipe(Effect.ignore);
            }
            yield* dropMerges(dream.id);
            yield* files.discard(dream.workspaceId, dream.id);
            yield* store.removeDream(dream.id);
            yield* dreamsChanged(dream.workspaceId);
          }),
        );

      /** Runs one merge to its end and records it, unless a newer one for the file replaced it. */
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
                // The gate a dream on this agent opens with: the merge reads the same memory.
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
              // Whether it worked, never the text or the reason: both can quote memory.
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
              `That dream was already adopted as version ${dream.adoptedVersion}.`,
            );
          }
          if (dream.status !== "completed") {
            return yield* refuse("Only a completed dream's conflicts can be merged.");
          }
          const found = yield* reviewOf(dream).pipe(
            Effect.catchTag("DreamOutputRefused", (refused) =>
              Effect.fail(refuse(refused.message)),
            ),
          );
          const file = found.files.find((candidate) => candidate.path === path);
          if (file?.status !== "conflict") {
            return yield* refuse(`${path} isn't a conflict of this dream's review.`);
          }
          if (file.after === undefined || file.current === undefined) {
            return yield* refuse(
              `${file.after === undefined ? "The dream" : "The orchestrator"} removed ${path}, so there are not two versions to merge. Take the dream's or keep memory's.`,
            );
          }
          if (file.merge?.status === "running") return file.merge;
          const started: DreamMerge = {
            status: "running",
            model: dream.model,
            startedAt: yield* Clock.currentTimeMillis,
          };
          const made = merges.get(dream.id) ?? new Map();
          made.set(path, { sides: conflictSides(file), state: started });
          merges.set(dream.id, made);
          // Keyed by file, so asking again interrupts the merge it replaces.
          yield* FiberMap.run(
            mergeFibers,
            mergeKey(dream.id, path),
            runMerge(dream, file, started),
          );
          yield* dreamsChanged(dream.workspaceId);
          return started;
        });

      // After a restart: a dream whose thread is still there carries on when its thread does; one
      // whose thread is gone can never say `done`.
      const threads = new Set((yield* store.listThreads).map((thread) => thread.id));
      for (const dream of yield* store.listRunningDreams) {
        if (dream.threadId !== undefined && threads.has(dream.threadId)) {
          if (dream.filesClosedAt !== undefined) {
            // Its agent already ended: resume server validation, never a provider turn.
            yield* finish(dream.id);
          } else {
            running.set(dream.threadId, dream.id);
          }
        } else {
          yield* fail(dream.id, "agent_error", "its thread was gone after a restart");
        }
      }

      // Completion persisted before adoption is attempted. Do not replay an interrupted
      // automatic write after restart: CURRENT may already have switched before a DB failure.
      for (const state of yield* store.listWorkspaces) {
        for (const dream of yield* store.listDreams(state.workspace.id)) {
          if (
            dream.mode === "auto" &&
            dream.status === "completed" &&
            dream.adoptedVersion === undefined &&
            dream.adoptionFailure === undefined
          ) {
            const interrupted: Dream = { ...dream, adoptionFailure: "interrupted" };
            yield* store.putDream(interrupted);
            yield* announce(interrupted, [], undefined, {
              kind: "error",
              title: "Dream automatic adoption interrupted",
            });
          }
        }
      }

      yield* automaticDream.recover;

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
      // The runtime's callbacks share one fiber, so this only hands the news to the queue.
      yield* runtimes.observe({
        onTurnEnd: (thread, end) =>
          running.has(thread.id)
            ? Queue.offer(signals, { type: "turnEnd", thread, end }).pipe(Effect.asVoid)
            : Effect.void,
      });

      return Dreams.of({
        // A status read must not expose the transient spent claim while start admission
        // is still deciding whether to launch or restore a proven deferral.
        automaticStatus: (workspaceId) =>
          startLock.withPermits(1)(automaticDream.status(workspaceId)),
        automaticConfigurationChanged: startLock.withPermits(1)(automaticDream.onConfiguration),
        preview,
        start,
        list,
        review,
        cancel,
        adopt,
        merge,
        discard,
      });
    }),
  );

/** Dreams over the server's own services. */
export const DreamsLive = makeDreamsLive();
