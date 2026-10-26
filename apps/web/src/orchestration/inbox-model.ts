import type {
  Checkout,
  PendingRequest,
  RequestAnswer,
  RequestId,
  RespondManyResult,
  ThreadId,
  ThreadSummary,
} from "@gram/contracts";

import { canonicalJson } from "@/lib/canonical-json";
import { mustReadDetails } from "@/thread/request-model";

import { treeThreads, type WorkspaceTree } from "./tree-model";

// The approvals inbox: every request waiting across a workspace's
// threads, with the identical ones folded into one entry that a single answer goes out to. No
// React.

export interface InboxEntry {
  readonly threadId: ThreadId;
  readonly title: string;
  /** The project's name, which is what tells cross-repo siblings apart. */
  readonly project?: string | undefined;
  /** Absent for the orchestrator's own requests. */
  readonly feature?: string | undefined;
  /**
   * Where the thread's agent runs, so where an allowed command would: the worktree it moved into
   * when it has, the one it was launched in otherwise.
   */
  readonly checkout?: Pick<Checkout, "path" | "branch"> | undefined;
  readonly request: PendingRequest;
}

export interface InboxGroup {
  readonly key: string;
  /** More than one only for approvals whose tool and whole input are equal, within one feature. */
  readonly entries: readonly [InboxEntry, ...InboxEntry[]];
}

/** The waiting requests of `threads`, in the order given. */
export const threadEntries = (
  threads: readonly Pick<ThreadSummary, "thread" | "pendingRequests">[],
  projectName: (projectId: string) => string | undefined = () => undefined,
): InboxEntry[] =>
  threads.flatMap(({ thread, pendingRequests }) =>
    pendingRequests.map((request) => ({
      threadId: thread.id,
      title: thread.title,
      project: projectName(thread.projectId),
      feature: thread.role === undefined ? thread.spawnedBy?.feature : undefined,
      checkout: thread.currentCheckout ?? thread.checkout,
      request,
    })),
  );

/** A workspace's waiting requests, the orchestrator's first, then its workers' in tree order. */
export const inboxEntries = (
  tree: WorkspaceTree,
  projectName: (projectId: string) => string | undefined = () => undefined,
): InboxEntry[] => threadEntries(treeThreads(tree), projectName);

/**
 * The same tool given the same input, whole, for the same feature. The card's subject is one field
 * of the input (`command`, `file_path`, `url`), so keying on it let a request whose other arguments
 * differed ride along under an "Allow all" that showed only the first one's. JSON escapes NUL, and
 * neither a feature slug nor a tool name holds one.
 */
const approvalKey = (entry: InboxEntry): string | undefined =>
  entry.request.kind === "approval" &&
  entry.feature !== undefined &&
  !mustReadDetails(entry.request)
    ? [entry.feature, entry.request.toolName, canonicalJson(entry.request.input)].join("\0")
    : undefined;

/**
 * Entries in the order they came, identical approvals folded into the first of them. Where each
 * member runs is not part of "identical": workers of a feature each have a worktree of their own,
 * which is why the card lists every member's. Questions and plans never fold: each needs an answer
 * of its own, and nor does an approval that must be read in full (`mustReadDetails`).
 */
export const groupInbox = (entries: readonly InboxEntry[]): InboxGroup[] => {
  const groups = new Map<string, [InboxEntry, ...InboxEntry[]]>();
  for (const entry of entries) {
    const key = approvalKey(entry) ?? `${entry.threadId}\0${entry.request.id}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }
  return [...groups].map(([key, members]) => ({ key, entries: members }));
};

export interface GroupAnswerResult {
  readonly answered: readonly InboxEntry[];
  /** `error` is the server's reason for that request, or the whole call's when it never got there. */
  readonly failed: readonly { readonly entry: InboxEntry; readonly error: unknown }[];
}

/** What the inbox needs of `Api.respondMany`. */
export type RespondMany = (
  answers: readonly {
    readonly threadId: ThreadId;
    readonly requestId: RequestId;
    readonly answer: RequestAnswer;
  }[],
) => Promise<readonly RespondManyResult[]>;

/**
 * Sends `decision`, once, to every request of a group in one `respondMany` call, and sorts the
 * group by what the server said of each: a worker that can't be reached doesn't hold up the rest,
 * and a request the result doesn't mention counts as not answered. A call that fails outright
 * answered nobody. "Always" isn't offered here, as it writes rules into each worktree separately.
 */
export const answerGroup = async (
  group: InboxGroup,
  decision: "allow" | "deny",
  respondMany: RespondMany,
): Promise<GroupAnswerResult> => {
  const answer: RequestAnswer = { kind: "approval", decision, scope: "once" };
  let results: readonly RespondManyResult[];
  try {
    results = await respondMany(
      group.entries.map((entry) => ({
        threadId: entry.threadId,
        requestId: entry.request.id,
        answer,
      })),
    );
  } catch (error) {
    return { answered: [], failed: group.entries.map((entry) => ({ entry, error })) };
  }
  const byRequest = new Map(results.map((result) => [result.requestId as string, result]));
  const answered: InboxEntry[] = [];
  const failed: { entry: InboxEntry; error: unknown }[] = [];
  for (const entry of group.entries) {
    const result = byRequest.get(entry.request.id);
    if (result?.ok === true) answered.push(entry);
    else failed.push({ entry, error: result?.error ?? "The server didn't say how it went." });
  }
  return { answered, failed };
};

const reasonOf = (error: unknown): string | undefined => {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return text.trim() === "" ? undefined : text.trim().replace(/[.:]+$/, "");
};

/**
 * What to say after a partly failed answer, each worker with the server's reason for it;
 * `undefined` when every worker took it.
 */
export const failureText = (result: GroupAnswerResult): string | undefined => {
  if (result.failed.length === 0) return undefined;
  const names = result.failed.map(({ entry, error }) => {
    const name =
      entry.project === undefined ? `“${entry.title}”` : `“${entry.title}” (${entry.project})`;
    const reason = reasonOf(error);
    return reason === undefined ? name : `${name}: ${reason}`;
  });
  const total = result.answered.length + result.failed.length;
  return `Answered ${result.answered.length} of ${total}. Not answered: ${names.join("; ")}. Open ${
    names.length === 1 ? "it" : "them"
  } to answer there.`;
};
