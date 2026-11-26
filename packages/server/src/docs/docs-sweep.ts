import {
  type DocArchiveReason,
  type DocMeta,
  type DocPr,
  DOC_USER_KEEP_DAYS,
  type FsError,
  type InvalidState,
  type DocsArchivePolicy,
  docsArchiveOf,
  type PrStatus,
  type Thread,
  type WorkspaceId,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { GitStatePublisherShape } from "../git/publisher.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { DAY_MS } from "../zone-time.ts";
import { currentReader, readerMayWorkspace } from "../embedding/readable-by.ts";
import type { DocsShape } from "./docs.ts";

/** A doc's author as the sweep finds it: an open or closed thread, or none it still knows. */
export interface DocAuthorFacts {
  readonly orchestrator: boolean;
  /** Epoch ms it was archived, or closed; absent while it is in use. */
  readonly archivedAt?: number | undefined;
}

/** What GitHub last said of a doc's PR, as the threads following it have it. */
export type DocPrState = "open" | "settled";

/** What the sweep does with one doc. */
export type DocSweepStep =
  | { readonly kind: "markPrSettled" }
  | { readonly kind: "clearPrSettled" }
  | { readonly kind: "archive"; readonly reason: DocArchiveReason };

const USER_KEEP_MS = DOC_USER_KEEP_DAYS * DAY_MS;

/**
 * When someone last chose to keep it: the user opened or saved it, or it was restored. `undefined`
 * if never. A doc saved before `userSeenAt` was kept counts its last save.
 */
export const userSeenAtOf = (doc: DocMeta): number | undefined => {
  const times = [
    doc.updatedBy === "user" ? doc.updatedAt : undefined,
    doc.userSeenAt,
    doc.restoredAt,
  ].filter((time) => time !== undefined);
  return times.length === 0 ? undefined : Math.max(...times);
};

/**
 * The sweep's step for `doc` at `now`, or `undefined` to leave it. Never archived: an archived doc,
 * one the orchestrator wrote, or one the user opened or saved, or someone restored, in the last
 * `DOC_USER_KEEP_DAYS`.
 *
 * A PR's doc is archived `prDays` after the sweep first saw its PR merged or closed (marked
 * first); while the PR is open it stays, and a mark from before it reopened is cleared. With its
 * PR unknown, it goes as a worker's doc does. A worker's doc (`authorRole`) goes `workerDays`
 * after its author was archived or closed, or after its last save once the author is gone from
 * every list. A doc whose author's part wasn't recorded, published before it was, only goes by its
 * PR: there is no telling an orchestrator's from a worker's once the thread has gone.
 */
export const docSweepStep = (
  doc: DocMeta,
  author: DocAuthorFacts | undefined,
  prState: DocPrState | undefined,
  policy: DocsArchivePolicy,
  now: number,
): DocSweepStep | undefined => {
  if (doc.archivedAt !== undefined) return undefined;
  if (doc.authorRole === "orchestrator" || author?.orchestrator === true) return undefined;
  if (doc.pr !== undefined && prState === "open") {
    return doc.prSettledAt === undefined ? undefined : { kind: "clearPrSettled" };
  }
  if (doc.pr !== undefined && prState === "settled" && doc.prSettledAt === undefined) {
    return { kind: "markPrSettled" };
  }
  const kept = userSeenAtOf(doc);
  if (kept !== undefined && now - kept < USER_KEEP_MS) return undefined;
  if (doc.pr !== undefined && doc.prSettledAt !== undefined) {
    return now - doc.prSettledAt >= policy.prDays * DAY_MS
      ? { kind: "archive", reason: "pr-merged" }
      : undefined;
  }
  if (doc.authorRole !== "worker") return undefined;
  const since = author === undefined ? doc.updatedAt : author.archivedAt;
  if (since === undefined) return undefined;
  return now - since >= policy.workerDays * DAY_MS
    ? { kind: "archive", reason: "worker-archived" }
    : undefined;
};

const PR_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/i;

/** `owner/repo#N` of a GitHub PR's URL, lowercased as GitHub matches it. */
export const prKeyOfUrl = (url: string): string | undefined => {
  const match = PR_URL.exec(url);
  return match === null ? undefined : `${match[1]!.toLowerCase()}#${match[2]}`;
};

export const prKey = (pr: DocPr): string => `${pr.repo.toLowerCase()}#${pr.number}`;

/**
 * The PRs the threads know of, by `prKey`. A merge is final, so a merged badge, or a merge a thread
 * settled on (which outlives its close), makes a PR settled. Otherwise the badge GitHub updated
 * last says whether it is open or closed, and an open badge wins a tie or an unknown time: a
 * closed PR can reopen, and a stale closed badge must not archive a live PR's doc.
 */
export const prStatesOf = (
  badges: ReadonlyArray<Pick<PrStatus, "url" | "state" | "updatedAt">>,
  settledMergeUrls: ReadonlyArray<string>,
): ReadonlyMap<string, DocPrState> => {
  const merged = new Set<string>();
  for (const url of settledMergeUrls) {
    const key = prKeyOfUrl(url);
    if (key !== undefined) merged.add(key);
  }
  const latest = new Map<string, { state: DocPrState; at: number }>();
  for (const badge of badges) {
    const key = prKeyOfUrl(badge.url);
    if (key === undefined) continue;
    if (badge.state === "MERGED") merged.add(key);
    const at = badge.updatedAt === undefined ? Number.NaN : Date.parse(badge.updatedAt);
    const state: DocPrState = badge.state === "OPEN" ? "open" : "settled";
    const known = latest.get(key);
    const newer =
      known === undefined ||
      (Number.isFinite(at) && Number.isFinite(known.at) && at > known.at) ||
      (state === "open" && !(Number.isFinite(at) && Number.isFinite(known.at) && at < known.at));
    if (newer) latest.set(key, { state, at });
  }
  const states = new Map<string, DocPrState>();
  for (const [key, { state }] of latest) states.set(key, state);
  for (const key of merged) states.set(key, "settled");
  return states;
};

/** Each known thread's facts as a doc author: open threads first, then closed ones. */
export const authorsOf = (
  open: ReadonlyArray<Thread>,
  closed: ReadonlyArray<{ readonly thread: Thread; readonly closedAt: number }>,
): ReadonlyMap<string, DocAuthorFacts> => {
  const authors = new Map<string, DocAuthorFacts>();
  for (const { thread, closedAt } of closed) {
    authors.set(thread.id, {
      orchestrator: thread.role === "orchestrator",
      archivedAt: thread.parked ? Math.min(thread.parkedAt ?? closedAt, closedAt) : closedAt,
    });
  }
  for (const thread of open) {
    authors.set(thread.id, {
      orchestrator: thread.role === "orchestrator",
      archivedAt: thread.parked ? (thread.parkedAt ?? thread.lastActivityAt) : undefined,
    });
  }
  return authors;
};

/** What one pass did, for its log line. */
export interface DocsSweepCounts {
  readonly archived: number;
  readonly marked: number;
}

/**
 * One pass over every workspace's active docs: marks the PRs seen settled and archives what
 * `docSweepStep` says is due, read again under the doc's lock first. A workspace or doc that fails
 * is passed over until the next pass.
 */
export const sweepDocs = (
  docs: Pick<DocsShape, "list" | "archiveIfDue" | "mark">,
  store: Pick<ThreadStoreShape, "getSettings" | "listWorkspaces" | "listThreads" | "listClosed">,
  publisher: Pick<GitStatePublisherShape, "badgeFor" | "extraBadgesFor">,
): Effect.Effect<DocsSweepCounts> =>
  Effect.gen(function* () {
    const policy = docsArchiveOf(yield* store.getSettings);
    const open = yield* store.listThreads;
    const closed = yield* store.listClosed;
    const badges: Array<Pick<PrStatus, "url" | "state" | "updatedAt">> = [];
    for (const thread of open) {
      const bound = yield* publisher.badgeFor(thread);
      if (bound !== undefined) badges.push(bound);
      badges.push(...(yield* publisher.extraBadgesFor(thread)));
    }
    const merged = [...open, ...closed.map((each) => each.thread)].flatMap(
      (thread) => thread.settledMerge?.merged.map((mark) => mark.url) ?? [],
    );
    const prStates = prStatesOf(badges, merged);
    const authors = authorsOf(open, closed);
    const now = yield* Clock.currentTimeMillis;
    const stepOf = (doc: DocMeta) =>
      docSweepStep(
        doc,
        authors.get(doc.authorThreadId),
        doc.pr === undefined ? undefined : prStates.get(prKey(doc.pr)),
        policy,
        now,
      );
    let archived = 0;
    let marked = 0;
    for (const { workspace } of yield* store.listWorkspaces) {
      const workspaceId: WorkspaceId = workspace.id;
      const active = yield* docs.list(workspaceId).pipe(Effect.orElseSucceed(() => []));
      for (const doc of active) {
        const step = stepOf(doc);
        if (step === undefined) continue;
        if (step.kind === "markPrSettled" || step.kind === "clearPrSettled") {
          const change =
            step.kind === "markPrSettled"
              ? (meta: DocMeta) =>
                  meta.prSettledAt === undefined ? { ...meta, prSettledAt: now } : undefined
              : ({ prSettledAt, ...meta }: DocMeta) =>
                  prSettledAt === undefined ? undefined : meta;
          const ok = yield* docs.mark(workspaceId, doc.id, change).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (ok) marked++;
          continue;
        }
        const done = yield* docs
          .archiveIfDue(workspaceId, doc.id, step.reason, (meta) => {
            const still = stepOf(meta);
            return still?.kind === "archive" && still.reason === step.reason;
          })
          .pipe(Effect.orElseSucceed(() => undefined));
        if (done !== undefined) archived++;
      }
    }
    return { archived, marked };
  });

/**
 * "Archive docs older than…": the active docs, in every workspace the calling person may act on,
 * neither saved nor opened by the user in the last `days`, the orchestrator's included, since the
 * user asked. Returns how many went.
 */
export const archiveDocsOlderThan = (
  docs: Pick<DocsShape, "list" | "archiveIfDue">,
  store: Pick<ThreadStoreShape, "listWorkspaces">,
  days: number,
): Effect.Effect<number> =>
  Effect.gen(function* () {
    const cutoff = (yield* Clock.currentTimeMillis) - days * DAY_MS;
    const old = (doc: DocMeta) => Math.max(doc.updatedAt, userSeenAtOf(doc) ?? 0) < cutoff;
    const reader = yield* currentReader;
    let archived = 0;
    for (const { workspace } of yield* store.listWorkspaces) {
      if (!readerMayWorkspace(reader, workspace, "act")) continue;
      const active = yield* docs.list(workspace.id).pipe(Effect.orElseSucceed(() => []));
      for (const doc of active.filter(old)) {
        const done = yield* docs
          .archiveIfDue(workspace.id, doc.id, "manual", old)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (done !== undefined) archived++;
      }
    }
    return archived;
  });

/** How long after the user last opened a doc another open is worth writing down. */
export const DOC_OPENED_EVERY_MS = 60 * 60_000;

/** The pane opened a doc: stamps `userSeenAt`, at most once an hour. */
export const markDocOpened = (
  docs: Pick<DocsShape, "mark">,
  workspaceId: WorkspaceId,
  id: DocMeta["id"],
): Effect.Effect<void, InvalidState | FsError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* docs.mark(workspaceId, id, (meta) =>
      meta.userSeenAt !== undefined && now - meta.userSeenAt < DOC_OPENED_EVERY_MS
        ? undefined
        : { ...meta, userSeenAt: now },
    );
  });
