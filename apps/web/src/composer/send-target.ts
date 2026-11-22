import {
  embeddingOn,
  type HostedDeviceView,
  type HostedMachine,
  hostedMachineReady,
  NO_MACHINE_RUNNING,
} from "@gram/contracts";
import { useCallback, useMemo, useState } from "react";

import { serverUrl } from "@/api/server-base";
import { useSubscription } from "@/lib/effects";
import { useServerSettings } from "@/settings-sync/store";
import { withOriginKey } from "../api/origin-key";

/** A hosted workspace New task may send to. */
export interface SendTarget {
  readonly origin: string;
  readonly server: string;
  readonly host: string;
  readonly workspaceId: string;
  readonly workspace: string;
  readonly organisation: string;
}

export const sendTargetKey = (target: Pick<SendTarget, "origin" | "workspaceId">): string =>
  `${target.origin} ${target.workspaceId}`;

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** Each listed workspace of a server signed in to, not paused, that runs work sent to it. */
export const sendTargetsOf = (view: HostedDeviceView | null | undefined): SendTarget[] =>
  (view?.servers ?? [])
    .filter((server) => server.signedIn && !server.paused && server.runsWork === true)
    .flatMap((server) =>
      server.workspaces.map((workspace) => ({
        origin: server.origin,
        server: server.name,
        host: hostOf(server.origin),
        workspaceId: workspace.id,
        workspace: workspace.name,
        organisation: workspace.organisation,
      })),
    );

/** Where a task may go now: none unless the hosted features are on in the desktop app. */
export function useSendTargets(): readonly SendTarget[] {
  const hosted = useServerSettings((s) => s.settings !== undefined && embeddingOn(s.settings));
  const bridge = typeof window === "undefined" ? undefined : window.gram?.hostedDevice;
  const [view, setView] = useState<HostedDeviceView | null>();
  const read = useCallback(() => {
    if (bridge === undefined) return;
    void bridge.state().then(setView, () => setView(null));
  }, [bridge]);
  useSubscription(() => {
    if (!hosted || bridge === undefined) return undefined;
    read();
    return bridge.onChange(read);
  }, [hosted, bridge, read]);
  return useMemo(() => (hosted ? sendTargetsOf(view) : []), [hosted, view]);
}

/** What `/threads/send-check` answers, as read here. */
export interface SendCheck {
  readonly repository?: string;
  readonly orchestrator: boolean;
  /** What a thread started there now opens on, when the server said. */
  readonly model?: { readonly agent: string; readonly model: string };
  readonly local: {
    readonly current?: string;
    readonly base?: { readonly branch: string; readonly sha: string };
    readonly ahead: number;
    readonly uncommitted: { readonly count: number; readonly first?: string };
  };
  /** Absent when the server couldn't be asked: the send is still the server's to refuse. */
  readonly reach?: {
    readonly repository?: string;
    readonly reach: "yes" | "no" | "unknown";
    readonly reason?: string;
  };
  /**
   * The person's own machine there, when the server starts one from here; `unoffered` when it
   * doesn't, and absent when it couldn't be asked.
   */
  readonly machine?: HostedMachine | "unoffered";
}

/** Whether a send there starts the person's machine first: the server offers it, and it isn't up. */
export const sendStartsMachine = (check: SendCheck | undefined): boolean =>
  check?.machine !== undefined && check.machine !== "unoffered";

/** One of the checks: `block` stops the send, `warn` only says so. */
export interface SendCheckRow {
  readonly id: "reach" | "base" | "uncommitted" | "orchestrator" | "machine" | "attachments";
  readonly state: "ok" | "warn" | "block";
  readonly title: string;
  readonly detail?: string;
}

const files = (count: number) =>
  count === 1 ? "1 uncommitted file" : `${count} uncommitted files`;
const commits = (count: number) => (count === 1 ? "1 commit" : `${count} commits`);

