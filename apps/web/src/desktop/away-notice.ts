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
