import { PreviewCard } from "@base-ui/react/preview-card";
import type { ThreadId } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { GitPullRequestArrow, MessageSquare } from "lucide-react";
import { useMemo, type ReactElement, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { openExternalUrl } from "@/api/open-external";
import type { Api } from "@/api/types";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Hint } from "@/components/hint";
import { usePrList, PrListControls } from "./pr-list-controls";

import { cn } from "@/lib/utils";
import { ExpandPresence } from "@/motion";
import { PanelMessage } from "@/panels/panel-message";
import { useLayoutStore, type ReviewRequestsPlacement } from "@/stores/layout";
import { SectionToggle, SubgroupToggle } from "@/sidebar/section-header";
import { useThreadsStore } from "@/stores/threads";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { prRefText } from "@/components/pr-marks-model";

import { openPrMergeNote, openPrRows, type OpenPrRow } from "./open-prs-model";
import { groupByRepo, type ReviewRequestGroup } from "./review-request-model";
import {
  CARD_SURFACE,
  prContextMenuKey,
  usePrCardFocus,
  PLACEMENT_OPTIONS,
  PrStatusDetails,
  PrRowInformation,
  PrInformationDetails,
  type CardSide,
} from "./pr-display";

const openPrsQuery = (api: Api) => ({
  queryKey: ["openPrs"],
  queryFn: () => api.listOpenPrs(),
  retry: false,
});

/** The user's own open PRs, as the review-request poll found them; refetched on `openPrs.changed`. */
function useOpenPrs() {
  return useQuery(openPrsQuery(useApi()));
}

/**
 * The list's rows, joined to the threads as they are now, so an owner shows the moment a thread
 * binds its PR or a badge says it merged, without waiting for the next poll.
 */
export function useOpenPrRows(): { rows: OpenPrRow[]; checkedAt: number | undefined } {
  const { data } = useOpenPrs();
  const byId = useThreadsStore((s) => s.byId);
  const rows = useMemo(() => openPrRows(data?.prs ?? [], byId), [data, byId]);
  return { rows, checkedAt: data?.checkedAt };
}

/**
 * The same list in the right panel's Reviews tab, under the sidebar's own head, folding with it,
 * since review requests may share the tab. The space under the rows opens the menu too: it is the
 * way back to the sidebar.
 */
export function OpenPrsPanel() {
  const { rows, checkedAt } = useOpenPrRows();
  const shared = useLayoutStore((s) => s.reviewRequestsPlacement === "panel");
  const collapsed = useLayoutStore((s) => s.openPrsCollapsed);
  const toggleCollapsed = useLayoutStore((s) => s.toggleOpenPrsCollapsed);
  return (
    <section
      aria-label="Open PRs"
      data-testid="open-prs"
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-y-auto p-1",
        shared && "border-t border-border",
      )}
    >
      <OpenPrsMenu render={<h2 />}>
        <SectionToggle
          label="Open PRs"
          icon={GitPullRequestArrow}
          hue="info"
          count={rows.length}
          countTestId="open-prs-count"
          expanded={!collapsed}
          aria-controls="panel-open-prs"
          onClick={toggleCollapsed}
        />
      </OpenPrsMenu>
      {rows.length === 0 && checkedAt === undefined ? (
        <OpenPrsMenu render={<div />}>
          <PanelMessage>No open PRs yet. They need a signed-in gh.</PanelMessage>
        </OpenPrsMenu>
      ) : (
        <ExpandPresence open={!collapsed}>
          <OpenPrsList id="panel-open-prs" rows={rows} cardSide="left" />
        </ExpandPresence>
      )}
      <OpenPrsMenu render={<div className="min-h-8 flex-1" />} />
    </section>
  );
}

