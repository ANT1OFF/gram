import {
  embeddingOn,
  type HostFailed,
  HostId,
  type HostUnavailable,
  ThreadId,
} from "@gram/contracts";
import { isPushRemote } from "@gram/git";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import { PREPARE_JOB_MS, RESUME_JOB_MS } from "../host/budgets.ts";
import type { MachineJob, MachineJobs } from "../host/machine-jobs.ts";
import {
  cancelStop,
  type KeptBefore,
  prepareStop,
  resumeHost,
  STOP_FOLDERS_MAX,
  type StopResumeDeps,
  stopStatus,
} from "../host/stop-resume.ts";
import type { ThreadStore } from "../persistence/thread-store.ts";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";

/** Each joined machine: dialled in, readied to stop, wanted by a thread. */
export const MACHINES_STOP_STATUS_PATH = "/machines/stop/status";
/** Readies a machine to stop: `{ id, force?, remote? }`. */
export const MACHINES_STOP_PREPARE_PATH = "/machines/stop/prepare";
/** Takes a stop back: `{ id }`. */
export const MACHINES_STOP_CANCEL_PATH = "/machines/stop/cancel";
/**
 * Resumes a machine's threads on the host that dialled in as it: `{ id, remote?, kept?,
 * fromBranch? }`, where `kept` is the `kept` of the stop's answer, given back, and `fromBranch` the
 * threads to make from their branch when the work their stop kept is gone from the remote.
 */
export const MACHINES_STOP_RESUME_PATH = "/machines/stop/resume";
/**
 * Says a machine is being started on another disk: `{ id }`. Once it dials in, its sessions wait
 * for its resume, as after a stop this Gram saw, so none opens before its folders are back.
 */
export const MACHINES_STOP_EXPECT_PATH = "/machines/stop/expect";

/**
 * Starts a machine's resume as a job (`docs/design/long-steps-as-jobs.md`): the resume's body and
 * a `key?`, answered at once with `{ job, joined }`.
 */
export const MACHINES_STOP_RESUME_START_PATH = "/machines/stop/resume/start";
/** Starts readying a machine to stop as a job: `{ id, force?, remote?, key? }`, as above. */
export const MACHINES_STOP_PREPARE_START_PATH = "/machines/stop/prepare/start";
/** A job as it stands: `{ job, seen?, waitMs? }`, waiting up to `waitMs` for it to pass `seen`. */
export const MACHINES_JOBS_GET_PATH = "/machines/jobs/get";

/** Local only, as every `/machines/*` route: never a paired browser, never a machine. */
export const HOST_STOP_PATHS: ReadonlySet<string> = new Set([
  MACHINES_STOP_STATUS_PATH,
  MACHINES_STOP_PREPARE_PATH,
  MACHINES_STOP_CANCEL_PATH,
  MACHINES_STOP_RESUME_PATH,
  MACHINES_STOP_EXPECT_PATH,
  MACHINES_STOP_RESUME_START_PATH,
  MACHINES_STOP_PREPARE_START_PATH,
  MACHINES_JOBS_GET_PATH,
]);

const KEY_MAX = 256;

const BODY_MAX = 4_096;
const RESUME_BODY_MAX = 512 * 1024;

const keptBefore = (value: unknown): ReadonlyArray<KeptBefore> | undefined => {
  if (!Array.isArray(value) || value.length > STOP_FOLDERS_MAX) return undefined;
  const kept: Array<KeptBefore> = [];
  for (const entry of value as ReadonlyArray<unknown>) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { threadId, cwd, commit, caughtUp, branch, remote, pushed } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof threadId !== "string" ||
      typeof cwd !== "string" ||
      (commit !== undefined && typeof commit !== "string") ||
      (caughtUp !== undefined && typeof caughtUp !== "boolean") ||
      (branch !== undefined && (typeof branch !== "string" || branch.length > 1024)) ||
      (remote !== undefined && (typeof remote !== "string" || !isPushRemote(remote)))
    )
      return undefined;
    if (pushed === false || commit === undefined) continue;
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) return undefined;
    kept.push({
      threadId: ThreadId.make(threadId),
      cwd,
      commit,
      ...(caughtUp === true ? { caughtUp } : {}),
      ...(branch === undefined ? {} : { branch }),
      ...(remote === undefined ? {} : { remote }),
    });
  }
  return kept;
};

const threadIds = (value: unknown): ReadonlyArray<ThreadId> | undefined =>
  Array.isArray(value) &&
  value.length <= STOP_FOLDERS_MAX &&
  value.every((each) => typeof each === "string" && each.length > 0 && each.length <= 256)
    ? (value as ReadonlyArray<string>).map((each) => ThreadId.make(each))
    : undefined;

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const refuse = (message: string, status: number) => json({ message }, status);

const jsonBody = (max: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (Number(request.headers["content-length"] ?? max + 1) > max) return undefined;
    const text = yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(max)),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (text === undefined) return undefined;
    return parsed(text);
  });

const parsed = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const failed = (error: HostFailed | HostUnavailable) =>
  refuse(error.message, error._tag === "HostUnavailable" ? 409 : 502);

