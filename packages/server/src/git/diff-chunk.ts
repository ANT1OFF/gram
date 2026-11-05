// `git.diffChunk`: one file of a thread's diff, read again on its own up to a larger cap than the
// listing's, and served a bounded chunk of hunks at a time, or summarized. Reads only: git diffs and
// the untracked file itself, never a write to the checkout.

import {
  chunkLimits,
  chunkPatch,
  generatedKind,
  GitError,
  NotFound,
  summarizePatch,
  type DiffChunk,
  type DiffCursor,
  type DiffScope,
  type ThreadId,
} from "@gram/contracts";
import {
  branchExists,
  Checkpoints,
  FILE_DIFF_GIT_ARGS,
  fileDiffPaths,
  fingerprintOf,
  git,
  localBaseRef,
  MAX_FILE_DIFF_READ_BYTES,
  selectFilePatch,
  tryRepoTop,
  untrackedFileDiff,
  type FilePatch,
  type ProcOutput,
} from "@gram/git";
import * as Effect from "effect/Effect";
import { toGitError } from "./mapping.ts";
import { endCheckpointId } from "./turn-hooks.ts";

export interface DiffChunkRequest {
  readonly threadId: ThreadId;
  /** The thread's folder. */
  readonly cwd: string;
  readonly scope: DiffScope;
  readonly path: string;
  readonly oldPath?: string | undefined;
  readonly ignoreWhitespace?: boolean | undefined;
  readonly cursor?: DiffCursor | undefined;
  readonly hunks?: number | undefined;
  readonly mode?: "hunks" | "summary" | undefined;
  readonly fingerprint?: string | undefined;
  /** The branch scope's base, as the rebase signal resolved it; else the repo default. */
  readonly branchBase?: string | undefined;
}

interface Source {
  readonly file: FilePatch | undefined;
  readonly partial: boolean;
}

const missing = (path: string) =>
  new NotFound({
    entity: "file",
    id: path,
    message: `${path} isn't in this diff any more. Refresh the diff to see what changed.`,
  });

const checked = (out: ProcOutput) =>
  out.status === 0
    ? Effect.succeed(out)
    : Effect.fail(
        new GitError({ message: out.stderr.trim() || "git diff failed", command: "git diff" }),
      );

/** `git diff <range> -- <paths>` in `top`, read up to the per-file cap. */
const diffPaths = (
  top: string,
  range: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
  ignoreWhitespace: boolean,
) =>
  git(
    top,
    [
      ...FILE_DIFF_GIT_ARGS,
      "diff",
      ...range,
      "--no-color",
      ...(ignoreWhitespace ? ["-w"] : []),
      "--",
      ...paths,
    ],
    { maxOutputBytes: MAX_FILE_DIFF_READ_BYTES },
  ).pipe(Effect.mapError(toGitError), Effect.flatMap(checked));

const fromOutput = (out: ProcOutput, path: string): Source => ({
  file: selectFilePatch(out.stdout, path, out.truncated),
  partial: out.truncated,
});

/** `path` in the branch-vs-`base` diff, when there is a base. */
const branchSource = (
  top: string,
  base: string | undefined,
  paths: Array<string>,
  path: string,
  ws: boolean,
) =>
  base === undefined
    ? Effect.succeed<Source>({ file: undefined, partial: false })
    : diffPaths(top, [`${base}...HEAD`], paths, ws).pipe(
        Effect.map((out) => fromOutput(out, path)),
      );

/**
 * The working tree's change to `path`: tracked against HEAD, else the untracked file whole. A clean
 * tree diffs the branch against its base instead, as `git.diff` falls back to.
 */
