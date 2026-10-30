import type { MessageId } from "@gram/contracts";

import { resubscribing } from "../connection";
import { isThreadNotFound } from "../errors";
import { iterate, run, type RpcContext } from "../rpc-client";
import type { ApiThreadFeedEvent } from "../types";
import type { ThreadsApi } from "./types";

/** `ThreadsApi` over the RPC client. Feeds resubscribe through `connection` when the socket drops. */
export const threadsRpc = ({ client, connection }: RpcContext): ThreadsApi => ({
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
            ...(from?.from === undefined ? {} : { from: from.from as MessageId }),
          }),
          s,
        );
      },
      connection,
      signal,
      { marker: { type: "subscribed" }, final: isThreadNotFound },
    ),
  threadHistory: (threadId, before) =>
    run(client["thread.history"]({ threadId, before: before as MessageId })),
  createThread: (input) => run(client["thread.create"](input)),
  send: (threadId, input) => run(client["thread.send"]({ threadId, input })),
  steer: (threadId, input) => run(client["thread.steer"]({ threadId, input })),
  interrupt: (threadId) => run(client["thread.interrupt"]({ threadId })),
  resumeLimitWait: (threadId) => run(client["thread.resumeLimitWait"]({ threadId })),
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
  respond: (threadId, requestId, answer) =>
    run(client["thread.respond"]({ threadId, requestId, answer })),
  respondMany: (answers) => run(client["thread.respondMany"]({ answers: [...answers] })),
  setMode: (threadId, mode) => run(client["thread.setMode"]({ threadId, mode })),
  setModel: (threadId, model) => run(client["thread.setModel"]({ threadId, model })),
  rename: (threadId, title) => run(client["thread.rename"]({ threadId, title })),
  addDirectory: (threadId, path) => run(client["thread.addDirectory"]({ threadId, path })),
  setPlan: (threadId, plan) => run(client["thread.setPlan"]({ threadId, plan })),
  refreshPlan: (threadId, rebuild) =>
    run(client["thread.refreshPlan"]({ threadId, ...(rebuild ? { rebuild } : {}) })),
  pin: (threadId, pinned) => run(client["thread.pin"]({ threadId, pinned })),
  park: (threadId, parked) => run(client["thread.park"]({ threadId, parked })),
  markCompleted: (threadId, completed) =>
    run(client["thread.markCompleted"]({ threadId, completed })),
  reorderThreads: (threadIds) => run(client["threads.reorder"]({ threadIds })),
  label: (threadId, labels) => run(client["thread.label"]({ threadId, labels })),
  markUnread: (threadId, unread) => run(client["thread.markUnread"]({ threadId, unread })),
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
  forkThread: (threadId, options = {}) => run(client["thread.fork"]({ threadId, ...options })),
  searchThreads: (query, options = {}) => run(client["thread.search"]({ query, ...options })),
  queueEdit: (threadId, itemId, input) =>
    run(client["thread.queue.edit"]({ threadId, itemId, input })),
  queueReorder: (threadId, itemIds) => run(client["thread.queue.reorder"]({ threadId, itemIds })),
  queueRemove: (threadId, itemId) => run(client["thread.queue.remove"]({ threadId, itemId })),
  queueSteer: (threadId, itemId) => run(client["thread.queue.steer"]({ threadId, itemId })),
  acceptTask: (threadId, taskId) => run(client["task.accept"]({ threadId, taskId })),
  dismissTask: (threadId, taskId) => run(client["task.dismiss"]({ threadId, taskId })),
  prCheckout: (projectRoot, number, repo) =>
    run(
      client["pr.checkout"](
        repo === undefined ? { projectRoot, number } : { projectRoot, number, repo },
      ),
    ),
  checkoutUsers: (path) => run(client["threads.usingCheckout"]({ path })),
});
