import { PreviewCard } from "@base-ui/react/preview-card";
import type { PrStatus, ReviewRequest, ReviewRequests } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, type ReactElement, type ReactNode } from "react";

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
import { cn } from "@/lib/utils";
import { ExpandPresence } from "@/motion";
import { PanelMessage } from "@/panels/panel-message";
import { SubgroupToggle } from "@/sidebar/section-header";
import { useServerSettings } from "@/settings-sync/store";
import { useLayoutStore, type ReviewRequestsPlacement } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import {
  botReviewedRepos,
  heldForMissingBot,
  MAX_AGE_OPTIONS,
  maxAgePatch,
  noBotRepoPatch,
  suggestedBotRepos,
  useReviewRequestFilters,
  withBotRepo,
  type MaxAgeChoice,
} from "./review-request-filters";
import {
  groupByRepo,
  reviewRequestWaitingOn,
  type ReviewRequestGroup,
} from "./review-request-model";

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

import { usePrList, PrListControls } from "./pr-list-controls";
import { prRefText } from "@/components/pr-marks-model";

// Keep the settings consumer's existing import path while both lists use the shared display.
export { PLACEMENT_OPTIONS } from "./pr-display";

const reviewRequestsQuery = (api: Api) => ({
  queryKey: ["reviewRequests"],
  queryFn: () => api.listReviewRequests(),
  retry: false,
});

/** Open PRs requesting the user's review; refetched when the server says the list changed. */
export function useReviewRequests() {
  return useQuery(reviewRequestsQuery(useApi()));
}

/** Mount once: asks the server to poll again when the window regains focus (it throttles). */
export function useRefreshReviewRequestsOnFocus() {
  const api = useApi();
  useEffect(() => {
    const refresh = () => {
      api.refreshReviewRequests().catch(() => {
        // Nothing to say: the next scheduled poll tries again.
      });
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [api]);
}

type ThreadsById = ReturnType<typeof useThreadsStore.getState>["byId"];

/** The PR badges the open threads carry, a thread's extra PRs included. */
const threadPrs = (byId: ThreadsById): PrStatus[] =>
  Object.values(byId).flatMap((summary) => [
    ...(summary.git?.pr === undefined ? [] : [summary.git.pr]),
    ...(summary.git?.extraPrs ?? []),
  ]);

/** The repositories to suggest for the review-bot list, from what the app holds right now. */
function currentBotRepoSuggestions(requests: ReviewRequests | undefined): string[] {
  const prRepos = botReviewedRepos(threadPrs(useThreadsStore.getState().byId));
  return suggestedBotRepos(requests?.requests ?? [], prRepos);
}

/** The repositories to suggest for the review-bot list, kept current as reviews land. */
export function useBotRepoSuggestions(): string[] {
  const { data } = useReviewRequests();
  // Joined, so a thread event that changes no PR's reviewers doesn't render again.
  const prRepos = useThreadsStore((s) => botReviewedRepos(threadPrs(s.byId)).join("\n"));
  return useMemo(
    () => suggestedBotRepos(data?.requests ?? [], prRepos === "" ? [] : prRepos.split("\n")),
    [data, prRepos],
  );
}

/** How long seeding the review-bot list waits to try again after it couldn't. */
const SEED_RETRY_MS = 5 * 60_000;

/**
 * Mount once: fills in the review-bot list while "Wait for review bot" is on and the list has
 * never been set, as for someone who turned it on before the list existed, so the repositories a
 * bot reviews keep holding and the rest notify. Until then every repository holds, so it waits for
 * the threads' PR badges and a poll of its own that succeeds rather than save a list missing what
 * they would add, and tries again later when the poll or the save fails. A badge arrives on its own
 * after the snapshot, so for the rest of the session a bot seen on one of the user's PRs adds its
 * repository too, unless the list has had it before: one the user took off stays off.
 */
export function useSeedReviewBotRepos() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { apply } = useReviewRequestFilters();
  const unseeded = useServerSettings(
    (s) =>
      s.settings?.notifications.reviewRequestsAwaitBot === true &&
      s.settings.notifications.reviewBotRepos === undefined,
  );
  const threadsReady = useThreadsStore((s) => s.ready);
  const prRepos = useThreadsStore((s) => botReviewedRepos(threadPrs(s.byId)).join("\n"));
  /** Repositories the seeded list has held, lowercased; `undefined` until this mount seeds it. */
  const offered = useRef<Set<string>>(undefined);
  /** The seed and each late addition, one save at a time, so none writes over another. */
  const adding = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!unseeded || !threadsReady) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      if (!cancelled) retry = setTimeout(run, SEED_RETRY_MS);
    };
    const fresh = () => queryClient.fetchQuery({ ...reviewRequestsQuery(api), staleTime: 0 });
    const seed = async () => {
      // A poll that changes nothing announces nothing, so the cached list may predate every one;
      // and a failed one keeps the last result, so only a `checkedAt` that moved says it landed.
      const before = (await fresh()).checkedAt;
      await api.refreshReviewRequests({ force: true });
      const requests = await fresh();
      if (cancelled) return;
      if (requests.checkedAt === undefined || requests.checkedAt === before) return later();
      const reviewBotRepos = currentBotRepoSuggestions(requests);
      // Offered from here on, so a badge that lands while this saves is queued behind it.
      offered.current = new Set(reviewBotRepos.map((repo) => repo.toLowerCase()));
      const save = adding.current.then(() => apply({ reviewBotRepos }));
      adding.current = save.catch(() => {});
      try {
        await save;
      } catch (error) {
        offered.current = undefined;
        throw error;
      }
    };
    function run() {
      seed().catch((error: unknown) => {
        console.error("review requests: seed bot repos", error);
        later();
      });
    }
    run();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [unseeded, threadsReady, api, queryClient, apply]);
  useEffect(() => {
    const seen = offered.current;
    if (seen === undefined || prRepos === "") return;
    const late = prRepos.split("\n").filter((repo) => !seen.has(repo.toLowerCase()));
    if (late.length === 0) return;
    for (const repo of late) seen.add(repo.toLowerCase());
    adding.current = adding.current
      .then(async () => {
        const listed = useServerSettings.getState().settings?.notifications.reviewBotRepos;
        if (listed !== undefined)
          await apply({ reviewBotRepos: late.reduce(withBotRepo, [...listed]) });
      })
      .catch((error: unknown) => {
        console.error("review requests: add late bot repos", error);
        for (const repo of late) seen.delete(repo.toLowerCase());
      });
  }, [prRepos, apply]);
}