const uncommittedSource = (top: string, paths: Array<string>, path: string, ws: boolean) =>
  Effect.gen(function* () {
    const hasHead = yield* branchExists(top, "HEAD").pipe(Effect.mapError(toGitError));
    const tracked = fromOutput(yield* diffPaths(top, hasHead ? ["HEAD"] : [], paths, ws), path);
    if (tracked.file !== undefined) return tracked;
    const others = yield* git(top, ["ls-files", "--others", "--exclude-standard", "-z"], {
      maxOutputBytes: 64 * 1024 * 1024,
    }).pipe(Effect.mapError(toGitError));
    const untracked = others.stdout.split("\0");
    if (untracked.includes(path)) {
      const file = untrackedFileDiff(top, path, MAX_FILE_DIFF_READ_BYTES);
      if (file === undefined) return { file: undefined, partial: false };
      return {
        file: {
          path,
          status: "new",
          binary: file.note === "binary",
          patch: file.diff,
          additions: file.added,
          deletions: 0,
          fingerprint: fingerprintOf(`untracked\n${file.note ?? ""}\n${file.diff}`),
        },
        partial: file.note === "too large",
      } satisfies Source;
    }
    // Only a clean tree falls back: any change or untracked file means the diff was the tree's.
    if (!hasHead || others.stdout !== "") return { file: undefined, partial: false };
    const dirty = yield* git(top, ["diff", "--quiet", "HEAD"]).pipe(Effect.mapError(toGitError));
    if (dirty.status !== 0) return { file: undefined, partial: false };
    const base = yield* localBaseRef(top).pipe(Effect.mapError(toGitError));
    return yield* branchSource(top, base, paths, path, ws);
  });

/** A turn's change to `path`: its start checkpoint against its end, or the live tree while it runs. */
const turnSource = (
  threadId: ThreadId,
  top: string,
  turnId: string,
  paths: Array<string>,
  path: string,
  ws: boolean,
) =>
  Effect.gen(function* () {
    const checkpoints = yield* Checkpoints;
    const resolve = (turn: string) =>
      checkpoints.resolve(top, threadId, turn).pipe(Effect.mapError(toGitError));
    const start = yield* resolve(turnId);
    if (start === undefined) {
      return yield* new NotFound({
        entity: "checkpoint",
        id: turnId,
        message: "This turn has no checkpoint, so its changes can't be shown.",
      });
    }
    const end = yield* resolve(endCheckpointId(turnId));
    const out = yield* checkpoints
      .fileDiff(top, start, end ?? "worktree", paths, {
        ignoreWhitespace: ws,
        maxOutputBytes: MAX_FILE_DIFF_READ_BYTES,
      })
      .pipe(Effect.mapError(toGitError));
    return fromOutput(out, path);
  });

/** The chunk `request` asks for. */
export const diffChunk = (request: DiffChunkRequest) =>
  Effect.gen(function* () {
    const top = yield* tryRepoTop(request.cwd).pipe(Effect.mapError(toGitError));
    if (top === undefined) return yield* missing(request.path);
    const paths = fileDiffPaths(request.path, request.oldPath);
    const ws = request.ignoreWhitespace === true;
    const scope = request.scope;
    const source: Source =
      scope.kind === "uncommitted"
        ? yield* uncommittedSource(top, paths, request.path, ws)
        : scope.kind === "branch"
          ? yield* branchSource(
              top,
              request.branchBase ?? (yield* localBaseRef(top).pipe(Effect.mapError(toGitError))),
              paths,
              request.path,
              ws,
            )
          : yield* turnSource(request.threadId, top, scope.turnId, paths, request.path, ws);
    const file = source.file;
    if (file === undefined) return yield* missing(request.path);
    const base = {
      path: file.path,
      fingerprint: file.fingerprint,
      binary: file.binary,
      partial: source.partial,
      ...(file.binary ? {} : withGenerated(generatedKind(file.path, file.patch))),
    };
    if (request.fingerprint !== undefined && request.fingerprint !== file.fingerprint) {
      return {
        ...base,
        changed: true,
        patch: "",
        totalHunks: 0,
        additions: file.additions,
        deletions: file.deletions,
        clippedLines: 0,
      } satisfies DiffChunk;
    }
    if (request.mode === "summary") {
      const summary = summarizePatch(file.path, file.patch);
      return {
        ...base,
        changed: false,
        patch: "",
        totalHunks: summary.hunks,
        additions: summary.additions,
        deletions: summary.deletions,
        clippedLines: 0,
        summary,
      } satisfies DiffChunk;
    }
    const chunk = chunkPatch(file.patch, request.cursor, chunkLimits(request.hunks));
    return { ...base, changed: false, ...chunk } satisfies DiffChunk;
  });

const withGenerated = (kind: ReturnType<typeof generatedKind>) =>
  kind === undefined ? {} : { generated: kind };
