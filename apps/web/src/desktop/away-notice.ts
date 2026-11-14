import type { ThreadId, WorkspaceId } from "@gram/contracts";

import {
  askFingerprint,
  askScope,
  awayAsk,
  awayAskId,
  templateTitle,
  type AwayButton,
  type ShownAsk,
} from "@/orchestration/ask-actions";
import type { Ask } from "@/orchestration/ask-model";

// An ask's desktop notification, built from the ask the stack shows through the shared away rule
// (`orchestration/ask-actions.ts`): the same command, the same Allow. No React. The title is a
// template's, or the helper's when it is on.

export interface AwayNotice extends ShownAsk {
  /** The notification's id: the same for the same ask, in its workspace and threads, in every window. */
  readonly id: string;
  /** Where Open goes: the stack on the workspace's orchestrator, else the asking thread. */
  readonly openThreadId: ThreadId | undefined;
  readonly title: string;
  readonly subtitle: string;
  readonly body: string;
  /** Allow or Merge; absent for Open only. */
  readonly button?: AwayButton | undefined;
}

/** The notification for `ask` in a workspace. */
export const buildNotice = ({
  ask,
  workspaceId,
  workspaceName,
  orchestratorThreadId,
  title,
  actions,
}: {
  readonly ask: Ask;
  readonly workspaceId: WorkspaceId;
  readonly workspaceName: string;
  readonly orchestratorThreadId: ThreadId | undefined;
  /** The helper's title, already checked; the template's otherwise. */
  readonly title?: string | undefined;
  /** Notification actions are on. */
  readonly actions: boolean;
}): AwayNotice => {
  const shown = awayAsk(ask, actions);
  return {
    id: awayAskId(askScope(ask, workspaceId)),
    askKey: ask.key,
    fingerprint: askFingerprint(ask),
    workspaceId,
    openThreadId: orchestratorThreadId ?? ask.group?.entries[0]?.threadId,
    title: title ?? templateTitle(ask),
    subtitle: `${workspaceName} · ${ask.context}`,
    body: shown.text,
    ...(shown.button === undefined ? {} : { button: shown.button }),
  };
};

/** The id of the one notification that stands for several asks. */
export const SUMMARY_ID = "gram-asks-waiting";
/** How many asks the shared notification names before it counts the rest. */
const SUMMARY_LINES = 3;

/**
 * The one notification for `notices`, the asks waiting together, oldest first: how many, in which
 * workspaces, and what the first few are. It carries no Allow: several asks have no one answer.
 */
export const buildSummary = (
  notices: readonly AwayNotice[],
): Pick<AwayNotice, "title" | "subtitle" | "body" | "openThreadId"> => {
  const workspaces = [...new Set(notices.map((notice) => notice.subtitle.split(" · ")[0] ?? ""))];
  const more = notices.length - SUMMARY_LINES;
  return {
    title: `${notices.length} asks are waiting for you`,
    subtitle: workspaces.length === 1 ? workspaces[0]! : `${workspaces.length} workspaces`,
    body: [
      ...notices.slice(0, SUMMARY_LINES).map((notice) => notice.title),
      ...(more > 0 ? [`and ${more} more`] : []),
    ].join("\n"),
    openThreadId: notices[0]?.openThreadId,
  };
};
