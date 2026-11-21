// A thread as the event sink sends it on `thread.upsert` and `sink.started`: the fields a
// receiver shows of it, and nothing of its conversation.

import {
  type LimitWait,
  redactText,
  type Thread,
  type ThreadError,
  THREAD_ERROR_TEXT_MAX,
} from "@gram/contracts";

/**
 * The error a thread's last failed turn ended with, as `thread.upsert` carries it: Gram's own
 * sentence for it (already clipped and redacted, fit to show anywhere), its kind and code, and
 * the machine it was lost with, if it was.
 */
const lastErrorData = (error: ThreadError): Record<string, unknown> => ({
  text: error.text,
  kind: error.kind,
  retryable: error.retryable,
  at: error.at,
  ...(error.code === undefined ? {} : { code: error.code }),
  ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
  ...(error.machineLost === undefined ? {} : { machineLost: error.machineLost.machine }),
});

/**
 * A provider limit the thread waits out, as `thread.upsert` carries it: an idle thread with one
 * isn't done, it resumes on its own at `resumeAt` unless `cancelled`.
 */
const limitWaitData = (wait: LimitWait): Record<string, unknown> => ({
  kind: wait.kind,
  resumeAt: wait.resumeAt,
  since: wait.since,
  ...(wait.resetsAt === undefined ? {} : { resetsAt: wait.resetsAt }),
  ...(wait.cancelled === true ? { cancelled: true } : {}),
  ...(wait.detail === undefined ? {} : { detail: wait.detail }),
});

/** A thread as `thread.upsert` and `sink.started` send it. */
export const threadData = (thread: Thread, status?: string): Record<string, unknown> => ({
  id: thread.id,
  title: thread.title,
  role: thread.role === "orchestrator" ? "orchestrator" : thread.spawnedBy ? "worker" : "plain",
  model: thread.model.model,
  agent: thread.model.agent,
  ...(status === undefined ? {} : { status }),
  ...(thread.spawnedBy === undefined ? {} : { spawnedByThreadId: thread.spawnedBy.threadId }),
  ...(thread.limitWait === undefined ? {} : { limitWait: limitWaitData(thread.limitWait) }),
  // Why its last turn failed, kept until a later one completes: what a receiver shows of a thread
  // in error. One without says it has none.
  ...(thread.lastError === undefined ? {} : { lastError: lastErrorData(thread.lastError) }),
  // Archived (parked): kept, and left out of the thread list for History. Every upsert carries the
  // whole thread, so one without it says the thread is not archived.
  ...(thread.parked ? { archived: true } : {}),
});

/**
 * What `thread.status` adds for a thread in `error`: the line Gram set with it (many errors never
 * reach `lastError`, such as a session that ended or a send the agent didn't take), on one line,
 * redacted and clipped as a `ThreadError`'s text is. Any other status adds nothing.
 */
export const errorDetailData = (
  status: string,
  detail: string | undefined,
): Record<string, unknown> => {
  if (status !== "error" || detail === undefined) return {};
  const line = redactText(detail).replaceAll(/\s+/g, " ").trim();
  if (line === "") return {};
  return {
    detail:
      line.length <= THREAD_ERROR_TEXT_MAX ? line : `${line.slice(0, THREAD_ERROR_TEXT_MAX)}…`,
  };
};