/**
 * The same list as the right panel's Reviews tab, for a sidebar kept to threads. The space under
 * the rows opens the menu too: it is the only way back to the sidebar from here.
 */
export function ReviewRequestsPanel() {
  const { data } = useReviewRequests();
  const requests = data?.requests ?? [];
  return (
    <section
      aria-label="Review requests"
      data-testid="review-requests"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1"
    >
      {requests.length === 0 && data?.checkedAt === undefined ? (
        <RequestsMenu render={<div />}>
          <PanelMessage>
            No review requests yet. They need a signed-in gh, and Review requests turned on in
            Settings → Notifications.
          </PanelMessage>
        </RequestsMenu>
      ) : (
        <ReviewRequestsList requests={requests} cardSide="left" />
      )}
      <RequestsMenu render={<div className="min-h-8 flex-1" />} />
    </section>
  );
}

/**
 * A right-click menu over one piece of the list. Each piece is its own trigger rather than the
 * section being one, so a row can lead with its own actions without nesting one menu in another.
 */
function RequestsMenu({
  request,
  render,
  children,
}: {
  /** The row's PR; absent on the headings and the empty space. */
  request?: ReviewRequest | undefined;
  render: ReactElement;
  children?: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={render} onKeyDown={prContextMenuKey}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent data-testid="review-requests-menu">
        {request !== undefined && <RequestMenuItems request={request} />}
        <ListMenuItems />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function useOpenRequest() {
  const api = useApi();
  return (request: ReviewRequest) => void openExternalUrl(api, request.url).catch(() => {});
}

/**
 * One PR's actions. Only a PR in a known project can be checked out. One held for a review bot can
 * be let go by saying its repository has none, which lets go of the others there too.
 */
function RequestMenuItems({ request }: { request: ReviewRequest }) {
  const open = useOpenRequest();
  const queryClient = useQueryClient();
  const settings = useServerSettings((s) => s.settings);
  const filters = useReviewRequestFilters();
  const { projectRoot } = request;
  const noBot = () => {
    const requests = queryClient.getQueryData<ReviewRequests>(["reviewRequests"]);
    const patch = noBotRepoPatch(
      settings?.notifications.reviewBotRepos,
      currentBotRepoSuggestions(requests),
      request.repo,
    );
    filters.apply(patch).catch((error: unknown) => console.error("review requests: no bot", error));
  };
  return (
    <>
      <ContextMenuItem onClick={() => open(request)}>Open on GitHub</ContextMenuItem>
      {projectRoot !== undefined && (
        <ContextMenuItem
          onClick={() =>
            useThreadDialogs
              .getState()
              .open({ kind: "checkoutPr", projectRoot, prRef: prRefText(request) })
          }
        >
          Check out…
        </ContextMenuItem>
      )}
      {settings !== undefined && heldForMissingBot(settings, request) && (
        <ContextMenuItem onClick={noBot}>This repo has no review bot</ContextMenuItem>
      )}
      <ContextMenuSeparator />
    </>
  );
}

/**
 * What the list shows and where, without a trip to Settings → Notifications, whose controls these
 * mirror. The toggles leave the menu open so more than one can be changed at once.
 */
function ListMenuItems() {
  const api = useApi();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const filters = useReviewRequestFilters();
  const grouped = useLayoutStore((s) => s.reviewRequestsGrouped);
  const setGrouped = useLayoutStore((s) => s.setReviewRequestsGrouped);
  const placement = useLayoutStore((s) => s.reviewRequestsPlacement);
  const setPlacement = useLayoutStore((s) => s.setReviewRequestsPlacement);
  const apply = (patch: Parameters<typeof filters.apply>[0]) => {
    filters.apply(patch).catch((error: unknown) => console.error("review requests: filter", error));
  };
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
      <ContextMenuCheckboxItem
        checked={filters.directOnly}
        onCheckedChange={(reviewRequestsDirectOnly) => apply({ reviewRequestsDirectOnly })}
      >
        Only requests for me by name
      </ContextMenuCheckboxItem>
      <ContextMenuCheckboxItem
        checked={filters.hideBots}
        onCheckedChange={(reviewRequestsHideBots) => apply({ reviewRequestsHideBots })}
      >
        Hide bot pull requests
      </ContextMenuCheckboxItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Maximum age</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuRadioGroup
            value={filters.maxAge}
            onValueChange={(choice: MaxAgeChoice) => apply(maxAgePatch(choice))}
          >
            {MAX_AGE_OPTIONS.map((option) => (
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
          api
            .refreshReviewRequests({ force: true })
            .then(() => queryClient.invalidateQueries({ queryKey: ["reviewRequests"] }))
            .catch((error: unknown) => console.error("review requests: refresh", error));
        }}
      >
        Check now
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() =>
          void navigate({ to: "/settings/notifications", search: { highlight: "review requests" } })
        }
      >
        Notification settings…
      </ContextMenuItem>
    </>
  );
}

function ReviewRequestsList({
  id,
  requests,
  cardSide,
}: {
  id?: string | undefined;
  requests: readonly ReviewRequest[];
  cardSide: CardSide;
}) {
  const grouped = useLayoutStore((s) => s.reviewRequestsGrouped);
  if (requests.length === 0) {
    return (
      <RequestsMenu
        render={<p id={id} className="py-1 pr-1 pl-3 text-[11px] text-muted-foreground" />}
      >
        None right now. Right-click to change what is listed.
      </RequestsMenu>
    );
  }
  return <FilteredRequests id={id} requests={requests} grouped={grouped} cardSide={cardSide} />;
}

function FilteredRequests({
  id,
  requests,
  grouped,
  cardSide,
}: {
  id?: string | undefined;
  requests: readonly ReviewRequest[];
  grouped: boolean;
  cardSide: CardSide;
}) {
  const { options, setOptions, visible } = usePrList(requests);
  return (
    <div id={id} className="flex min-w-0 flex-col">
      <PrListControls
        label="Review requests"
        options={options}
        setOptions={setOptions}
        total={requests.length}
        shown={visible.length}
      />
      {visible.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-muted-foreground">No PRs match this view.</p>
      ) : !grouped ? (
        <ul className="flex flex-col">
          {visible.map((request) => (
            <ReviewRequestRow key={prRefText(request)} request={request} cardSide={cardSide} />
          ))}
        </ul>
      ) : (
        groupByRepo(visible).map((group) => (
          <ReviewRequestRepoGroup key={group.repo} group={group} cardSide={cardSide} />
        ))
      )}
    </div>
  );
}

