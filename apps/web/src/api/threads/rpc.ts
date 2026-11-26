import { MessageId } from "@gram/contracts";

import { resubscribing } from "../connection";
import { isThreadNotFound } from "../errors";
import { iterate, runMessage, run, type RpcContext } from "../rpc-client";
import type { ApiThreadFeedEvent } from "../types";
import { isAnswerOverHttp, postAnswer, postAnswers } from "./answer-over-http";
import type { ThreadsApi } from "./types";

/** `ThreadsApi` over the RPC client. Feeds resubscribe through `connection` when the socket drops. */
export const threadsRpc = ({ client, connection }: RpcContext): ThreadsApi => {
  const answers = { overHttp: false };
  return {
    events: (signal) =>
      resubscribing((s) => iterate(client["events.subscribe"](undefined), s), connection, signal),
    threadFeed: (threadId, signal, resume) =>
      resubscribing<ApiThreadFeedEvent>(
        (s) => {
          const from = resume?.();
          return iterate(
            client["thread.subscribe"]({
              threadId,
              ...(from === undefined ? {} : { afterRev: from.afterRev }),
              ...(from?.from === undefined ? {} : { from: MessageId.make(from.from) }),
            }),
            s,
          );
        },
        connection,
        signal,
        { marker: { type: "subscribed" }, final: isThreadNotFound },
      ),
    threadHistory: (threadId, before) =>
      run(client["thread.history"]({ threadId, before: MessageId.make(before) })),
    createThread: (input) => run(client["thread.create"](input)),
    send: (threadId, input, options) =>
      runMessage(
        client["thread.send"]({
          threadId,
          input,
          clientMessageId: crypto.randomUUID(),
          ...(options?.deviceGrant === undefined ? {} : { deviceGrant: options.deviceGrant }),
        }),
        connection,
      ),
    steer: (threadId, input, options) =>
      runMessage(
        client["thread.steer"]({
          threadId,
          input,
          clientMessageId: crypto.randomUUID(),
          ...(options?.interrupt === true ? { interrupt: true } : {}),
        }),
        connection,
      ),
    interrupt: (threadId) => run(client["thread.interrupt"]({ threadId })),
    resumeLimitWait: (threadId) => run(client["thread.resumeLimitWait"]({ threadId })),
    resumeAfterMachineLost: (threadId) =>
      run(client["thread.resumeAfterMachineLost"]({ threadId })),
    restoreFromBranch: (threadId) => run(client["thread.restoreFromBranch"]({ threadId })),
    savedDiff: (threadId) => run(client["thread.savedDiff"]({ threadId })),
    cancelLimitWait: (threadId) => run(client["thread.cancelLimitWait"]({ threadId })),
    restartSession: (threadId, midTurn) =>
      run(
        client["thread.restartSession"]({
          threadId,
          ...(midTurn === undefined ? {} : { midTurn }),
        }),
      ),
    startSession: (threadId) => run(client["thread.startSession"]({ threadId })),
    stopTask: (threadId, taskId) => run(client["thread.stopTask"]({ threadId, taskId })),
    respond: async (threadId, requestId, answer, shown) => {
      if (answers.overHttp) return postAnswer(threadId, requestId, answer, shown);
      try {
        return await run(
          client["thread.respond"]({
            threadId,
            requestId,
            answer,
            ...(shown === undefined ? {} : { shown }),
          }),
        );
      } catch (error) {
        if (!isAnswerOverHttp(error)) throw error;
        answers.overHttp = true;
        return postAnswer(threadId, requestId, answer, shown);
      }
    },
    respondMany: async (many) => {
      if (answers.overHttp) return postAnswers(many);
      try {
        return await run(
          client["thread.respondMany"]({
            answers: many.map(({ shown, ...each }) => ({
              ...each,
              ...(shown === undefined ? {} : { shown }),
            })),
          }),
        );
      } catch (error) {
        if (!isAnswerOverHttp(error)) throw error;
        answers.overHttp = true;
        return postAnswers(many);
      }
    },
    setMode: (threadId, mode) => run(client["thread.setMode"]({ threadId, mode })),
    setModel: (threadId, model) => run(client["thread.setModel"]({ threadId, model })),
    switchAgent: (threadId, target, options) =>
      run(
        client["thread.switchAgent"]({
          threadId,
          target,
          ...(options?.note === undefined ? {} : { note: options.note }),
        }),
      ).then(() => undefined),
    startFreshOn: (threadId, model) =>
      run(client["thread.startFreshOn"]({ threadId, model })).then(() => undefined),
    rename: (threadId, title) => run(client["thread.rename"]({ threadId, title })),
    addDirectory: (threadId, path) => run(client["thread.addDirectory"]({ threadId, path })),
    setPlan: (threadId, plan) => run(client["thread.setPlan"]({ threadId, plan })),
    pin: (threadId, pinned) => run(client["thread.pin"]({ threadId, pinned })),
    park: (threadId, parked) => run(client["thread.park"]({ threadId, parked })),
    markCompleted: (threadId, completed) =>
      run(client["thread.markCompleted"]({ threadId, completed })),
    reorderThreads: (threadIds) => run(client["threads.reorder"]({ threadIds })),
    label: (threadId, labels) => run(client["thread.label"]({ threadId, labels })),
    markUnread: (threadId, unread) => run(client["thread.markUnread"]({ threadId, unread })),
    snooze: (threadId, until) => run(client["thread.snooze"]({ threadId, until })),
    setBrowser: (threadId, browser) => run(client["thread.setBrowser"]({ threadId, browser })),
    threadBrowserStatus: (threadId) => run(client["thread.browserStatus"]({ threadId })),
    threadSetBabysit: (threadId, enabled, budget) =>
      run(client["thread.setBabysit"]({ threadId, enabled, ...(budget ? { budget } : {}) })),
    threadSetReviewMonitor: (threadId, enabled) =>
      run(client["thread.setReviewMonitor"]({ threadId, enabled })),
    closeThread: (threadId, options = {}) => run(client["thread.close"]({ threadId, ...options })),
    restoreWorktree: (threadId, fromPr) =>
      run(client["thread.restoreWorktree"]({ threadId, ...(fromPr === true ? { fromPr } : {}) })),
    listClosedThreads: () => run(client["threads.closed.list"](undefined)),
    reopenClosedThread: () => run(client["threads.closed.reopen"](undefined)),
    pendingPermissions: (threadId) => run(client["worktree.pendingPermissions"]({ threadId })),
    rewind: (threadId, toMessageId, files) =>
      run(client["thread.rewind"]({ threadId, toMessageId, files })),
    undoTurn: (threadId, turnId) => run(client["thread.undoTurn"]({ threadId, turnId })),
    forkThread: (threadId, options = {}) => run(client["thread.fork"]({ threadId, ...options })),
    searchThreads: (query, options = {}) => run(client["thread.search"]({ query, ...options })),
    queueEdit: (threadId, itemId, input) =>
      run(client["thread.queue.edit"]({ threadId, itemId, input })),
    queueReorder: (threadId, itemIds) => run(client["thread.queue.reorder"]({ threadId, itemIds })),
    queueRemove: (threadId, itemId) => run(client["thread.queue.remove"]({ threadId, itemId })),
    queueSteer: (threadId, itemId) =>
      runMessage(
        client["thread.queue.steer"]({ threadId, itemId, clientMessageId: crypto.randomUUID() }),
        connection,
      ),
    acceptTask: (threadId, taskId) => run(client["task.accept"]({ threadId, taskId })),
    dismissTask: (threadId, taskId) => run(client["task.dismiss"]({ threadId, taskId })),
    prCheckout: (projectRoot, number, repo) =>
      run(
        client["pr.checkout"](
          repo === undefined ? { projectRoot, number } : { projectRoot, number, repo },
        ),
      ),
    checkoutUsers: (path) => run(client["threads.usingCheckout"]({ path })),
  };
};
