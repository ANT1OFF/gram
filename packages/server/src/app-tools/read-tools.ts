import {
  AppToolError,
  effectiveCheckout,
  fenceThreadMessage,
  fromOwnOrchestrator,
  threadSender,
  ThreadStatus,
  type GitState,
  type MessageOrigin,
  type Project,
  type ServerEvent,
  type GramUIMessage,
  type ThreadId,
  type ThreadSummary,
} from "@gram/contracts";
import { checkpointRef, Checkpoints, Proc, tryRepoTop } from "@gram/git";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { EventHub } from "../events/event-hub.ts";
import { folderExists, missingThreadFolder } from "../fs/folders.ts";
import { GitStatePublisher } from "../git/publisher.ts";
import { turnDiff } from "../git/turn-diff.ts";
import { endCheckpointId } from "../git/turn-hooks.ts";
import { redactText } from "../logging/redact.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { SqlClient } from "../platform/unstable.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { searchThreads } from "../search/search.ts";
import { defineAppTool } from "./definition.ts";
import { AppToolRegistry } from "./registry.ts";

/** The sender of a stored message another thread sent, when it is one. */
const originOf = (message: GramUIMessage): MessageOrigin | undefined => {
  for (const part of message.parts) {
    if (part.type === "data-thread-origin") return part.data;
  }
  return undefined;
};

/** Who sent another thread's message, as a read tool returns it: every field sanitised. */
const senderOf = (origin: MessageOrigin) => {
  const { label: _, ...sender } = threadSender(origin);
  return sender;
};

/** Patch text one `turn_diff` call returns, unless the caller asks for more (up to the max). */
const TURN_DIFF_PATCH_CAP = 20_000;
const TURN_DIFF_PATCH_MAX = 100_000;
const MESSAGE_TEXT_CAP = 1_000;
const THREAD_TEXT_CAP = 8_000;
/** Status, queue and PR events kept per thread for `list_events`. */
const EVENT_LOG_CAPACITY = 200;