/** A right-click menu over one piece of the list, as `RequestsMenu` is for review requests. */
function OpenPrsMenu({
  row,
  render,
  children,
}: {
  /** The row's PR; absent on the headings and the empty space. */
  row?: OpenPrRow | undefined;
  render: ReactElement;
  children?: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={render} onKeyDown={prContextMenuKey}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="open-prs-menu">
        {row !== undefined && <RowMenuItems row={row} />}
        <ListMenuItems />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function useOpenPr() {
  const api = useApi();
  return (row: OpenPrRow) => void openExternalUrl(api, row.url).catch(() => {});
}

function useGoToThread() {
  const navigate = useNavigate();
  return (threadId: ThreadId) => void navigate({ to: "/t/$threadId", params: { threadId } });
}

/**
 * One PR's actions. A PR a thread owns leads to it; one nothing owns can be checked out into a new
 * thread, when a known project holds its repository.
 */
function RowMenuItems({ row }: { row: OpenPrRow }) {
  const open = useOpenPr();
  const goTo = useGoToThread();
  const { owner, projectRoot } = row;
  return (
    <>
      <ContextMenuItem onClick={() => open(row)}>Open on GitHub</ContextMenuItem>
      {owner !== undefined && (
        <ContextMenuItem onClick={() => goTo(owner)}>Go to thread</ContextMenuItem>
      )}
      {owner === undefined && projectRoot !== undefined && (
        <ContextMenuItem
          onClick={() =>
            useThreadDialogs
              .getState()
              .open({ kind: "checkoutPr", projectRoot, prRef: prRefText(row) })
          }
        >
          Check out…
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
    </>
  );
}

/** How the list is laid out and where; the poll and its sign-in are Review requests'. */
function ListMenuItems() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const grouped = useLayoutStore((s) => s.openPrsGrouped);
  const setGrouped = useLayoutStore((s) => s.setOpenPrsGrouped);
  const placement = useLayoutStore((s) => s.openPrsPlacement);
  const setPlacement = useLayoutStore((s) => s.setOpenPrsPlacement);
  return (
    <>
      <ContextMenuCheckboxItem checked={grouped} onCheckedChange={setGrouped}>
        Group by repository
      </ContextMenuCheckboxItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Show in</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuRadioGroup
            value={placement}
            onValueChange={(next: ReviewRequestsPlacement) => setPlacement(next)}
          >
            {PLACEMENT_OPTIONS.map((option) => (
              <ContextMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </ContextMenuRadioItem>
            ))}
          </ContextMenuRadioGroup>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() => {
          // One poll finds both lists, so both are fresh after it.
          api
            .refreshReviewRequests({ force: true })
            .then(() =>
              Promise.all([
                queryClient.invalidateQueries({ queryKey: ["openPrs"] }),
                queryClient.invalidateQueries({ queryKey: ["reviewRequests"] }),
              ]),
            )
            .catch((error: unknown) => console.error("open prs: refresh", error));
        }}
      >
        Check now
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() =>
          void navigate({ to: "/settings/notifications", search: { highlight: "open prs" } })
        }
      >
        Settings…
      </ContextMenuItem>
    </>
  );
}

function OpenPrsList({
  id,
  rows,
  cardSide,
}: {
  id?: string | undefined;
  rows: readonly OpenPrRow[];
  cardSide: CardSide;
}) {
  const grouped = useLayoutStore((s) => s.openPrsGrouped);
  if (rows.length === 0) {
    return (
      <OpenPrsMenu
        render={<p id={id} className="py-1 pr-1 pl-3 text-[11px] text-muted-foreground" />}
      >
        None open right now.
      </OpenPrsMenu>
    );
  }
  return <FilteredOpenPrs id={id} rows={rows} grouped={grouped} cardSide={cardSide} />;
}

function FilteredOpenPrs({
  id,
  rows,
  grouped,
  cardSide,
}: {
  id?: string | undefined;
  rows: readonly OpenPrRow[];
  grouped: boolean;
  cardSide: CardSide;
}) {
  const { options, setOptions, visible } = usePrList(rows);
  return (
    <div id={id} className="flex min-w-0 flex-col">
      <PrListControls
        label="Open PRs"
        options={options}
        setOptions={setOptions}
        total={rows.length}
        shown={visible.length}
      />
      {visible.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-muted-foreground">No PRs match this view.</p>
      ) : !grouped ? (
        <ul className="flex flex-col">
          {visible.map((row) => (
            <OpenPrRowItem key={prRefText(row)} row={row} cardSide={cardSide} />
          ))}
        </ul>
      ) : (
        groupByRepo(visible).map((group) => (
          <OpenPrRepoGroup key={group.repo} group={group} cardSide={cardSide} />
        ))
      )}
    </div>
  );
}

function OpenPrRepoGroup({
  group,
  cardSide,
}: {
  group: ReviewRequestGroup<OpenPrRow>;
  cardSide: CardSide;
}) {
  const collapsed = useLayoutStore((s) => s.openPrsCollapsedRepos.includes(group.repo));
  const toggle = useLayoutStore((s) => s.toggleOpenPrsRepoCollapsed);
  return (
    <section aria-label={group.repo} data-testid="open-pr-group">
      <OpenPrsMenu render={<h3 />}>
        <SubgroupToggle
          label={group.repo}
          count={group.requests.length}
          expanded={!collapsed}
          onClick={() => toggle(group.repo)}
        />
      </OpenPrsMenu>
      <ExpandPresence open={!collapsed}>
        <ul className="flex flex-col">
          {group.requests.map((row) => (
            <OpenPrRowItem key={row.number} row={row} grouped cardSide={cardSide} />
          ))}
        </ul>
      </ExpandPresence>
    </section>
  );
}