function ReviewRequestRepoGroup({
  group,
  cardSide,
}: {
  group: ReviewRequestGroup;
  cardSide: CardSide;
}) {
  const collapsed = useLayoutStore((s) => s.reviewRequestsCollapsedRepos.includes(group.repo));
  const toggle = useLayoutStore((s) => s.toggleReviewRepoCollapsed);
  return (
    <section aria-label={group.repo} data-testid="review-request-group">
      <RequestsMenu render={<h3 />}>
        <SubgroupToggle
          label={group.repo}
          count={group.requests.length}
          expanded={!collapsed}
          onClick={() => toggle(group.repo)}
        />
      </RequestsMenu>
      <ExpandPresence open={!collapsed}>
        <ul className="flex flex-col">
          {group.requests.map((request) => (
            <ReviewRequestRow key={request.number} request={request} grouped cardSide={cardSide} />
          ))}
        </ul>
      </ExpandPresence>
    </section>
  );
}

/** What a row has no room for: the whole title and login, and its marks in words. */
function ReviewRequestCard({ request }: { request: ReviewRequest }) {
  const waitingOn = reviewRequestWaitingOn(request);
  return (
    <>
      <p className="break-all text-xs text-muted-foreground">{prRefText(request)}</p>
      <p className="break-words font-medium">{request.title || prRefText(request)}</p>
      <PrInformationDetails pr={request} />
      <PrStatusDetails pr={request} />

      {waitingOn !== undefined && (
        <p className="text-xs text-muted-foreground">{waitingOn}, so this one can wait.</p>
      )}
    </>
  );
}

