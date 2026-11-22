import type { DiffFile, GramUIMessage, ModelRef, Thread, WorkspaceState } from "@gram/contracts";

import { registerMockThreadDiff } from "./mock-git";

import type { MockOrchestrationHost } from "./mock-orchestration";

const SERVER_IN_ERROR_DETAIL =
  "The orchestrator thread is in error. Open it to see why, then resume; Gram also tries again by itself from time to time.";

const OWN_CHANGES: readonly DiffFile[] = [
  {
    path: "README.md",
    status: "modified",
    additions: 2,
    deletions: 0,
    patch:
      "@@ -1,2 +1,4 @@\n # gram\n+\n+Local notes: try the new sidebar before 0.9.\n A coding workspace.",
    binary: false,
    tooLarge: false,
  },
  {
    path: "scratch/sidebar.md",
    status: "added",
    additions: 1,
    deletions: 0,
    patch: "@@ -0,0 +1 @@\n+Sidebar ideas, not for the orchestrator.",
    binary: false,
    tooLarge: false,
  },
];

const setOwnChanges = (
  host: Pick<MockOrchestrationHost, "summary" | "setGit">,
  thread: Thread,
  files: readonly DiffFile[],
) => {
  const git = host.summary(thread.id)?.git ?? {
    repo: true,
    branch: "main",
    worktree: false,
    head: "4be1c09d3c1a7e5b2f4c6d8e0a1b3c5d7e9f1a2b",
    changesToken: "",
    changedFiles: 0,
    behindBase: 0,
    aheadBase: 0,
    conflicts: false,
  };
  registerMockThreadDiff(thread.id, files, git.branch ?? "main");
  host.setGit(thread.id, {
    ...git,
    changedFiles: files.length,
    changesToken: `own-${files.length}`,
  });
};

/**
 * A fresh session that didn't open (`gram.mock.handoffFails`), as the server leaves it: the
 * orchestrator in error with the checkout's reason, and its notice. Resolves to the workspace paused.
 */
export const failHandoff = (
  host: Pick<MockOrchestrationHost, "replace" | "setStatus" | "emit" | "summary" | "setGit">,
  orchestrator: Thread,
  state: WorkspaceState,
): WorkspaceState => {
  const text = `Claude Code couldn't start: the checkout at ${orchestrator.checkout.path} already has changes of its own (${OWN_CHANGES.length} files), so the orchestrator's saved work wasn't put back.`;
  host.replace({
    ...orchestrator,
    lastError: { kind: "unknown", retryable: true, text, at: Date.now() },
  });
  setOwnChanges(host, orchestrator, OWN_CHANGES);
  host.setStatus(orchestrator.id, "error");
  host.emit({
    type: "notify",
    kind: "needsInput",
    title: `Orchestration paused: the orchestrator stopped on an error (${state.workspace.name})`,
    body: `${text} Sort that out, then resume it from its chat. Gram also tries again by itself from time to time.`,
    threadId: orchestrator.id,
  });
  return {
    ...state,
    paused: { reason: "deliveryFailed", detail: SERVER_IN_ERROR_DETAIL, at: Date.now() },
  };
};

/** Resuming after `failHandoff`: the orchestrator's next session opens. */
export const clearHandoffFailure = (
  host: Pick<MockOrchestrationHost, "replace" | "setStatus" | "summary" | "setGit">,
  orchestrator: Thread | undefined,
): void => {
  if (orchestrator?.lastError === undefined) return;
  const { lastError: _, ...cleared } = orchestrator;
  host.replace(cleared);
  setOwnChanges(host, cleared, []);
  host.setStatus(cleared.id, "idle");
};

/** What a fresh session that opened leaves in the orchestrator's transcript, as the server writes it. */
export const handoffParts = (
  current: Thread,
  options: { readonly unsaved: boolean; readonly onto: ModelRef | undefined; readonly id: string },
): GramUIMessage["parts"] => {
  const { unsaved, onto } = options;
  return [
    ...(unsaved ? [] : [{ type: "text" as const, text: "ready" }]),
    {
      type: "data-handoff",
      id: options.id,
      data: {
        ...(current.agentSessionId === undefined
          ? {}
          : { previousAgentSessionId: current.agentSessionId }),
        reason: "user",
        ...(unsaved ? { unsaved: true } : {}),
        ...(onto === undefined
          ? {}
          : {
              agent: onto.agent,
              model: onto.model,
              previousAgent: current.model.agent,
              previousModel: current.model.model,
            }),
        at: Date.now(),
      },
    },
  ];
};