/** The checks as New task says them, for `target` and the computer they stay on. */
export const sendCheckRows = (
  check: SendCheck,
  target: SendTarget,
  here: string,
): SendCheckRow[] => {
  const rows: SendCheckRow[] = [];
  const repository = check.repository;
  if (repository === undefined)
    rows.push({
      id: "reach",
      state: "block",
      title: "This repository has no remote a server could clone",
      detail: "The work goes from the remote, never from this computer. Add an origin first.",
    });
  else if (check.reach?.reach === "yes")
    rows.push({
      id: "reach",
      state: "ok",
      title: "The server reaches the repository",
      detail: `${repository}, through your GitHub access on ${target.host}.`,
    });
  else if (check.reach?.reach === "no")
    rows.push({
      id: "reach",
      state: "block",
      title: "The server can't reach this repository",
      detail: `${repository}: ${check.reach.reason ?? `it isn't in your GitHub access on ${target.host}.`}`,
    });
  else if (check.reach?.reach === "unknown")
    rows.push({
      id: "reach",
      state: "warn",
      title: "Couldn't check that the server reaches the repository",
      detail: `${check.reach.reason ?? `${target.server} didn't say.`} The send still asks it.`,
    });
  const { base, ahead, current } = check.local;
  if (base === undefined)
    rows.push({
      id: "base",
      state: "block",
      title: "Nothing is pushed to start from",
      detail: "The worker starts from the remote's default branch. Push it, or fetch, first.",
    });
  else if (current === base.branch && ahead > 0)
    rows.push({
      id: "base",
      state: "block",
      title: `${base.branch} isn't pushed`,
      detail: `${commits(ahead)} are only on ${here}. The worker starts from origin/${base.branch} at ${base.sha}. Push them first.`,
    });
  else if (current !== undefined && current !== base.branch)
    rows.push({
      id: "base",
      state: "warn",
      title: `The worker starts from origin/${base.branch}, not ${current}`,
      detail: `It branches from origin/${base.branch} at ${base.sha}${ahead > 0 ? `; ${commits(ahead)} on ${current} stay on ${here}` : ""}.`,
    });
  else
    rows.push({
      id: "base",
      state: "ok",
      title: `${base.branch} is pushed`,
      detail: `The worker branches from origin/${base.branch} at ${base.sha}.`,
    });
  const { count, first } = check.local.uncommitted;
  if (count > 0)
    rows.push({
      id: "uncommitted",
      state: "warn",
      title: `${files(count)} stay on ${here}`,
      detail: `${first ?? "Changes"}${count > 1 ? ` and ${count - 1} more` : ""}. The worker won't see them.`,
    });
  const machine = check.machine;
  if (machine !== undefined && machine !== "unoffered" && !hostedMachineReady(machine))
    rows.push({
      id: "machine",
      state: "ok",
      title: "Sending starts your machine there",
      detail:
        machine.starting === true || machine.phase === "pending" || machine.phase === "starting"
          ? "It's starting now. The task goes once it runs."
          : `It isn't running now. A new one takes a minute or two; the task goes once it runs.`,
    });
  if (!check.orchestrator)
    rows.push({
      id: "orchestrator",
      state: "block",
      title: "This workspace has no orchestrator to report to yet",
      detail: "Start a task here first; a sent task reports to it.",
    });
  return rows;
};

const agents: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex" };

/** "Claude · <model>", as the model a sent task runs on is named. */
export const sentModelLabel = (model: { readonly agent: string; readonly model: string }) =>
  `${agents[model.agent] ?? model.agent} · ${model.model}`;

export class SendWorkError extends Error {}

const post = async (path: string, body: unknown, fallback: string): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(
      serverUrl(path),
      withOriginKey({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  } catch {
    throw new SendWorkError(fallback);
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (response.ok) return value;
  const said =
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
      ? value.error
      : undefined;
  throw new SendWorkError(said ?? fallback);
};

export const checkSend = async (input: {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly target: Pick<SendTarget, "origin" | "workspaceId">;
}): Promise<SendCheck> => {
  const answer = await post(
    "/threads/send-check",
    {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      target: { origin: input.target.origin, workspaceId: input.target.workspaceId },
    },
    "Couldn't check where the task goes.",
  );
  if (typeof answer !== "object" || answer === null || !("local" in answer))
    throw new SendWorkError("Couldn't check where the task goes.");
  return answer as SendCheck;
};

/** How a start of the person's machine there stands, as `/threads/send-machine` answers. */
export type MachineProgress =
  | { readonly state: "unoffered" }
  | { readonly state: "starting"; readonly phase: string }
  | { readonly state: "ready"; readonly phase: string }
  | { readonly state: "failed"; readonly why: string };

/**
 * Starts the person's own machine there unless it runs, and says how it stands. Asked again while
 * it starts, it only says; the local server asks the desktop app, which holds the sign-in.
 */
export const startSendMachine = async (
  target: Pick<SendTarget, "origin" | "workspaceId">,
): Promise<MachineProgress> => {
  const answer = await post(
    "/threads/send-machine",
    { target: { origin: target.origin, workspaceId: target.workspaceId } },
    "Couldn't start your machine there.",
  );
  const state =
    typeof answer === "object" && answer !== null && "state" in answer ? answer.state : undefined;
  if (state !== "unoffered" && state !== "starting" && state !== "ready" && state !== "failed")
    throw new SendWorkError("Couldn't start your machine there.");
  return answer as MachineProgress;
};

/** What New task says while the machine starts, by the phase the server named. */
export const machineLine = (progress: MachineProgress, target: SendTarget): string => {
  if (progress.state !== "starting") return `Sending to ${target.workspace}…`;
  const step =
    progress.phase === "pending"
      ? "waiting for room"
      : progress.phase === "starting"
        ? "booting"
        : progress.phase === "running"
          ? "joining"
          : undefined;
  return `Starting your machine on ${target.host}${step === undefined ? "" : ` — ${step}`}…`;
};

/** Whether a send was refused for want of a machine running there: one just started may yet join. */
export const refusedForMachine = (error: unknown): boolean =>
  error instanceof SendWorkError && error.message.includes(NO_MACHINE_RUNNING);

export const sendTask = async (input: {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly target: Pick<SendTarget, "origin" | "workspaceId">;
  readonly text: string;
  readonly clientRequestId: string;
}): Promise<{ readonly threadId: string }> => {
  const answer = await post(
    "/threads/send",
    {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      target: { origin: input.target.origin, workspaceId: input.target.workspaceId },
      text: input.text,
      clientRequestId: input.clientRequestId,
    },
    "The task couldn't be sent.",
  );
  const threadId =
    typeof answer === "object" && answer !== null && "threadId" in answer
      ? answer.threadId
      : undefined;
  if (typeof threadId !== "string") throw new SendWorkError("The task couldn't be sent.");
  return { threadId };
};