function ReviewRequestRow({
  request,
  grouped = false,
  cardSide,
}: {
  request: ReviewRequest;
  /** Under its repository's heading, so the row names only the number. */
  grouped?: boolean;
  cardSide: CardSide;
}) {
  const open = useOpenRequest();
  const ref = prRefText(request);
  const { setTriggerRef, popupRef, triggerKey, popupKey } = usePrCardFocus();
  const waiting = reviewRequestWaitingOn(request) !== undefined;
  return (
    <RequestsMenu
      request={request}
      render={
        <li
          data-testid="review-request"
          data-waiting={waiting}
          className={cn(
            "flex min-w-0 rounded-(--sidebar-row-radius) py-1.5 pr-2 text-xs hover:bg-sidebar-row-hover",
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
          aria-label={`Open ${ref} on GitHub: ${request.title}`}
          onClick={() => open(request)}
          className={cn(
            "flex min-w-0 flex-1 flex-col rounded-(--radius-sm) text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <PrRowInformation
            pr={request}
            grouped={grouped}
            glyphTestId="review-request-glyph"
            ageTestId="review-request-age"
          />
        </PreviewCard.Trigger>
        <PreviewCard.Portal>
          <PreviewCard.Positioner side={cardSide} sideOffset={8} className="isolate z-50">
            <PreviewCard.Popup
              ref={popupRef}
              onKeyDown={popupKey}
              role="region"
              aria-label={`Details for ${ref}`}
              data-testid="review-request-card"
              data-surface="overlay"
              className={cn(
                CARD_SURFACE,
                prContextMenuKey,
                "flex w-80 max-w-[calc(100vw-24px)] max-h-[min(var(--available-height),calc(100dvh-24px))] flex-col gap-2 overflow-y-auto overscroll-contain p-3 text-sm focus-visible:ring-2 focus-visible:ring-ring [&>*]:shrink-0",
              )}
            >
              <ReviewRequestCard request={request} />
            </PreviewCard.Popup>
          </PreviewCard.Positioner>
        </PreviewCard.Portal>
      </PreviewCard.Root>
    </RequestsMenu>
  );
}