/** The thread's title, live; `undefined` while no thread owns the PR or the thread is gone. */
const useOwnerTitle = (owner: ThreadId | undefined) =>
  useThreadsStore((s) => (owner === undefined ? undefined : s.byId[owner]?.thread.title));

/** What a row has no room for: the whole title, its head branch and owner, and its marks in words. */
function OpenPrCard({ row }: { row: OpenPrRow }) {
  const note = openPrMergeNote(row);
  const owner = useOwnerTitle(row.owner);
  return (
    <>
      <p className="break-all text-xs text-muted-foreground">{prRefText(row)}</p>
      <p className="break-words font-medium">{row.title || prRefText(row)}</p>
      <PrInformationDetails pr={row} />
      {owner !== undefined && (
        <p className="truncate text-xs text-muted-foreground">In the thread “{owner}”</p>
      )}
      <PrStatusDetails pr={row} />
      {note !== undefined && <p className="text-xs text-muted-foreground">{note}</p>}
    </>
  );
}

/**
 * One PR. The row is one button that opens it on GitHub, stretched under its text, so the owning
 * thread's link can sit in the text above it without nesting one button in another.
 */
function OpenPrRowItem({
  row,
  grouped = false,
  cardSide,
}: {
  row: OpenPrRow;
  /** Under its repository's heading, so the row names only the number. */
  grouped?: boolean;
  cardSide: CardSide;
}) {
  const open = useOpenPr();
  const goTo = useGoToThread();
  const ownerId = row.owner;
  const owner = useOwnerTitle(ownerId);
  const ref = prRefText(row);
  const { setTriggerRef, popupRef, triggerKey, popupKey } = usePrCardFocus();
  return (
    <OpenPrsMenu
      row={row}
      render={
        <li
          data-testid="open-pr"
          data-draft={row.isDraft}
          className={cn(
            "relative flex min-w-0 rounded-(--sidebar-row-radius) py-1.5 pr-2 text-xs hover:bg-sidebar-row-hover",
            grouped ? "pl-7" : "pl-3",
          )}
        />
      }
    >
      <PreviewCard.Root>
        <PreviewCard.Trigger
          render={<button type="button" />}
          ref={setTriggerRef}
          onKeyDown={triggerKey}
          aria-description="ArrowDown focuses details for keyboard scrolling; Escape returns to this PR."
          delay={300}
          aria-label={`Open ${ref} on GitHub: ${row.title}`}
          onClick={() => open(row)}
          className="flex min-w-0 flex-1 flex-col rounded-(--sidebar-row-radius) text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PrRowInformation pr={row} grouped={grouped} glyphTestId="open-pr-glyph" />
        </PreviewCard.Trigger>
        <PreviewCard.Portal>
          <PreviewCard.Positioner side={cardSide} sideOffset={8} className="isolate z-50">
            <PreviewCard.Popup
              ref={popupRef}
              onKeyDown={popupKey}
              role="region"
              aria-label={`Details for ${ref}`}
              data-testid="open-pr-card"
              data-surface="overlay"
              className={cn(
                CARD_SURFACE,
                prContextMenuKey,
                "flex w-80 max-w-[calc(100vw-24px)] max-h-[min(var(--available-height),calc(100dvh-24px))] flex-col gap-2 overflow-y-auto overscroll-contain p-3 text-sm focus-visible:ring-2 focus-visible:ring-ring [&>*]:shrink-0",
              )}
            >
              <OpenPrCard row={row} />
            </PreviewCard.Popup>
          </PreviewCard.Positioner>
        </PreviewCard.Portal>
      </PreviewCard.Root>
      {ownerId !== undefined && owner !== undefined && (
        <Hint
          label={`Go to thread: ${owner}`}
          render={
            <button
              type="button"
              data-testid="open-pr-owner"
              aria-label={`Go to thread: ${owner}`}
              onClick={() => goTo(ownerId)}
              className="ml-1 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <MessageSquare aria-hidden className="size-3" />
        </Hint>
      )}
    </OpenPrsMenu>
  );
}
