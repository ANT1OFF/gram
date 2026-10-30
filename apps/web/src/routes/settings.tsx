import { createFileRoute, Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useShortcut } from "@/keyboard/registry";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { UpdateDot, useUpdateAvailable } from "@/settings/advanced-page";
import { HelpTip } from "@/settings/help-tip";
import { useSettingsKeyboard } from "@/settings/leave-settings";
import {
  isSubpage,
  listedSettingsPages,
  rememberSettingsPage,
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  settingsGroupOf,
  type SettingsPage,
} from "@/settings/pages";
import { useRestoreDefaults } from "@/settings/restore-defaults";
import { searchWords } from "@/settings/search";
import {
  firstMatchedPage,
  SearchEmptyState,
  SearchScope,
  SettingsSearchBox,
  SettingsSearchProvider,
} from "@/settings/search-scope";
import { SettingsNav } from "@/settings/settings-nav";
import { useSettingsScroll } from "@/settings/use-settings-scroll";
import { useServerSettings } from "@/settings-sync/store";

/** `?highlight=<words>` marks and scrolls to the settings on the page that those words find. */
export interface SettingsSearch {
  readonly highlight?: string;
}

const highlightOf = (search: Record<string, unknown>): string | undefined =>
  typeof search["highlight"] === "string" && search["highlight"].trim() !== ""
    ? search["highlight"]
    : undefined;

export const Route = createFileRoute("/settings")({
  validateSearch: (search: Record<string, unknown>): SettingsSearch => {
    const highlight = highlightOf(search);
    return highlight === undefined ? {} : { highlight };
  },
  component: SettingsLayout,
});

/**
 * Settings: the six groups beside the open page. A search shows every page's matches instead, the
 * open page's among them without remounting it, so a draft on it survives the search; Enter opens
 * the first match's page with it marked.
 */
