import * as Data from "effect/Data";

/** The child couldn't be started (missing binary, bad cwd, EACCES). */
export class ProcSpawnError extends Data.TaggedError("ProcSpawnError")<{
  readonly bin: string;
  readonly message: string;
}> {}

/**
 * The child overran its bound and was killed. Distinct from a non-zero exit on purpose: a killed
 * `git status` prints nothing, which is byte-identical to a clean tree, so state is UNKNOWN.
 */
export class ProcTimeout extends Data.TaggedError("ProcTimeout")<{
  readonly bin: string;
  readonly message: string;
}> {}

export type ProcError = ProcSpawnError | ProcTimeout;

/** A git/gh command ran and refused. `message` is its trimmed stderr (else stdout, else a fallback). */
export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly message: string;
}> {}

export class NotARepo extends Data.TaggedError("NotARepo")<{
  readonly path: string;
}> {}

export type WorktreeErrorReason = "invalidRequest" | "conflict" | "failed";

/** A worktree operation failed. `dirty` marks a refusal to delete uncommitted work (offer force). */
export class WorktreeError extends Data.TaggedError("WorktreeError")<{
  readonly reason: WorktreeErrorReason;
  readonly message: string;
  readonly dirty: boolean;
}> {}

export class CheckpointError extends Data.TaggedError("CheckpointError")<{
  readonly message: string;
}> {}