const answerOf = (job: MachineJob | undefined) =>
  job === undefined
    ? refuse("It was cut off.", 502)
    : job.state === "done"
      ? json(job.result)
      : refuse(job.error?.message ?? "It failed.", job.error?.status ?? 502);

/**
 * Answers an authorized `/machines/stop/*` request from the local app's side. Every call is a POST
 * with an `Origin` and a JSON body, as the other machine routes are. Not found while the hosted features are off,
 * read at each call.
 */
export const hostStopRoute = (
  deps: StopResumeDeps & {
    readonly settings: Pick<ThreadStore["Service"], "getSettings">;
    readonly jobs: MachineJobs;
  },
  path: string,
) =>
  Effect.gen(function* () {
    if (!embeddingOn(yield* deps.settings.getSettings)) return refuse("not found", 404);
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (
      request.method !== "POST" ||
      request.headers["origin"] === undefined ||
      !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")
    )
      return refuse("forbidden", 403);
    const body = yield* jsonBody(
      path === MACHINES_STOP_RESUME_PATH || path === MACHINES_STOP_RESUME_START_PATH
        ? RESUME_BODY_MAX
        : BODY_MAX,
    );
    if (body === undefined) return refuse("bad request", 400);
    if (path === MACHINES_STOP_STATUS_PATH) return json({ machines: yield* stopStatus(deps) });
    if (path === MACHINES_JOBS_GET_PATH) {
      const { job: jobId, seen, waitMs } = body;
      if (
        typeof jobId !== "string" ||
        (seen !== undefined && !Number.isSafeInteger(seen)) ||
        (waitMs !== undefined && (!Number.isSafeInteger(waitMs) || (waitMs as number) < 0))
      )
        return refuse("bad request", 400);
      const job = yield* deps.jobs.watch(jobId, {
        seen: seen as number | undefined,
        waitMs: waitMs as number | undefined,
      });
      return job === undefined ? refuse("No such job here.", 404) : json({ job });
    }
    const { id, force, remote, key } = body;
    if (
      typeof id !== "string" ||
      deps.hosts.machines.get(id)?.confirmedAt === undefined ||
      (force !== undefined && typeof force !== "boolean") ||
      (remote !== undefined && (typeof remote !== "string" || !isPushRemote(remote))) ||
      (key !== undefined && (typeof key !== "string" || key.length === 0 || key.length > KEY_MAX))
    )
      return refuse("bad request", 400);
    const hostId = HostId.make(id);
    const prepareJob = () =>
      deps.jobs.start({
        kind: "prepare",
        machine: hostId,
        key,
        budgetMs: PREPARE_JOB_MS,
        run: () => prepareStop(deps, hostId, { force, remote }),
      });
    const resumeJob = (
      kept: ReadonlyArray<KeptBefore> | undefined,
      fromBranch: ReadonlyArray<ThreadId> | undefined,
    ) =>
      deps.jobs.start({
        kind: "resume",
        machine: hostId,
        key,
        budgetMs: RESUME_JOB_MS,
        run: (follow) => resumeHost(deps, hostId, { remote, kept, follow, fromBranch }),
      });
    const keptOfBody = () =>
      body["kept"] === undefined ? undefined : (keptBefore(body["kept"]) ?? null);
    const fromBranchOfBody = () =>
      body["fromBranch"] === undefined ? undefined : (threadIds(body["fromBranch"]) ?? null);
    switch (path) {
      case MACHINES_STOP_PREPARE_PATH: {
        const { job, joined } = yield* prepareJob();
        const ended = deps.jobs.ended(job.id);
        return answerOf(
          yield* joined ? ended : ended.pipe(Effect.onInterrupt(() => deps.jobs.interrupt(job.id))),
        );
      }
      case MACHINES_STOP_PREPARE_START_PATH: {
        const started = yield* prepareJob();
        return json(started, 202);
      }
      case MACHINES_STOP_CANCEL_PATH:
        return yield* cancelStop(deps, hostId).pipe(
          Effect.match({ onFailure: failed, onSuccess: () => json({ ok: true }) }),
        );
      case MACHINES_STOP_EXPECT_PATH:
        try {
          deps.hosts.stops.expect(hostId);
        } catch {
          return refuse("The machine's record couldn't be kept; try again.", 503);
        }
        return json({ ok: true });
      case MACHINES_STOP_RESUME_PATH: {
        const kept = keptOfBody();
        const fromBranch = fromBranchOfBody();
        if (kept === null || fromBranch === null) return refuse("bad request", 400);
        const { job } = yield* resumeJob(kept, fromBranch);
        return answerOf(yield* deps.jobs.ended(job.id));
      }
      case MACHINES_STOP_RESUME_START_PATH: {
        const kept = keptOfBody();
        const fromBranch = fromBranchOfBody();
        if (kept === null || fromBranch === null) return refuse("bad request", 400);
        return json(yield* resumeJob(kept, fromBranch), 202);
      }
      default:
        return refuse("not found", 404);
    }
  });