function SettingsLayout() {
  const headingRef = useSettingsKeyboard();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const searchHint = useShortcutHint("settings.search");
  useShortcut({
    id: "settings.search",
    keys: "mod+f",
    label: "Search settings",
    group: "App",
    run: () => {
      searchRef.current?.focus();
      searchRef.current?.select();
    },
  });
  const pathname = useLocation({ select: (location) => location.pathname });
  const settings = useServerSettings((s) => s.settings);
  const pages = listedSettingsPages(SETTINGS_PAGES, settings);
  // A page's own sub-pages, such as one workspace's settings, keep its tab selected.
  const current = SETTINGS_PAGES.find(
    (page) => pathname === page.path || pathname.startsWith(`${page.path}/`),
  );
  const subpage = current !== undefined && pathname !== current.path;
  // A page just switched off stays open until left, rather than vanishing under the pointer.
  const shown = current === undefined || pages.includes(current) ? pages : [...pages, current];
  // From the location rather than `Route.useSearch()`, which lags a commit behind the path when a
  // link moves between two pages under this layout, so the page would arrive without its highlight.
  const highlight = useLocation({ select: (location) => highlightOf(location.search) });
  const searching = searchWords(query).length > 0;
  useEffect(() => {
    if (current) rememberSettingsPage(current.id);
  }, [current]);
  const { scrollRef, spotlight, holdScroll } = useSettingsScroll({
    page: current?.id,
    highlight,
    searching,
  });
  const updateAvailable = useUpdateAvailable();
  const navigate = useNavigate();
  const resultsRef = useRef<HTMLDivElement>(null);
  /** Opens the page of the first setting the search finds, with that setting marked. */
  const openFirstMatch = () => {
    const path = firstMatchedPage(resultsRef.current);
    const page = SETTINGS_PAGES.find((each) => each.path === path);
    if (page === undefined) return;
    const words = query.trim();
    setQuery("");
    void navigate({ to: page.path, search: { highlight: words } });
  };

  return (
    <div className="@container/settings flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 overflow-hidden @max-2xl/settings:flex-col">
        <SettingsNav
          groups={SETTINGS_GROUPS}
          current={current === undefined ? undefined : current.group}
          headingRef={headingRef}
          search={
            <SettingsSearchBox
              query={query}
              onQueryChange={(next) => {
                if (!searching && searchWords(next).length > 0) holdScroll();
                setQuery(next);
              }}
              // Back on the heading, the next Esc leaves Settings.
              onLeave={() => headingRef.current?.focus({ preventScroll: true })}
              onSubmit={openFirstMatch}
              inputRef={searchRef}
              hint={searchHint}
            />
          }
          onNavigate={() => setQuery("")}
          {...(updateAvailable ? { badges: { advanced: <UpdateDot /> } } : {})}
        />
        <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto">
          <div
            ref={resultsRef}
            data-settings-results
            className={cn(
              "mx-auto flex w-full flex-col gap-10 p-6 @max-2xl/settings:gap-8 @max-2xl/settings:p-4",
              current?.wide && !searching ? "max-w-5xl" : "max-w-(--thread-max-width)",
            )}
          >
            {shown.map((page) => {
              if (page.id === current?.id) {
                return (
                  <PageSection
                    key={page.id}
                    page={page}
                    query={searching ? query : (spotlight ?? "")}
                    spotlight={!searching}
                    onOpen={() => setQuery("")}
                    searching={searching}
                    subpage={subpage}
                  >
                    <Outlet />
                  </PageSection>
                );
              }
              if (!searching) return null;
              const Search = page.search;
              return (
                <PageSection
                  key={page.id}
                  page={page}
                  query={query}
                  onOpen={() => setQuery("")}
                  searching
                >
                  {Search && <Search />}
                </PageSection>
              );
            })}
            <SearchEmptyState query={query} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One page under its heading. While searching, the heading links to the page and the page shows
 * only what the query finds; opening it marks those same settings there.
 */
function PageSection({
  page,
  query,
  spotlight = false,
  searching,
  subpage = false,
  onOpen,
  children,
}: {
  page: SettingsPage;
  query: string;
  spotlight?: boolean;
  searching: boolean;
  /** One of the page's own sub-pages is open, which brings its own heading. */
  subpage?: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  const Actions = page.actions;
  const titleId = `settings-${page.id}-title`;
  const restore = useRestoreDefaults(searching ? undefined : page.defaults);
  const group = settingsGroupOf(page);
  const sub = isSubpage(page);
  return (
    <SettingsSearchProvider query={query} spotlight={spotlight}>
      <SearchScope
        as="section"
        section
        label={page.label}
        {...(page.keywords ? { keywords: page.keywords } : {})}
        aria-labelledby={titleId}
        data-settings-page={page.path}
        className="flex flex-col gap-6 text-sm"
      >
        <header className={cn("flex items-start gap-3", subpage && !searching && "hidden")}>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {sub && !searching && (
              <Link
                to={group.path}
                data-testid="settings-subpage-back"
                className="inline-flex w-fit items-center gap-0.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <ChevronLeft aria-hidden className="size-3.5" />
                {group.label}
              </Link>
            )}
            <h2 id={titleId} className="flex items-center gap-1.5 font-heading text-lg font-medium">
              {searching ? (
                <Link
                  to={page.path}
                  search={{ highlight: query }}
                  onClick={onOpen}
                  className="group inline-flex items-center gap-1.5 rounded-sm outline-none hover:text-link focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {sub && (
                    <>
                      <span className="text-muted-foreground">{group.label}</span>
                      <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
                    </>
                  )}
                  {page.label}
                  <ArrowRight
                    aria-hidden
                    className="size-4 text-muted-foreground group-hover:text-link"
                  />
                </Link>
              ) : (
                <HelpTip label={page.label} help={page.description}>
                  {page.label}
                </HelpTip>
              )}
            </h2>
            {searching && page.search === null && (
              <p className="text-muted-foreground">{page.description}</p>
            )}
          </div>
          {!searching && (Actions || restore.button) && (
            <div className="flex shrink-0 items-center gap-1">
              {restore.button}
              {Actions && <Actions />}
            </div>
          )}
        </header>
        {restore.strip}
        {children}
      </SearchScope>
    </SettingsSearchProvider>
  );
}
