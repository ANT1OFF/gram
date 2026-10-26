import type { ThreadId } from "@gram/contracts";
import { createContext, use, useMemo, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import { PR_STATE_DISPLAY, prStateMarkOf } from "@/components/pr-marks-model";
import { cn } from "@/lib/utils";
import { useOrchestratorLedger, useWorkspaces } from "@/orchestration/use-orchestration";
import { useThreadsStore } from "@/stores/threads";

import {
  EMPTY_PR_REF_INDEX,
  PR_REF_TAG,
  prRefIndexOf,
  resolvePrRef,
  type PrRefIndex,
} from "./pr-refs";

/**
 * What the transcript's references resolve against. A context rather than a plugin option, because
 * a message's markdown isn't re-rendered when only the thread's PRs change.
 */
export const PrRefsContext = createContext<PrRefIndex>(EMPTY_PR_REF_INDEX);

/** Provides `threadId`'s PRs, and an orchestrator's workers' PRs from its live ledger. */
export function PrRefsProvider({
  threadId,
  children,
}: {
  threadId: ThreadId;
  children: ReactNode;
}) {
  const git = useThreadsStore((s) => s.byId[threadId]?.git);
  const boundPr = useThreadsStore((s) => s.byId[threadId]?.thread.boundPr);
  const extraPrs = useThreadsStore((s) => s.byId[threadId]?.thread.extraPrs);
  const workspaceId = useThreadsStore((s) => {
    const thread = s.byId[threadId]?.thread;
    return thread?.role === "orchestrator" ? thread.workspaceId : undefined;
  });
  const extraCheckouts = useThreadsStore((s) => s.byId[threadId]?.thread.extraCheckouts?.length);
  const projects = useWorkspaces().find((state) => state.workspace.id === workspaceId)?.workspace
    .projectIds.length;
  const { data: ledger } = useOrchestratorLedger(workspaceId);
  // An orchestrator whose workspace isn't loaded yet may be in any number of repositories.
  const repoCount =
    workspaceId === undefined ? 1 + (extraCheckouts ?? 0) : (projects ?? Number.POSITIVE_INFINITY);
  const index = useMemo(
    () =>
      prRefIndexOf({
        git,
        boundPr,
        extraPrs,
        workers: ledger?.features.flatMap((feature) => feature.workers),
        repoCount,
      }),
    [git, boundPr, extraPrs, ledger, repoCount],
  );
  return <PrRefsContext value={index}>{children}</PrRefsContext>;
}

/** Streamdown's link style, so a reference reads like any other link in the message. */
const LINK = "wrap-anywhere font-medium text-primary underline";

function PrRefLink({
  "data-repo": repo,
  "data-number": number,
  "data-url": url,
  children,
}: {
  "data-repo"?: string;
  "data-number"?: string;
  "data-url"?: string;
  children?: ReactNode;
}) {
  const api = useApi();
  const index = use(PrRefsContext);
  const target = resolvePrRef({ repo, number: Number(number), url }, index);
  if (target === undefined) return <>{children}</>;
  // A PR the thread knows the state of carries its glyph, as everywhere else Gram draws a PR.
  const state = target.state;
  const display = state === undefined ? undefined : PR_STATE_DISPLAY[state];
  const word =
    state === undefined
      ? undefined
      : prStateMarkOf({ state: state === "draft" ? "open" : state, isDraft: state === "draft" })
          .word;
  return (
    <a
      href={target.url}
      title={`${target.repo}#${target.number}${word === undefined ? "" : ` · ${word}`}`}
      data-pr-state={state}
      className={LINK}
      onClick={(event) => {
        event.preventDefault();
        openExternalUrl(api, target.url).catch((error: unknown) =>
          console.error("pr ref: open", error),
        );
      }}
    >
      {display !== undefined && (
        <display.icon
          aria-hidden
          className={cn("mr-0.5 inline size-3.5 align-[-0.15em]", display.tone)}
        />
      )}
      {children}
      {word !== undefined && <span className="sr-only">, {word.toLowerCase()}</span>}
    </a>
  );
}

export const PR_REF_COMPONENTS = { [PR_REF_TAG]: PrRefLink };
