/**
 * The transcript archive, and the only door to it.
 *
 * ```
 * <root>/<workspaceId>/archive/<threadId>.md    one rendered, scrubbed transcript per closed thread
 * ```
 *
 * Gram keeps a closed thread's conversation only while it is one of the newest few on the
 * reopen list, so a later dream can't count on it. When a thread that belongs to a workspace is
 * closed, its conversation is rendered here instead, where it outlives that list.
 *
 * Invariants. Every path comes from memory's resolver (`confinedTree`), so the archive refuses what
 * memory refuses. Nothing is written unscrubbed: `renderTranscript` scrubs what it renders and
 * `write` scrubs the whole text again, since it is also the door a test or a later caller uses.
 * And it is bounded: past `ARCHIVE_MAX_FILES` or `ARCHIVE_MAX_BYTES` the oldest files go first.
 *
 * The archive is written from `thread.removed`, after the close, and not from a hook before it:
 * `ThreadStore.closeThread` moves the conversation to the closed-thread tables in the same
 * transaction that deletes it from the live ones, so it is still there to read, and nothing in the
 * close path has to wait on a render.
 */
import type { Thread, ThreadId } from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { join } from "node:path";
import { ServerConfig } from "../config.ts";
import { EventHub, isThreadRemoved } from "../events/event-hub.ts";
import { redactText } from "../logging/redact.ts";
import { ThreadStore, type SeqMessage } from "../persistence/thread-store.ts";
import { confinedTree, validateWorkspaceId, type MemoryError } from "./memory.ts";
import { fromStoredMessages, renderTranscript } from "./transcripts.ts";
import { dropOldest } from "../bounded.ts";

/** The most transcripts one workspace's archive keeps: about two years of a busy workspace. */
const ARCHIVE_MAX_FILES = 500;
/** The most bytes one workspace's archive keeps; a rendered transcript is capped well under 1 MB. */
const ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
/** Cap on one archived transcript as read back. */
const ARCHIVE_READ_MAX_BYTES = 2 * 1024 * 1024;

const ARCHIVE = "archive";
const THREAD_FILE = /^([A-Za-z0-9_-]{1,128})\.md$/;

/** A thread's transcript path, relative to its workspace. */
const relOf = (threadId: string) => `${ARCHIVE}/${threadId}.md`;

/** One archived transcript. */
export interface ArchivedThread {
  readonly threadId: string;
  readonly bytes: number;
  /** Epoch ms the transcript was archived, which is when its thread was closed. */
  readonly archivedAt: number;
}

