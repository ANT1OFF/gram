// Moving one thread to a server signed in to (docs/design/move-a-thread.md): where it can go, and
// why "Move to a server…" is greyed when it can't. The dialog draws from these.
import type { HostedDeviceView, Thread } from "@gram/contracts";

import { type MoveTarget, moveTargets } from "@/orchestration/move-targets";

/** Where a thread can move: a workspace of a server signed in to that takes threads. */
export const threadMoveTargets = (
  view: HostedDeviceView | null | undefined,
): readonly MoveTarget[] =>
  moveTargets(
    view === null || view === undefined
      ? view
      : { ...view, servers: view.servers.filter((server) => server.takesThreads === true) },
  );

export const SIGN_IN_FIRST = "Sign in to a server under Settings → Hosted first.";

/**
 * Why the thread can't move now, in the words the menu greys the item with; nothing when it can.
 * `view` is the shell's hosted state: undefined while it is read.
 */
export const threadMoveRefusal = (
  thread: Pick<Thread, "workspaceId" | "transferredTo" | "role">,
  view: HostedDeviceView | null | undefined,
): string | undefined => {
  if (thread.transferredTo !== undefined)
    return `It moved to ${thread.transferredTo.name} already. Carry on there.`;
  if (thread.workspaceId !== undefined || thread.role !== undefined)
    return "A workspace's thread moves with its workspace.";
  const signedIn = (view?.servers ?? []).filter((server) => server.signedIn && !server.paused);
  if (signedIn.length === 0) return SIGN_IN_FIRST;
  if (!signedIn.some((server) => server.takesThreads === true))
    return "The servers you're signed in to don't take threads.";
  if (threadMoveTargets(view).length === 0)
    return "None of your workspaces there can take work from this computer.";
  return undefined;
};

/** What goes with the thread, as the review lists it. */
export const goesLines = (input: {
  readonly repository?: string;
  readonly branch?: string;
}): readonly string[] => [
  "The conversation and its turns, with anything that looks like a key removed",
  `Its edits, uncommitted ones too, saved on a hidden ref of ${input.repository ?? "its repository"}, not on the branch. Whoever can read the repository can read them.`,
  ...(input.branch === undefined ? [] : [`Its branch, ${input.branch}`]),
];

/** What stays, wherever it goes. */
export const staysLines = (machine: string): readonly string[] => [
  "Your sign-ins and any keys",
  "Ignored files, such as .env, and build caches",
  `${machine.charAt(0).toUpperCase()}${machine.slice(1)}'s hooks and MCP servers`,
  "Terminals and what runs in them",
  "The agent's own session: it carries on there from the conversation",
];

/** The steps of a move under way, each done, under way or next. */
export type MoveStage = "export" | "send" | "settle";
const STAGES: readonly MoveStage[] = ["export", "send", "settle"];

export const moveSteps = (
  stage: MoveStage,
  target: Pick<MoveTarget, "name">,
): ReadonlyArray<{
  readonly key: MoveStage;
  readonly words: string;
  readonly state: "done" | "now" | "next";
}> =>
  STAGES.map((key) => ({
    key,
    words:
      key === "export"
        ? "Saving its edits on a hidden ref"
        : key === "send"
          ? `Sending it to ${target.name}, which sets up its folder`
          : "Leaving a read-only copy here",
    state: STAGES.indexOf(key) < STAGES.indexOf(stage) ? "done" : key === stage ? "now" : "next",
  }));