export interface LoggedEvent {
  /** Epoch ms. */
  readonly at: number;
  readonly type: "status" | "queue" | "pr" | "reviewRound";
  readonly [field: string]: unknown;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.trunc(n)));

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, Math.max(0, max))}… [truncated]` : text;

const firstLine = (text: string) =>
  truncate(
    text
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? "",
    120,
  );

/**
 * A message as plain text: its text parts, with tool calls as `[tool Name]` and a failed turn's
 * error as `[turn failed: …]`.
 */
const messageText = (message: GramUIMessage): string =>
  message.parts
    .flatMap((part) =>
      part.type === "text"
        ? [part.text]
        : part.type.startsWith("tool-")
          ? [`[tool ${part.type.slice("tool-".length)}]`]
          : part.type === "data-agent-error"
            ? [`[turn failed: ${part.data.text}]`]
            : [],
    )
    .join("\n");

/** The fields an agent needs from a git state, without fingerprints and oids. */
const compactGitState = (state: GitState) =>
  state.repo
    ? {
        repo: true,
        ...(state.branch === undefined ? {} : { branch: state.branch }),
        head: state.head.slice(0, 12),
        worktree: state.worktree,
        changedFiles: state.changedFiles,
        ...(state.base === undefined
          ? {}
          : { base: state.base, aheadBase: state.aheadBase, behindBase: state.behindBase }),
        conflictsWithBase: state.conflicts,
        ...(state.upstream === undefined ? {} : { upstream: state.upstream }),
        ...(state.pr === undefined
          ? {}
          : {
              pr: {
                number: state.pr.number,
                state: state.pr.state,
                title: redactText(state.pr.title),
                url: state.pr.url,
                isDraft: state.pr.isDraft,
                checks: state.pr.checks,
              },
            }),
      }
    : { repo: false };

/** An AppToolError with the failure's own message where it has one. */
const toolError =
  (tool: string) =>
  (e: unknown): AppToolError =>
    e instanceof AppToolError
      ? e
      : new AppToolError({
          tool,
          message:
            typeof e === "object" &&
            e !== null &&
            "message" in e &&
            typeof e.message === "string" &&
            e.message !== ""
              ? e.message
              : `${tool} failed`,
        });

/**
 * Read tools: the thread's git state, turn diffs and checkpoints, and cross-thread
 * awareness (list, get, search, events). All *read* class, so they run without a card. Text from
 * transcripts and titles passes through `redactText`.
 */
export const ReadAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const runtimes = yield* ThreadRuntimes;
    const store = yield* ThreadStore;
    const hub = yield* EventHub;
    const publisher = yield* GitStatePublisher;
    const checkpoints = yield* Checkpoints;
    const proc = yield* Proc;
    const sql = yield* SqlClient.SqlClient;
    const provideGit = <A, E>(effect: Effect.Effect<A, E, Proc | Checkpoints>) =>
      effect.pipe(
        Effect.provideService(Proc, proc),
        Effect.provideService(Checkpoints, checkpoints),
      );

    // In memory since the server started; `list_events` says so.
    const log = new Map<ThreadId, Array<LoggedEvent>>();
    const lastPr = new Map<ThreadId, string>();
    const record = (
      threadId: ThreadId,
      entry: { readonly type: LoggedEvent["type"]; readonly [field: string]: unknown },
    ) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        const events = log.get(threadId) ?? [];
        events.push({ ...entry, at });
        if (events.length > EVENT_LOG_CAPACITY)
          events.splice(0, events.length - EVENT_LOG_CAPACITY);
        log.set(threadId, events);
      });
    const observe = (event: ServerEvent): Effect.Effect<void> => {
      switch (event.type) {
        case "thread.status":
          return record(event.threadId, {
            type: "status",
            status: event.status,
            ...(event.detail === undefined ? {} : { detail: redactText(event.detail) }),
          });
        case "thread.queue":
          return record(event.threadId, { type: "queue", queued: event.queue.length });
        case "git.state": {
          const pr = event.state.pr;
          const key = pr === undefined ? "" : `${pr.number} ${pr.state} ${pr.checks}`;
          const previous = lastPr.get(event.threadId);
          lastPr.set(event.threadId, key);
          if (key === (previous ?? "")) return Effect.void;
          return record(
            event.threadId,
            pr === undefined
              ? { type: "pr", none: true }
              : { type: "pr", number: pr.number, state: pr.state, checks: pr.checks },
          );
        }
        case "pr.reviewRound":
          return record(event.threadId, { type: "reviewRound" });
        case "thread.removed":
          return Effect.sync(() => {
            log.delete(event.threadId);
            lastPr.delete(event.threadId);
          });
        default:
          return Effect.void;
      }
    };
    yield* hub
      .serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] }))
      .pipe(Stream.runForEach(observe), Effect.forkScoped);

    const compactThread = (
      summary: ThreadSummary,
      projects: ReadonlyMap<string, Project>,
      caller: ThreadId,
    ) =>
      Effect.gen(function* () {
        const { thread } = summary;
        const checkout = effectiveCheckout(thread);
        const branch = checkout.branch ?? (yield* publisher.stateFor(checkout.path))?.branch;
        return {
          threadId: thread.id,
          title: redactText(thread.title),
          status: summary.status,
          ...(summary.activity === undefined ? {} : { activity: redactText(summary.activity) }),
          ...(thread.lastError === undefined
            ? {}
            : {
                lastError: {
                  kind: thread.lastError.kind,
                  ...(thread.lastError.httpStatus === undefined
                    ? {}
                    : { httpStatus: thread.lastError.httpStatus }),
                  text: thread.lastError.text,
                },
              }),
          ...(branch === undefined ? {} : { branch }),
          agent: thread.model.agent,
          model: thread.model.model,
          project: projects.get(thread.projectId)?.name ?? "",
          path: checkout.path,
          ...(thread.id === caller ? { self: true } : {}),
          ...(thread.completedAt === undefined ? {} : { completed: true }),
          ...(thread.parked ? { parked: true } : {}),
        };
      });

    const projectsById = store.listProjects.pipe(
      Effect.map((projects) => new Map(projects.map((p) => [p.id as string, p]))),
    );

    /**
     * The thread a read is about: the caller, or the one `threadId` names. Any thread may read any
     * other, as `get_thread` already lets it; an orchestrator reads its workers' diffs this way.
     */
    const threadOf = (tool: string, caller: ThreadId, threadId: string | undefined) =>
      store
        .getThread((threadId ?? caller) as ThreadId)
        .pipe(
          Effect.mapError(
            () => new AppToolError({ tool, message: `unknown thread ${threadId ?? caller}` }),
          ),
        );

    const gitStateTool = defineAppTool({
      descriptor: {
        name: "git_state",
        class: "read",
        description:
          "A thread's git state from Gram's cache: branch, ahead/behind its base, upstream, changed files, conflicts with the base, and the pull request. This thread's unless threadId names another. Prefer this to running git status.",
      },
      input: Schema.Struct({
        refresh: Schema.optionalKey(Schema.Boolean),
        threadId: Schema.optionalKey(Schema.NonEmptyString),
      }),
      handle: (caller, { refresh = false, threadId: other }) =>
        Effect.gen(function* () {
          const tool = "git_state";
          const thread = yield* threadOf(tool, caller, other);
          const cwd = effectiveCheckout(thread).path;
          if (!(yield* folderExists(cwd))) {
            return yield* new AppToolError({ tool, message: missingThreadFolder(cwd) });
          }
          if (refresh || (yield* publisher.stateFor(cwd)) === undefined) {
            yield* publisher.refresh(cwd, { remote: false });
          }
          const state = yield* publisher.stateFor(cwd);
          return {
            path: cwd,
            ...(state === undefined ? { repo: false } : compactGitState(state)),
            ...(thread.boundPr === undefined ? {} : { boundPr: thread.boundPr }),
          };
        }).pipe(Effect.mapError(toolError("git_state"))),
    });

    const turnDiffTool = defineAppTool({
      descriptor: {
        name: "turn_diff",
        class: "read",
        description:
          "The files and patch one turn of a thread changed, from its per-turn checkpoints; this thread's unless threadId names another, and the latest turn unless turnId names one. Patches are cut at maxPatchChars (default 20000).",
      },
      input: Schema.Struct({
        turnId: Schema.optionalKey(Schema.String),
        maxPatchChars: Schema.optionalKey(Schema.Int),
        threadId: Schema.optionalKey(Schema.NonEmptyString),
      }),
      handle: (caller, { turnId, maxPatchChars = TURN_DIFF_PATCH_CAP, threadId: other }) =>
        Effect.gen(function* () {
          const tool = "turn_diff";
          const thread = yield* threadOf(tool, caller, other);
          const threadId = thread.id;
          const turns = yield* store.listTurns(threadId);
          const turn = turnId === undefined ? turns.at(-1) : turns.find((t) => t.id === turnId);
          if (turn === undefined) {
            return yield* new AppToolError({
              tool,
              message:
                turnId === undefined ? "That thread has no turns yet." : `unknown turn ${turnId}`,
            });
          }
          const cwd = effectiveCheckout(thread).path;
          if (!(yield* folderExists(cwd))) {
            return yield* new AppToolError({ tool, message: missingThreadFolder(cwd) });
          }
          const diff = yield* provideGit(turnDiff(threadId, cwd, turn.id));
          if (!diff.repo) return { turnId: turn.id, repo: false };
          const budget = clamp(maxPatchChars, 200, TURN_DIFF_PATCH_MAX);
          let used = 0;
          let cut = false;
          const files = (diff.files ?? []).map((file) => {
            const room = Math.max(0, budget - used);
            const patch = file.patch.length <= room ? file.patch : file.patch.slice(0, room);
            if (patch.length < file.patch.length) cut = true;
            used += patch.length;
            return {
              path: file.path,
              ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              ...(file.binary ? { binary: true } : {}),
              ...(file.tooLarge ? { tooLarge: true } : {}),
              patch: redactText(patch),
            };
          });
          const notes = [
            diff.note,
            cut
              ? `Patches were cut at ${budget} characters; ask for more with maxPatchChars.`
              : undefined,
          ].filter((note) => note !== undefined);
          return {
            turnId: turn.id,
            running: turn.endedAt === undefined,
            files,
            ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
          };
        }).pipe(Effect.mapError(toolError("turn_diff"))),
    });

    const listCheckpointsTool = defineAppTool({
      descriptor: {
        name: "list_checkpoints",
        class: "read",
        description:
          "This thread's recent turns with their checkpoint refs, the first line of each turn's prompt, and how many files each changed.",
      },
      input: Schema.Struct({ limit: Schema.optionalKey(Schema.Int) }),
      handle: (threadId, { limit = 10 }) =>
        Effect.gen(function* () {
          const thread = yield* store.getThread(threadId);
          const cwd = effectiveCheckout(thread).path;
          const all = yield* store.listTurns(threadId);
          const turns = all.slice(-clamp(limit, 1, 100));
          const messages = yield* store.listMessages(threadId);
          const top = (yield* folderExists(cwd))
            ? yield* provideGit(tryRepoTop(cwd)).pipe(Effect.orElseSucceed(() => undefined))
            : undefined;
          const refs = new Set<string>(
            top === undefined
              ? []
              : yield* checkpoints
                  .list(top, threadId)
                  .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
          );
          const entries = yield* Effect.forEach(turns, (turn) =>
            Effect.gen(function* () {
              const prompt = messages.find(
                (m) => m.role === "user" && m.metadata?.turnId === turn.id,
              );
              const startRef = refs.has(turn.id) ? checkpointRef(threadId, turn.id) : undefined;
              const endRef = refs.has(endCheckpointId(turn.id))
                ? checkpointRef(threadId, endCheckpointId(turn.id))
                : undefined;
              const filesChanged =
                top !== undefined && startRef !== undefined && endRef !== undefined
                  ? yield* checkpoints.diffBetween(top, startRef, endRef).pipe(
                      Effect.map((result) => result.files.length),
                      Effect.orElseSucceed(() => undefined),
                    )
                  : undefined;
              // A turn another thread's message opened names that thread, not the user, as its sender.
              const origin = prompt === undefined ? undefined : originOf(prompt);
              const line = prompt === undefined ? "" : redactText(firstLine(messageText(prompt)));
              return {
                turnId: turn.id,
                startedAt: turn.startedAt,
                ...(turn.endedAt === undefined ? { running: true } : { endedAt: turn.endedAt }),
                ...(turn.reason === undefined ? {} : { reason: turn.reason }),
                prompt: origin === undefined ? line : `[${threadSender(origin).label}] ${line}`,
                ...(origin === undefined ? {} : { promptFrom: senderOf(origin) }),
                ...(startRef === undefined ? {} : { startRef }),
                ...(endRef === undefined ? {} : { endRef }),
                ...(filesChanged === undefined ? {} : { filesChanged }),
              };
            }),
          );
          return {
            turns: entries,
            ...(all.length > turns.length ? { earlierTurns: all.length - turns.length } : {}),
          };
        }).pipe(Effect.mapError(toolError("list_checkpoints"))),
    });

    const listThreadsTool = defineAppTool({
      descriptor: {
        name: "list_threads",
        class: "read",
        description:
          "Other Gram threads: title, status, activity line, branch, agent and project. Use it to check whether someone is already working on something. To mention a thread to the user, link it as [title](#threadId).",
      },
      input: Schema.Struct({
        status: Schema.optionalKey(ThreadStatus),
        project: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(Schema.Int),
      }),
      handle: (threadId, { status, project, limit = 50 }) =>
        Effect.gen(function* () {
          const projects = yield* projectsById;
          const needle = project?.trim().toLowerCase() ?? "";
          const matching = (yield* runtimes.snapshot).filter((summary) => {
            if (status !== undefined && summary.status !== status) return false;
            if (needle === "") return true;
            const p = projects.get(summary.thread.projectId);
            return (
              p !== undefined &&
              (p.name.toLowerCase().includes(needle) || p.root.toLowerCase().includes(needle))
            );
          });
          const shown = matching.slice(0, clamp(limit, 1, 200));
          const threads = yield* Effect.forEach(shown, (summary) =>
            compactThread(summary, projects, threadId),
          );
          return { threads, ...(matching.length > shown.length ? { truncated: true } : {}) };
        }).pipe(Effect.mapError(toolError("list_threads"))),
    });

    const getThreadTool = defineAppTool({
      descriptor: {
        name: "get_thread",
        class: "read",
        description:
          "One thread's summary and its last messages as text (default 10, at most 50), capped. To mention a thread to the user, link it as [title](#threadId).",
      },
      input: Schema.Struct({
        threadId: Schema.NonEmptyString,
        messages: Schema.optionalKey(Schema.Int),
      }),
      handle: (caller, { threadId, messages = 10 }) =>
        Effect.gen(function* () {
          const tool = "get_thread";
          const summary = yield* runtimes.summaryOf(threadId as ThreadId);
          if (summary === undefined) {
            return yield* new AppToolError({ tool, message: `unknown thread ${threadId}` });
          }
          const stored = yield* store.listMessages(summary.thread.id);
          let budget = THREAD_TEXT_CAP;
          const transcript: Array<{
            role: string;
            text: string;
            from?: ReturnType<typeof senderOf>;
          }> = [];
          for (const message of stored.slice(-clamp(messages, 1, 50)).toReversed()) {
            if (budget <= 0) break;
            const cut = truncate(
              redactText(messageText(message)),
              Math.min(MESSAGE_TEXT_CAP, budget),
            );
            // Another thread's message isn't the user's: its own role, its sender, and its text
            // fenced, cut before the fence so the block stays whole. Only its own words, or a
            // worker reading back what its orchestrator told it, come as written: those are the
            // reader's instructions, as its agent first read them, and to anyone else material.
            const origin = message.role === "user" ? originOf(message) : undefined;
            const asWritten =
              origin !== undefined &&
              (origin.threadId === caller ||
                (caller === summary.thread.id &&
                  fromOwnOrchestrator(origin, summary.thread.spawnedBy)));
            const text = origin === undefined || asWritten ? cut : fenceThreadMessage(origin, cut);
            budget -= text.length;
            transcript.unshift(
              origin === undefined
                ? { role: message.role, text }
                : { role: "thread", from: senderOf(origin), text },
            );
          }
          return {
            thread: yield* compactThread(summary, yield* projectsById, caller),
            queued: summary.queue.length,
            pendingRequests: summary.pendingRequests.length,
            messageCount: stored.length,
            messages: transcript,
          };
        }).pipe(Effect.mapError(toolError("get_thread"))),
    });

    const searchThreadsTool = defineAppTool({
      descriptor: {
        name: "search_threads",
        class: "read",
        description:
          "Full-text search over every thread's title and messages; returns matching threads with a snippet.",
      },
      input: Schema.Struct({
        query: Schema.NonEmptyString,
        limit: Schema.optionalKey(Schema.Int),
      }),
      handle: (_threadId, { query, limit = 20 }) =>
        searchThreads({ query, limit: clamp(limit, 1, 50) }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.map((result) => ({
            hits: result.hits.map((hit) => ({
              threadId: hit.threadId,
              title: redactText(hit.title),
              ...(hit.messageId === undefined ? {} : { messageId: hit.messageId }),
              snippet: redactText(hit.snippet),
            })),
            ...(result.truncated ? { truncated: true } : {}),
          })),
        ),
    });

    const listEventsTool = defineAppTool({
      descriptor: {
        name: "list_events",
        class: "read",
        description:
          "A thread's recent status, queue and pull request events, oldest first. History is kept in memory and resets when Gram restarts. Pass `since` (an earlier event's `at`, epoch ms) to get only newer ones.",
      },
      input: Schema.Struct({
        threadId: Schema.NonEmptyString,
        since: Schema.optionalKey(Schema.Number),
        limit: Schema.optionalKey(Schema.Int),
      }),
      handle: (_caller, { threadId, since, limit = 50 }) =>
        Effect.gen(function* () {
          const thread = yield* store.getThread(threadId as ThreadId);
          const events = (log.get(thread.id) ?? []).filter(
            (event) => since === undefined || event.at > since,
          );
          const recent = events.slice(-clamp(limit, 1, EVENT_LOG_CAPACITY));
          return {
            events: recent,
            ...(events.length > recent.length ? { truncated: true } : {}),
          };
        }).pipe(
          Effect.mapError(
            () => new AppToolError({ tool: "list_events", message: `unknown thread ${threadId}` }),
          ),
        ),
    });

    yield* registry.register([
      gitStateTool,
      turnDiffTool,
      listCheckpointsTool,
      listThreadsTool,
      getThreadTool,
      searchThreadsTool,
      listEventsTool,
    ]);
  }),
);
