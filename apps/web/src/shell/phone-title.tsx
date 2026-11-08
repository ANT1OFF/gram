import type { ThreadId } from "@gram/contracts";
import { useParams, useRouterState } from "@tanstack/react-router";

import { cn } from "@/lib/utils";
import { orchestratorRowTitle } from "@/orchestration/tree-model";
import { threadStatusOf } from "@/sidebar/status";
import { useThreadsStore } from "@/stores/threads";
import { threadDisplayTitle } from "@/thread/thread-title";
import { useViewStore } from "@/views/view-store";
import { useViewSolo, useViewWorkspace } from "@/views/view-workspace";

/** The words under the phone header's title, and whether they ask for you (amber then). */
export interface PhonePlace {
  readonly title: string;
  /** "Worker: …" for a worker's title, which names its heading as the wide header's does. */
  readonly heading?: string | undefined;
  readonly line: string;
  readonly asks: boolean;
}

/** A page's own name, for the routes that show no thread. */
const PAGE_NAMES: readonly (readonly [RegExp, string])[] = [
  [/^\/new(\/|$)/, "New task"],
  [/\/memory$/, "Memory"],
  [/^\/settings(\/|$)/, "Settings"],
];

/**
 * Where the phone header says you are: a thread's title over its workspace (or Solo) and its state,
 * the Board as its workspace's name over "Board", and any other page by its name.
 */
export function usePhonePlace(): PhonePlace {
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const board = useViewStore((s) => s.view === "board");
  const workspace = useViewWorkspace();
  const solo = useViewSolo();
  const summary = useThreadsStore((s) => (threadId === undefined ? undefined : s.byId[threadId]));
  const detail = useThreadsStore((s) =>
    threadId === undefined ? undefined : s.statusDetail[threadId],
  );
  const place = solo ? "Solo" : (workspace?.workspace.name ?? "Gram");
  if (board && workspace !== undefined) {
    return { title: workspace.workspace.name, line: "Board", asks: false };
  }
  if (summary !== undefined) {
    const { thread, status } = summary;
    const orchestrator = thread.role === "orchestrator";
    const title = orchestrator
      ? orchestratorRowTitle(thread.title)
      : threadDisplayTitle(thread) || "New thread";
    const state = threadStatusOf(summary, detail).label;
    return {
      title,
      heading: thread.spawnedBy === undefined ? undefined : `Worker: ${thread.title}`,
      line: orchestrator ? `Orchestrator · ${state}` : `${place} · ${state}`,
      asks: status === "needsApproval" || status === "needsInput",
    };
  }
  const page = PAGE_NAMES.find(([pattern]) => pattern.test(pathname))?.[1];
  return { title: page ?? place, line: page === undefined ? "Chat" : place, asks: false };
}

/** The phone header's title: one line of where you are, one of its place and state under it. */
export function PhoneTitle({ className }: { className?: string }) {
  const { title, heading, line, asks } = usePhonePlace();
  return (
    <div data-testid="phone-title" className={cn("flex min-w-0 flex-1 flex-col", className)}>
      <h1
        aria-label={heading}
        className="truncate text-reading leading-5 font-semibold text-foreground"
      >
        {title}
      </h1>
      <span
        data-testid="phone-title-line"
        data-asks={asks || undefined}
        className={cn("truncate text-meta", asks ? "text-status-needs" : "text-muted-foreground")}
      >
        {line}
      </span>
    </div>
  );
}
