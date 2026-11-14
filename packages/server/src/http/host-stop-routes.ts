// The local routes for stopping a joined machine with its disk kept and resuming its threads
// (`host/stop-resume.ts`), for whoever runs the machines. Part of the hosted features: with the
// setting off, none of them is there.

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
 * Resumes a machine's threads on the host that dialled in as it: `{ id, remote?, kept? }`, where
 * `kept` is the `kept` of the stop's answer, given back.
 */
export const MACHINES_STOP_RESUME_PATH = "/machines/stop/resume";

/** Local only, as every `/machines/*` route: never a paired browser, never a machine. */
export const HOST_STOP_PATHS: ReadonlySet<string> = new Set([
  MACHINES_STOP_STATUS_PATH,
  MACHINES_STOP_PREPARE_PATH,
  MACHINES_STOP_CANCEL_PATH,
  MACHINES_STOP_RESUME_PATH,
]);

const BODY_MAX = 4_096;
/** A resume can carry what a stop kept of each of its folders. */
const RESUME_BODY_MAX = 512 * 1024;

/**
 * What a stop kept, as a resume's caller gives it back: the entries a restore can be held to
 * (a folder with a commit that was pushed), or undefined for anything that isn't such a list.
 */
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
    // Not pushed, or nothing committed: the remote was never said to have it.
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

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const refuse = (message: string, status: number) => json({ message }, status);

/** A small JSON object body, or undefined for anything else. */
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

/** A machine that is away is a conflict with what was asked; one that refused is its own answer. */
const failed = (error: HostFailed | HostUnavailable) =>
  refuse(error.message, error._tag === "HostUnavailable" ? 409 : 502);

/**
 * Answers an authorized `/machines/stop/*` request from the local app's side. Every call is a POST
 * with an `Origin` and a JSON body, as the other machine routes are. Not found while the hosted features are off,
 * read at each call.
 */
export const hostStopRoute = (
  deps: StopResumeDeps & { readonly settings: Pick<ThreadStore["Service"], "getSettings"> },
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
    const body = yield* jsonBody(path === MACHINES_STOP_RESUME_PATH ? RESUME_BODY_MAX : BODY_MAX);
    if (body === undefined) return refuse("bad request", 400);
    if (path === MACHINES_STOP_STATUS_PATH) return json({ machines: yield* stopStatus(deps) });
    const { id, force, remote } = body;
    if (
      typeof id !== "string" ||
      deps.hosts.machines.get(id)?.confirmedAt === undefined ||
      (force !== undefined && typeof force !== "boolean") ||
      (remote !== undefined && (typeof remote !== "string" || !isPushRemote(remote)))
    )
      return refuse("bad request", 400);
    const hostId = HostId.make(id);
    switch (path) {
      case MACHINES_STOP_PREPARE_PATH:
        return yield* prepareStop(deps, hostId, { force, remote }).pipe(
          Effect.match({ onFailure: failed, onSuccess: (prepared) => json(prepared) }),
        );
      case MACHINES_STOP_CANCEL_PATH:
        return yield* cancelStop(deps, hostId).pipe(
          Effect.match({ onFailure: failed, onSuccess: () => json({ ok: true }) }),
        );
      case MACHINES_STOP_RESUME_PATH: {
        const kept = body["kept"] === undefined ? undefined : keptBefore(body["kept"]);
        if (body["kept"] !== undefined && kept === undefined) return refuse("bad request", 400);
        return yield* resumeHost(deps, hostId, { remote, kept }).pipe(
          Effect.match({ onFailure: failed, onSuccess: (resumed) => json(resumed) }),
        );
      }
      default:
        return refuse("not found", 404);
    }
  });
