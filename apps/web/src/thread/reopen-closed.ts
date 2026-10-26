import type { ReopenedClosedThread, Thread, ThreadId } from "@gram/contracts";

import { errorMessage } from "@/api/errors";
import type { Api } from "@/api/types";
import { flushServerEvents, useThreadsStore } from "@/stores/threads";

const tagOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? Reflect.get(error, "_tag") : undefined;

/** Why a closed thread couldn't come back, in the user's terms. */
export function reopenProblem(thread: Thread, error: unknown): string {
  const { checkout } = thread;
  const message = errorMessage(error);
  if (tagOf(error) === "NotFound") {
    return `Its ${checkout.kind === "worktree" ? "worktree" : "folder"} no longer exists: ${checkout.path}`;
  }
  if (/not a worktree/i.test(message)) {
    return `${checkout.path} isn't a worktree of its repository anymore.`;
  }
  if (/already open/i.test(message)) return "Another thread is already open in that checkout.";
  return message;
}

/**
 * What a reopened thread didn't get back, for the toast: its folder, or its part in a workspace.
 * `undefined` when it came back as it was.
 */
export function reopenNotice(
  reopened: ReopenedClosedThread,
): { readonly title: string; readonly body: string } | undefined {
  const { thread } = reopened.closed;
  const lines: Array<string> = [];
  if (reopened.closed.problem === "folderMissing") {
    lines.push(
      thread.checkout.kind === "worktree"
        ? `Its worktree no longer exists: ${thread.checkout.path}. Restore it from the thread, from its branch or its PR's head.`
        : `Its folder no longer exists: ${thread.checkout.path}, so its agent can't run.`,
    );
  }
  const was = thread.role === "orchestrator" ? "orchestrator" : "worker";
  switch (reopened.membership) {
    case "slotTaken":
      lines.push(
        "Its workspace has another orchestrator now, so this one is back as a plain thread in the workspace.",
      );
      break;
    case "orchestratorGone":
      lines.push(
        "The orchestrator that spawned it is closed or replaced, so it is back in the workspace without one.",
      );
      break;
    case "workspaceGone":
      lines.push("Its workspace was removed, so it is back as a plain thread.");
      break;
    case "notAdmitted":
      lines.push(
        `Its model or mode can't be a workspace's ${was} any more, so it is back as a plain thread in the workspace.`,
      );
      break;
    case "restored":
    case undefined:
      break;
  }
  return lines.length === 0
    ? undefined
    : { title: `Reopened “${thread.title}”`, body: lines.join(" ") };
}

const notify = (kind: "info" | "error", title: string, body: string) =>
  useThreadsStore.getState().applyEvent({ type: "notify", kind, title, body });

/**
 * ⌘⇧T: the server takes the most recently closed thread off its list and opens it again from its
 * stored record, as an orchestrator or a worker when it was one, and with its folder gone too, for
 * the folder-missing notice to restore. When another thread already shows its session, that thread
 * opens instead. A reopen that fails is put back on the list by the server, to try again.
 */
export async function reopenLastClosed(
  api: Api,
  open: (threadId: ThreadId) => void,
): Promise<void> {
  let reopened: ReopenedClosedThread | null;
  try {
    reopened = await api.reopenClosedThread();
  } catch (error) {
    // The server put the entry back, so the newest on the list is the one that failed.
    const [failed] = await api.listClosedThreads().catch(() => []);
    if (failed === undefined) {
      notify("error", "Couldn't reopen a closed thread", errorMessage(error));
    } else {
      notify(
        "error",
        `Couldn't reopen “${failed.thread.title}”`,
        reopenProblem(failed.thread, error),
      );
    }
    return;
  }
  if (!reopened) {
    notify("info", "Nothing to reopen", "There are no closed threads to bring back.");
    return;
  }
  const { closed } = reopened;
  if (closed.problem === "sessionOpen" && closed.openThreadId !== undefined) {
    open(closed.openThreadId);
    notify(
      "info",
      `“${closed.thread.title}” is already open`,
      "Another thread shows its session, so that one is open now.",
    );
    return;
  }
  if (reopened.thread === undefined) return;
  // The server's `thread.upsert` may land after the route changes; don't flash "not found".
  // An upsert the server sent before this answer may still wait for its frame: it goes first.
  flushServerEvents();
  useThreadsStore.getState().applyEvent({ type: "thread.upsert", thread: reopened.thread });
  open(reopened.thread.id);
  const notice = reopenNotice(reopened);
  if (notice !== undefined) notify("info", notice.title, notice.body);
}
