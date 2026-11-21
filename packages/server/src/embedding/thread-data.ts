import {
  type LimitWait,
  redactText,
  type Thread,
  type ThreadError,
  THREAD_ERROR_TEXT_MAX,
} from "@gram/contracts";

const lastErrorData = (error: ThreadError): Record<string, unknown> => ({
  text: error.text,
  kind: error.kind,
  retryable: error.retryable,
  at: error.at,
  ...(error.code === undefined ? {} : { code: error.code }),
  ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
  ...(error.machineLost === undefined ? {} : { machineLost: error.machineLost.machine }),
});

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
  ...(thread.lastError === undefined ? {} : { lastError: lastErrorData(thread.lastError) }),
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
