import type { MockCoreScenes } from "./mock-thread-runtime";
import type {
  CompactionActivity,
  LimitWait,
  ThreadError,
  TurnId,
  PlanItem,
  ThreadPlan,
  BackgroundOutput,
  BackgroundTask,
  PanelKind,
  TerminalProcess,
  PendingRequest,
  QueueItemId,
  RequestAnswer,
  GramUIMessage,
  GramUIMessageChunk,
  MessageId,
  ThreadId,
  ThreadSummary,
  UserInput,
} from "@gram/contracts";

// Dev and e2e hooks that put one thread in a state: requests, queue, plan, background work,
// messages, status, errors, limit waits, processes, ports, files and panels.

/**
 * Dev and e2e hook: a request that can be answered independently of a scripted turn; `onAnswer`
 * hears the answer, as the server's own card would.
 */
export function simulateRequest(
  core: MockCoreScenes,
  threadId: ThreadId,
  request: PendingRequest,
  onAnswer?: (answer: RequestAnswer) => void,
) {
  const runtime = core.runtime(threadId);
  core.ask(threadId, request, (answer) => {
    onAnswer?.(answer);
    if (runtime.summary.pendingRequests.length > 0) return;
    core.setStatus(
      runtime,
      runtime.running ? "running" : runtime.summary.identity === undefined ? "cold" : "idle",
    );
  });
}

/** Dev and e2e hook: input waiting in the queue of a thread that may be idle, as a restart leaves it. */
export function simulateQueued(
  core: MockCoreScenes,
  threadId: ThreadId,
  inputs: readonly UserInput[],
) {
  const runtime = core.runtime(threadId);
  core.setQueue(runtime, [
    ...runtime.summary.queue,
    ...inputs.map((input) => ({ id: core.ids() as QueueItemId, input })),
  ]);
}

/** Dev and e2e hook: the thread last did something at `at`, as if it had sat since. */
export function simulateLastActivity(core: MockCoreScenes, threadId: ThreadId, at: number) {
  core.update(core.runtime(threadId), { lastActivityAt: at });
}

/** Dev and e2e hook: the agent's todo list, as its next `plan` event would carry it. */
export function simulateTurnPlan(
  core: MockCoreScenes,
  threadId: ThreadId,
  items: readonly PlanItem[],
) {
  core.setPlans(core.runtime(threadId), { turnPlan: [...items] });
}

/** Dev and e2e hook: the thread's plan as the agent or the helper wrote it, `undefined` for none. */
export function simulatePlan(
  core: MockCoreScenes,
  threadId: ThreadId,
  plan: ThreadPlan | undefined,
) {
  core.setPlans(core.runtime(threadId), { plan });
}

/** Dev and e2e hook: the agent's background tasks, as its next `backgroundTasks` level says. */
export function simulateBackground(
  core: MockCoreScenes,
  threadId: ThreadId,
  tasks: readonly BackgroundTask[],
) {
  core.setBackground(core.runtime(threadId), tasks);
}

/**
 * Dev and e2e hook: a background shell's output tail as the agent read it back, for one of the
 * tasks of the last `simulateBackground`, as the server publishes it.
 */
export function simulateBackgroundOutput(
  core: MockCoreScenes,
  threadId: ThreadId,
  output: BackgroundOutput,
) {
  const runtime = core.runtime(threadId);
  if (!(runtime.summary.background ?? []).some((task) => task.taskId === output.taskId)) return;
  runtime.summary = {
    ...runtime.summary,
    backgroundOutput: [
      ...(runtime.summary.backgroundOutput ?? []).filter((each) => each.taskId !== output.taskId),
      output,
    ],
  };
  core.emit({ type: "thread.backgroundOutput", threadId, ...output });
}

/** Dev and e2e hook: a stored provider message arriving on the thread's feed. */
export function simulateMessage(core: MockCoreScenes, threadId: ThreadId, message: GramUIMessage) {
  core.putMessage(core.runtime(threadId), message);
}

/** Dev and e2e hook: actual adapter chunks entering the same feed as a scripted turn. */
export function simulateChunks(
  core: MockCoreScenes,
  threadId: ThreadId,
  messageId: MessageId,
  chunks: readonly GramUIMessageChunk[],
) {
  const runtime = core.runtime(threadId);
  for (const chunk of chunks) core.feed(runtime, { type: "chunk", messageId, chunk });
}

/** Dev and e2e hook: explicit adapter/runtime status, without starting a provider CLI. */
export function simulateStatus(
  core: MockCoreScenes,
  threadId: ThreadId,
  status: ThreadSummary["status"],
  detail?: string,
  compaction?: CompactionActivity,
) {
  core.setStatus(core.runtime(threadId), status, detail, compaction);
}

/**
 * Dev and e2e hook: a turn on `text` that fails as the server reports one, with the error card in
 * the transcript and the thread left in `error`.
 */