/** The caps of one archive; each defaults to the constant of the same name. */
export interface ArchiveCaps {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

export interface ThreadArchiveShape {
  /**
   * Stores a closed thread's rendered transcript, scrubbed, then prunes oldest-first to the caps;
   * returns the threads whose transcripts that pruned.
   */
  write(
    workspaceId: string,
    threadId: string,
    text: string,
  ): Effect.Effect<ReadonlyArray<string>, MemoryError>;
  /** What the archive holds, newest first. Empty before anything was archived. */
  list(workspaceId: string): Effect.Effect<ReadonlyArray<ArchivedThread>, MemoryError>;
  /** One transcript, scrubbed again in case the file was edited by hand. */
  read(workspaceId: string, threadId: string): Effect.Effect<string, MemoryError>;
}

/**
 * A closed thread as a dream will read it, with each message anchored by its seq so a later dream
 * can read on from its watermark; `undefined` for a conversation with nothing in it.
 */
export const renderClosedThread = (
  thread: Pick<Thread, "id" | "title" | "role" | "spawnedBy">,
  messages: ReadonlyArray<SeqMessage>,
): string | undefined => {
  const transcript = fromStoredMessages(messages);
  if (transcript.length === 0) return undefined;
  return renderTranscript({
    title: thread.title,
    source: threadSource(thread),
    messages: transcript,
  });
};

/** A thread's `Source:` line in what a dream reads: what part it played, and its id. */
export const threadSource = (thread: Pick<Thread, "id" | "role" | "spawnedBy">): string => {
  const part =
    thread.role === "orchestrator"
      ? "orchestrator thread"
      : thread.spawnedBy === undefined
        ? "thread"
        : `worker thread (${thread.spawnedBy.feature})`;
  return `${part} ${thread.id}`;
};

const make = (root: string, caps: ArchiveCaps): ThreadArchiveShape => {
  const tree = confinedTree(root);
  const maxFiles = caps.maxFiles ?? ARCHIVE_MAX_FILES;
  const maxBytes = caps.maxBytes ?? ARCHIVE_MAX_BYTES;

  const list: ThreadArchiveShape["list"] = (workspaceId) =>
    Effect.gen(function* () {
      yield* validateWorkspaceId(workspaceId);
      const entries = (yield* tree.listDir(workspaceId, ARCHIVE, ARCHIVE)) ?? [];
      const found: Array<ArchivedThread> = [];
      for (const entry of entries) {
        const threadId = THREAD_FILE.exec(entry.name)?.[1];
        if (entry.kind !== "file" || threadId === undefined) continue;
        const file = yield* tree.resolveInTree(workspaceId, relOf(threadId), ARCHIVE);
        if (file.kind !== "file" || file.stats === undefined) continue;
        found.push({
          threadId,
          bytes: file.stats.size,
          archivedAt: Math.round(file.stats.mtimeMs),
        });
      }
      return found.toSorted(
        (a, b) => b.archivedAt - a.archivedAt || a.threadId.localeCompare(b.threadId),
      );
    });

  return {
    list,
    write: (workspaceId, threadId, text) =>
      Effect.gen(function* () {
        yield* validateWorkspaceId(workspaceId);
        // A thread id becomes a file name here; ids are UUIDs, and anything else is not archived
        // rather than sanitised into a name that could collide.
        if (!THREAD_FILE.test(`${threadId}.md`)) return [];
        yield* tree.ensureDir(workspaceId, ARCHIVE, ARCHIVE);
        yield* tree.writeAtomic(workspaceId, relOf(threadId), ARCHIVE, redactText(text));
        // The file just written is never the one to go, whatever its mtime ties with: a single
        // transcript past the byte cap would otherwise archive nothing, and the render cap keeps
        // one file far below it anyway. Oldest first, as `list` orders them from the newest.
        const drop = dropOldest(yield* list(workspaceId), {
          olderFirst: (a, b) => a.archivedAt - b.archivedAt || b.threadId.localeCompare(a.threadId),
          maxItems: maxFiles,
          maxSize: maxBytes,
          sizeOf: (file) => file.bytes,
          pinned: (file) => file.threadId === threadId,
        });
        for (const oldest of drop)
          yield* tree.removeFile(workspaceId, relOf(oldest.threadId), ARCHIVE);
        return drop.map((file) => file.threadId);
      }),
    read: (workspaceId, threadId) =>
      Effect.gen(function* () {
        yield* validateWorkspaceId(workspaceId);
        return redactText(
          yield* tree.readText(
            workspaceId,
            relOf(threadId),
            ARCHIVE,
            `the archived transcript of ${threadId}`,
            ARCHIVE_READ_MAX_BYTES,
          ),
        );
      }),
  };
};

/** Closed threads' transcripts, beside each workspace's memory under the data dir. */
export class ThreadArchive extends Context.Service<ThreadArchive, ThreadArchiveShape>()(
  "@gram/server/ThreadArchive",
) {
  /** An archive under `root`, the folder that holds one folder per workspace. */
  static readonly layerAt = (root: string, caps: ArchiveCaps = {}): Layer.Layer<ThreadArchive> =>
    Layer.sync(ThreadArchive, () => make(root, caps));

  /** The archive under `<dataDir>/orchestration`, memory's root. */
  static readonly layer: Layer.Layer<ThreadArchive, never, ServerConfig> = Layer.effect(
    ThreadArchive,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return make(join(config.dataDir, "orchestration"), {});
    }),
  );
}

/**
 * Archives a closed thread if it belonged to a workspace. A dream's own thread is left out: what
 * it read is already archived, and what it concluded is its output. The dream watermarks of the threads whose
 * transcripts the caps pruned go with them, digests and all: there is nothing left to read on.
 */
export const archiveClosedThread = (
  store: Pick<
    ThreadStore["Service"],
    "listClosed" | "listMessagesFrom" | "forgetDreamThreads" | "listThreads"
  >,
  archive: ThreadArchiveShape,
  threadId: ThreadId,
) =>
  Effect.gen(function* () {
    const closed = (yield* store.listClosed).find((entry) => entry.thread.id === threadId);
    const workspaceId = closed?.thread.workspaceId;
    if (closed === undefined || workspaceId === undefined || closed.thread.role === "dream") {
      return false;
    }
    const text = renderClosedThread(
      closed.thread,
      yield* store.listMessagesFrom(threadId, 0, true),
    );
    if (text === undefined) return false;
    const pruned = yield* archive.write(workspaceId, threadId, text);
    // A pruned snapshot of a thread reopened since is not the thread: its live transcript, and the
    // marks a dream keeps of it, stay.
    const open = new Set<string>((yield* store.listThreads).map((thread) => thread.id));
    const gone = pruned.filter((id) => !open.has(id));
    if (gone.length > 0) {
      yield* store.forgetDreamThreads(
        workspaceId,
        gone.map((id) => id as ThreadId),
      );
    }
    return true;
  });

/** Watches for closed threads and archives them, until the scope closes. */
export const ThreadArchiverLive: Layer.Layer<never, never, ThreadStore | EventHub | ThreadArchive> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const hub = yield* EventHub;
      const store = yield* ThreadStore;
      const archive = yield* ThreadArchive;
      yield* hub.internalEvents(isThreadRemoved, "transcript archive").pipe(
        Stream.runForEach((event) =>
          archiveClosedThread(store, archive, event.threadId).pipe(
            Effect.catch((error) =>
              Effect.logWarning("closed thread not archived").pipe(
                Effect.annotateLogs({ threadId: event.threadId, error: error.message }),
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );
