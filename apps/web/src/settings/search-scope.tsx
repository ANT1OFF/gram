/**
 * Settings search has no index. Each `Field`, `Toggle` and `SearchScope` matches itself against the
 * query in this context, so a new setting is searchable by existing, and what is searched is the
 * label and description on screen, dynamic ones included. A visible match carries
 * `data-setting-match`; a scope or the empty state that has to know whether anything inside matched
 * asks CSS `:has()`, which is right on the first paint where counting in an effect would flicker.
 * The same matching, in spotlight mode, marks the settings a link into a page points at with
 * `data-setting-spotlight` and hides nothing.
 */
import { Search, X } from "lucide-react";
import { createContext, useContext, useMemo, type ReactNode, type RefObject } from "react";

import { cn } from "@/lib/utils";

import { matchesSearch, searchWords, type Searchable } from "./search";

interface SearchScopeValue {
  readonly query: string;
  readonly section: string;
  readonly spotlight: boolean;
}

const SearchScopeContext = createContext<SearchScopeValue>({
  query: "",
  section: "",
  spotlight: false,
});

const MATCH = { "data-setting-match": "" } as const;
const SPOTLIT = { "data-setting-spotlight": "" } as const;

/** Provides the Settings search query to everything under it. */
export function SettingsSearchProvider({
  query,
  section = "",
  spotlight = false,
  children,
}: {
  query: string;
  /** The page everything under it sits on, so "appearance font" finds the fonts. */
  section?: string;
  /** Mark what `query` matches without hiding anything, for a link that points at a setting. */
  spotlight?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ query, section, spotlight }), [query, section, spotlight]);
  return <SearchScopeContext value={value}>{children}</SearchScopeContext>;
}

/**
 * Props for one setting's root element: `hidden` while a search is on that it doesn't answer, the
 * match marker while it does. Hidden rather than unmounted, so a half-typed draft survives a search.
 */
export function useSettingSearch(item: Omit<Searchable, "section">) {
  const { query, section, spotlight } = useContext(SearchScopeContext);
  if (searchWords(query).length === 0) return {};
  const matched = matchesSearch(query, { ...item, section });
  if (spotlight) return matched ? SPOTLIT : {};
  return matched ? MATCH : { hidden: true };
}

/**
 * A group of settings under a name: a section, or a block that isn't built from `Field`s. A search
 * that names the group shows all of it; otherwise it shows while something inside matches.
 */
export function SearchScope({
  as: Element = "div",
  label,
  keywords,
  section = false,
  className,
  children,
  ...rest
}: {
  as?: "div" | "section";
  label: string;
  keywords?: readonly string[];
  /** The label is a section heading, and settings inside are searchable by it. */
  section?: boolean;
  className?: string;
  children: ReactNode;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** On a page's section: its path, for Enter in the search box to open. */
  "data-settings-page"?: string;
}) {
  const scope = useContext(SearchScopeContext);
  const searching = searchWords(scope.query).length > 0;
  const named =
    searching && matchesSearch(scope.query, { label, keywords, section: scope.section });
  const inner = useMemo(
    () => ({
      query: named ? "" : scope.query,
      section: section ? label : scope.section,
      spotlight: scope.spotlight,
    }),
    [named, scope.query, scope.section, scope.spotlight, section, label],
  );
  const filtering = searching && !scope.spotlight;

  return (
    <SearchScopeContext value={inner}>
      <Element
        {...rest}
        {...(named ? (scope.spotlight ? SPOTLIT : MATCH) : {})}
        className={cn(className, filtering && !named && "not-has-[[data-setting-match]]:hidden")}
      >
        {children}
      </Element>
    </SearchScopeContext>
  );
}

/**
 * The path of the page holding the first setting a search found, in page order: what Enter in the
 * search box opens. Pages mark their section with `data-settings-page`.
 */
export function firstMatchedPage(results: ParentNode | null | undefined): string | undefined {
  const match = results?.querySelector("[data-setting-match]");
  return match?.closest<HTMLElement>("[data-settings-page]")?.dataset["settingsPage"];
}

/** Shown in place of the settings when a search matches none of them. */
export function SearchEmptyState({ query }: { query: string }) {
  return (
    <div role="status">
      {searchWords(query).length > 0 && (
        <p
          data-testid="settings-search-empty"
          className="text-sm text-muted-foreground [[data-settings-results]:has([data-setting-match])_&]:hidden"
        >
          No settings match “{query.trim()}”.
        </p>
      )}
    </div>
  );
}

/**
 * The Settings search input. Enter opens the first match, Esc clears it, and from empty hands focus
 * to `onLeave`.
 */
export function SettingsSearchBox({
  query,
  onQueryChange,
  onLeave,
  onSubmit,
  inputRef,
  hint,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onLeave: () => void;
  /** Enter, while something is typed. */
  onSubmit?: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  /** The focus shortcut's keys, for the placeholder. */
  hint?: string;
}) {
  return (
    <div data-search className="relative mb-2">
      <Search
        aria-hidden
        className="pointer-events-none absolute inset-y-0 start-2 my-auto size-3.5 text-muted-foreground"
      />
      <input
        ref={inputRef}
        aria-label="Search settings"
        placeholder={hint ? `Search (${hint})` : "Search"}
        spellCheck={false}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && query.trim() !== "") {
            event.preventDefault();
            onSubmit?.();
            return;
          }
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (query === "") onLeave();
          else onQueryChange("");
        }}
        className="h-7 w-full rounded-md border border-input bg-transparent ps-7 pe-6 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      {query !== "" && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onQueryChange("");
            inputRef.current?.focus();
          }}
          className="absolute inset-y-0 end-1 my-auto flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}
