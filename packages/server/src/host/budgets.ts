const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** A host's restore of one folder (`host.stop.restore`): a clone and a fetch, counted from asking. */
export const HOST_RESTORE_MS = 20 * MINUTE;
/** A host readying itself to stop (`host.stop.prepare`), or keeping a thread's work (`keep`). */
export const HOST_STOP_MS = 10 * MINUTE;
/** A host deleting one thread's kept work at its remote (`host.stop.drop`). */
export const HOST_DROP_MS = 3 * MINUTE;
/**
 * How much sooner than Gram's deadline for its call a host ends a step it holds its lock for
 * (`stop.ts`): the host lets go of the lock, and says so, before Gram stops waiting for it.
 */
export const HOST_STEP_MARGIN_MS = MINUTE;
/** A stop's last flush of the machine's shared folders. */
export const SHARED_FLUSH_MS = 15 * SECOND;
/** A machine saying it takes work again. */
export const STOP_CANCEL_MS = 30 * SECOND;
/** A session a resume reopened, waited for until it is seen open. */
export const REOPEN_MS = 2 * MINUTE;

/**
 * A resume job's budget: the longest it goes without progress (a folder done) before it fails by
 * itself. Longer than any one folder's restore, which ends in progress either way.
 */
export const RESUME_JOB_MS = HOST_RESTORE_MS + MINUTE;
/** A prepare job's budget, all of it: the host's prepare, the shared folders, a take-back. */
export const PREPARE_JOB_MS = HOST_STOP_MS + SHARED_FLUSH_MS + STOP_CANCEL_MS + 15 * SECOND;
/**
 * How long sessions waiting on a machine's resume wait with no progress before they give up
 * (`StopMarks.stalled`): longer than a resume job goes without progress.
 */
export const RESUME_STALL_MS = 25 * MINUTE;
/** The longest one poll of a job waits for it to change (`POST /machines/jobs/get`). */
export const JOB_WAIT_MAX_MS = 25 * SECOND;
/** How long an ended job is kept, so a retry that names its key gets its answer. */
export const JOB_KEPT_MS = 15 * MINUTE;
/** How long a session waits for a stopped machine to be started and dial in. */
export const WAKE_WAIT_MS = 5 * MINUTE;