export function simulateTurnError(
  core: MockCoreScenes,
  threadId: ThreadId,
  error: Omit<ThreadError, "turnId" | "at">,
  text: string,
) {
  const runtime = core.runtime(threadId);
  const turnId = `turn-failed-${core.nextSeq()}` as TurnId;
  const at = Date.now();
  core.putMessage(runtime, {
    id: `${turnId}-user`,
    role: "user",
    metadata: { turnId },
    parts: [{ type: "text", text }],
  });
  const lastError: ThreadError = { ...error, turnId, at };
  core.putMessage(runtime, {
    id: `error-${turnId}`,
    role: "assistant",
    parts: [{ type: "data-agent-error", id: `error-${turnId}`, data: lastError }],
  });
  runtime.summary = {
    ...runtime.summary,
    thread: { ...runtime.summary.thread, lastError },
  };
  core.emit({ type: "thread.upsert", thread: runtime.summary.thread });
  core.setStatus(runtime, "error");
}

/**
 * Dev and e2e hook: a turn on `text` that stops on a provider limit, as the server reports one: the
 * thread rests waiting for `resumeAt`, with no error card.
 */
export function simulateLimitWait(
  core: MockCoreScenes,
  threadId: ThreadId,
  wait: Omit<LimitWait, "account" | "since" | "turnId">,
  text: string,
) {
  const runtime = core.runtime(threadId);
  const turnId = `turn-limited-${core.nextSeq()}` as TurnId;
  core.putMessage(runtime, {
    id: `${turnId}-user`,
    role: "user",
    metadata: { turnId },
    parts: [{ type: "text", text }],
  });
  core.update(runtime, {
    limitWait: {
      ...wait,
      account: `${runtime.summary.thread.model.agent}/`,
      since: Date.now(),
      turnId,
    },
  });
  core.setStatus(runtime, "idle");
}

/**
 * Dev and e2e hook: fresh readings say `threadId`'s limit no longer applies, as the server ends
 * a wait early: marked cleared to resume at `resumeAt`, or, with none, resumed now.
 */
export async function simulateLimitCleared(
  core: MockCoreScenes,
  threadId: ThreadId,
  resumeAt?: number,
) {
  const runtime = core.runtime(threadId);
  const wait = runtime.summary.thread.limitWait;
  if (wait === undefined) return;
  if (resumeAt !== undefined) {
    core.update(runtime, { limitWait: { ...wait, cleared: Date.now(), resumeAt } });
    return;
  }
  const { limitWait: _, ...thread } = runtime.summary.thread;
  core.replaceThread({
    ...thread,
    limitCleared: {
      at: Date.now(),
      ...(wait.resetsAt === undefined ? {} : { resetsAt: wait.resetsAt }),
    },
  });
  await core.mock.send(threadId, {
    text: "The usage limit no longer applies. Continue where you left off.",
  });
}

/** Dev and e2e hook: what runs in the thread's terminals, as the server's next scan finds it. */
export function simulateTerminalProcesses(
  core: MockCoreScenes,
  threadId: ThreadId,
  processes: readonly TerminalProcess[],
) {
  const runtime = core.runtime(threadId);
  const { terminalProcesses: _previous, ...rest } = runtime.summary;
  runtime.summary = processes.length === 0 ? rest : { ...rest, terminalProcesses: processes };
  core.emit({ type: "thread.terminalProcesses", threadId, processes });
}

/** Dev and e2e hook: the ports the thread's processes listen on, as the server's next scan finds. */
export function simulatePorts(core: MockCoreScenes, threadId: ThreadId, ports: readonly number[]) {
  const runtime = core.runtime(threadId);
  const { ports: _previous, ...rest } = runtime.summary;
  runtime.summary = ports.length === 0 ? rest : { ...rest, ports };
  core.emit({ type: "thread.ports", threadId, ports });
}

/**
 * Dev and e2e hook: the thread's agent writes `content` to `path` with its Write tool, a finished
 * call in an assistant message of its own, as a turn would leave it.
 */
export function simulateWrittenFile(
  core: MockCoreScenes,
  threadId: ThreadId,
  path: string,
  content: string,
) {
  const runtime = core.runtime(threadId);
  const id = `write-${core.nextSeq()}`;
  core.putMessage(runtime, {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-Write",
        toolCallId: id,
        state: "output-available",
        input: { file_path: path, content },
        output: { type: "create", filePath: path, content, structuredPatch: [] },
      },
    ],
  } as unknown as GramUIMessage);
}

/**
 * Dev and e2e hook: the thread's agent calls `show_panel`, or with `driven` opens a page in its
 * pane with `browser_navigate`, as the server publishes it.
 */
export function simulateShowPanel(
  core: MockCoreScenes,
  threadId: ThreadId,
  panel: PanelKind,
  target?: string,
  driven?: boolean,
) {
  core.emit({
    type: "ui.showPanel",
    threadId,
    panel,
    ...(target === undefined ? {} : { target }),
    ...(driven === true ? { driven } : {}),
  });
}
