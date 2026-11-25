import * as Schema from "effect/Schema";
import { ThreadId } from "@gram/contracts";
import { LocalCheckFailure } from "./check-process.ts";

export const LocalCheck = Schema.Struct({
  head: Schema.String,
  base: Schema.String,
  /** The tree of `head` merged onto `base`: what was checked. */
  tree: Schema.String,
  status: Schema.Literals(["running", "passed", "failed"]),
  command: Schema.String,
  preparation: Schema.optionalKey(
    Schema.Struct({
      manifest: Schema.String,
      sha256: Schema.String,
      inputConfigSha256: Schema.optionalKey(Schema.String),
    }),
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
  repositorySetup: Schema.optionalKey(Schema.Literal(true)),
  setupFingerprint: Schema.optionalKey(Schema.String),
  approvalThread: Schema.optionalKey(ThreadId),
  timeoutMs: Schema.optionalKey(Schema.Number),
  profile: Schema.optionalKey(Schema.String),
  qualification: Schema.optionalKey(Schema.String),
  /**
   * A verify driver's recipe as Gram read it: its file's SHA-256, and the default-branch ref it
   * was committed on when it ran without asking the user.
   */
  recipe: Schema.optionalKey(
    Schema.Struct({ sha256: Schema.String, ref: Schema.optionalKey(Schema.String) }),
  ),
  mergedCommit: Schema.optionalKey(Schema.String),
  /** The joined machine it ran on, by id, through its host; absent for this machine. */
  machine: Schema.optionalKey(Schema.String),
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
  /** The pull request it was run for, whose end cancels it (`local-check-cancel.ts`). */
  pr: Schema.optionalKey(Schema.Struct({ repo: Schema.String, number: Schema.Number })),
  /** Why Gram cancelled it, its result no longer counting; such a failure says nothing of the code. */
  cancelled: Schema.optionalKey(Schema.String),
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
