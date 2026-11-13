import type { ThreadId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

import { openThreadPanel } from "@/components/git-badges";
import { cn } from "@/lib/utils";
import { ROUND } from "@/shell/phone-menu";
import { usePhonePlace } from "@/shell/phone-title";
import { useWorkspacePlaces } from "@/shell/titlebar-path";
import { useLayoutStore, type RightPanelTab } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

// A phone has no room for a thread's panels beside its chat, and nothing on the chat said they
// were there: they opened from the pull request's row alone. So a thread on a phone has a row under
// its title naming the conversation and the panels a thread is worked from, and an open panel has a
// header of its own that names the panel and its thread, with a worded way back.

/** The panels the row names, in the panel's own order; the rarer ones are in the open panel's strip. */
export const PHONE_PANELS: readonly { readonly tab: RightPanelTab; readonly label: string }[] = [
  { tab: "diff", label: "Diff" },
  { tab: "pr", label: "PR" },
  { tab: "files", label: "Files" },
  { tab: "terminal", label: "Terminal" },
];

/** The panel's name for the phone header, for a tab the row doesn't carry too. */
export const phonePanelName = (tab: string): string =>
  PHONE_PANELS.find((panel) => panel.tab === tab)?.label ??
  `${tab.slice(0, 1).toUpperCase()}${tab.slice(1)}`;

const SEGMENT =
  "flex h-9 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg px-1 text-meta whitespace-nowrap outline-none transition-[background-color,scale] duration-(--dur-fast) ease-(--ease-out) focus-visible:ring-2 focus-visible:ring-ring motion-safe:active:scale-[0.97]";

/**
 * Under a phone thread's title: the conversation, selected, and the thread's panels beside it, one
 * tap each. A changed file count stands beside Diff, so the row says there is something to read.
 */
export function PhonePanelRow() {
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined;
  const changed = useThreadsStore((s) =>
    threadId === undefined ? 0 : (s.byId[threadId]?.git?.changedFiles ?? 0),
  );
  if (threadId === undefined) return null;
  return (
    <nav
      aria-label="Thread and its panels"
      data-testid="phone-panel-row"
      className="mx-3 mb-1 flex shrink-0 gap-0.5 rounded-xl bg-muted p-0.5"
    >
      <span
        aria-current="page"
        data-testid="phone-panel-chat"
        className={cn(SEGMENT, "bg-background font-semibold text-foreground shadow-raised")}
      >
        Chat
      </span>
      {PHONE_PANELS.map(({ tab, label }) => (
        <button
          key={tab}
          type="button"
          data-testid={`phone-panel-${tab}`}
          aria-label={
            tab === "diff" && changed > 0
              ? `${label}, ${changed} ${changed === 1 ? "file" : "files"} changed`
              : label
          }
          className={cn(SEGMENT, "text-muted-foreground hover:text-foreground")}
          onClick={() => openThreadPanel(threadId, tab)}
        >
          {label}
          {tab === "diff" && changed > 0 && (
            <span aria-hidden className="tabular-nums opacity-80">
              {changed}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}

/**
 * An open panel's header on a phone, where it covers the chat: Back to the thread, then the
 * panel's name over the thread it belongs to.
 */
export function PhonePanelHeader({ tab, centred }: { tab: string; centred: boolean }) {
  const { title } = usePhonePlace();
  const setExpanded = useLayoutStore((s) => s.setPanelExpanded);
  return (
    <header
      data-testid="phone-panel-header"
      className={cn(
        "flex shrink-0 items-center gap-2 px-3",
        centred ? "h-17" : "h-14 border-b border-border px-1",
      )}
    >
      <button
        type="button"
        aria-label="Back to the thread"
        data-testid="phone-panel-back"
        className={centred ? ROUND : "grid size-11 shrink-0 place-items-center rounded-md"}
        onClick={() => setExpanded(false)}
      >
        <ChevronLeft aria-hidden className="size-5" />
      </button>
      <div className={cn("flex min-w-0 flex-1 flex-col", centred && "items-center text-center")}>
        <h1 className="max-w-full truncate text-reading leading-5 font-semibold text-foreground">
          {phonePanelName(tab)}
        </h1>
        <span
          data-testid="phone-panel-thread"
          className="max-w-full truncate text-meta text-muted-foreground"
        >
          {title}
        </span>
      </div>
      {/* The title stays centred between the button and its width again. */}
      {centred && <span aria-hidden className="size-11 shrink-0" />}
    </header>
  );
}

/**
 * Under the title of a workspace's place on a phone (its orchestrator's thread, its Board, its
 * Memory): the three, one tap each, the one open selected. A phone has no bar beside the path to
 * hold them, and the Board was otherwise a menu away.
 */
export function PhoneWorkspaceRow() {
  const places = useWorkspacePlaces(false);
  if (places === undefined || !places.some((place) => place.current)) return null;
  return (
    <nav
      aria-label="Workspace"
      data-testid="phone-workspace-row"
      className="mx-3 mb-1 flex shrink-0 gap-0.5 rounded-xl bg-muted p-0.5"
    >
      {places.map((place) => (
        <button
          key={place.key}
          type="button"
          aria-current={place.current ? "page" : undefined}
          data-testid={`phone-workspace-${place.key}`}
          className={cn(
            SEGMENT,
            place.current
              ? "bg-background font-semibold text-foreground shadow-raised"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={place.current ? undefined : place.go}
        >
          {place.label}
        </button>
      ))}
    </nav>
  );
}
