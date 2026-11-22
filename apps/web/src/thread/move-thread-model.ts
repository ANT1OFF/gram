import type { HostedDeviceView, Thread } from "@gram/contracts";

import { type MoveTarget, moveTargets, targetKey } from "@/orchestration/move-targets";

/** Where a thread can move: a workspace of a server signed in to that takes threads. */
export const threadMoveTargets = (
  view: HostedDeviceView | null | undefined,
): readonly MoveTarget[] =>
  moveTargets(
    view === null || view === undefined
      ? view
      : { ...view, servers: view.servers.filter((server) => server.takesThreads === true) },
  );

/**
 * Where the move goes: the one place there is, or the one the person picked among several. Never
 * the first of several by default, so a thread can't go to a workspace nobody chose.
 */
export const chosenTarget = (
  targets: readonly MoveTarget[],
  picked: string | undefined,
): MoveTarget | undefined =>
  targets.length === 1 ? targets[0] : targets.find((each) => targetKey(each) === picked);

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

/** Where a thread that moved to a server comes back from: that server and workspace, by name. */
export interface BringBackSource {
  readonly origin: string;
  readonly workspace: string;
  /** The workspace's name there, in the server's words; its id while the server hasn't listed it. */
  readonly name: string;
  readonly host: string;
}

/**
 * Where the thread can be brought back from, or why not in the words the notice says it with.
 * Nothing at all for a thread that didn't go to a server signed in to from here, or a shell that
 * can't ask for one back.
 */
export const bringBackFrom = (
  thread: Pick<Thread, "transferredTo">,
  view: HostedDeviceView | null | undefined,
): BringBackSource | { readonly why: string } | undefined => {
  const at = thread.transferredTo?.server;
  if (at === undefined || view === undefined || view === null) return undefined;
  const server = view.servers.find((each) => each.origin === at.origin);
  if (server === undefined || !server.signedIn)
    return { why: `Sign in to ${hostOf(at.origin)} under Settings → Hosted to bring it back.` };
  if (server.givesThreads !== true) return { why: "That server doesn't give threads back." };
  if (server.paused)
    return {
      why: "You paused this computer for that server. Lift the pause under Settings → Hosted first.",
    };
  const workspace = server.workspaces.find((each) => each.id === at.workspaceId);
  if (workspace === undefined) return { why: "Its workspace there isn't one of yours any more." };
  return {
    origin: at.origin,
    workspace: at.workspaceId,
    name: workspace.name,
    host: hostOf(at.origin),
  };
};

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** What comes back with the thread, as the review lists it. */
export const comesLines = (facts: { readonly branch?: string }): readonly string[] => [
  "The conversation, with what it did there",
  "Its edits, uncommitted ones too",
  facts.branch === undefined ? "Its branch" : `Its branch, ${facts.branch}`,
];

/** What a bring-back does, step by step, as the dialog shows it under way. */
export type BringStage = "fetch" | "import" | "settle";

export const bringSteps = (
  stage: BringStage,
  from: BringBackSource,
): ReadonlyArray<{ key: BringStage; words: string; state: "done" | "now" | "next" }> => {
  const order: readonly BringStage[] = ["fetch", "import", "settle"];
  const words: Record<BringStage, string> = {
    fetch: `Asking ${from.name} for it`,
    import: "Putting it back here, with its edits",
    settle: `Making the copy on ${from.name} read-only`,
  };
  const at = order.indexOf(stage);
  return order.map((key, index) => ({
    key,
    words: words[key],
    state: index < at ? "done" : index === at ? "now" : "next",
  }));
};

/** What goes with the thread besides its edits, which the review lists by file. */
export const goesLines = (input: { readonly branch?: string }): readonly string[] => [
  "The conversation, with anything that looks like a key removed",
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
