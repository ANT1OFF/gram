import {
  PALETTE_KINDS,
  PALETTE_STATES,
  PALETTE_TIMES,
  helperOn,
  validPaletteFilters,
  type PaletteFilter,
  type ThreadId,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useApi } from "@/api/context";
import { useServerSettings } from "@/settings-sync/store";
import {
  FILTER_LABELS,
  parseWordFilters,
  type NamedWorkspace,
  type WordParse,
} from "./word-filters";

/** Parsing runs after the first search render. Editing never changes the original search text. */
export function useWordFilters(query: string, workspaceKey: string, enabled: boolean) {
  const overrides = useRef(new Map<PaletteFilter["field"], PaletteFilter | null>());
  const [ignoreText, setIgnoreText] = useState(false);
  const [parsed, setParsed] = useState<WordParse & { query: string }>({
    query: "",
    filters: [],
    text: "",
  });
  useEffect(() => {
    if (!enabled || !query.trim()) overrides.current.clear();
    if (!enabled) return;
    const timer = setTimeout(() => {
      setIgnoreText(false);
      const result = parseWordFilters(query, JSON.parse(workspaceKey) as NamedWorkspace[]);
      const filters = result.filters.filter((filter) => !overrides.current.has(filter.field));
      for (const filter of overrides.current.values()) if (filter !== null) filters.push(filter);
      setParsed({ ...result, filters, query });
    }, 0);
    return () => clearTimeout(timer);
  }, [query, workspaceKey, enabled]);
  const current = enabled && parsed.query === query;
  return {
    filters: current ? parsed.filters : [],
    text: current ? (ignoreText ? "" : parsed.text) : query,
    remainder: current ? parsed.text : "",
    setFilters: (filters: PaletteFilter[], clearText = false) => {
      if (clearText) setIgnoreText(true);
      for (const previous of parsed.filters) {
        const next = filters.find((filter) => filter.field === previous.field);
        if (next?.value !== previous.value) overrides.current.set(previous.field, next ?? null);
      }
      for (const filter of filters) {
        if (!parsed.filters.some((previous) => previous.field === filter.field))
          overrides.current.set(filter.field, filter);
      }
      setParsed((previous) => ({ ...previous, filters }));
    },
  };
}

const FIELD_LABELS = { workspace: "Workspace", kind: "Kind", state: "State", time: "Time range" };
const controlClass =
  "rounded-sm border border-border bg-background px-1.5 py-1 text-xs focus-visible:outline-2 focus-visible:outline-ring";

export function WordFilterControls({
  query,
  text,
  filters,
  workspaces,
  threadId,
  setFilters,
  input,
}: {
  query: string;
  text: string;
  filters: PaletteFilter[];
  workspaces: NamedWorkspace[];
  threadId: ThreadId | undefined;
  setFilters: (filters: PaletteFilter[], clearText?: boolean) => void;
  input: RefObject<HTMLInputElement | null>;
}) {
  const api = useApi();
  const on = useServerSettings((s) => s.settings !== undefined && helperOn(s.settings, "suggest"));
  const [requested, setRequested] = useState<string>();
  const eligible =
    on && threadId !== undefined && text.trim().split(/\s+/).length >= 3 && query.length <= 500;
  const suggestions = useQuery({
    queryKey: ["palette.filters", threadId, query],
    queryFn: () => api.paletteFilters(threadId!, query),
    enabled: eligible && requested === query,
    retry: false,
    staleTime: Infinity,
  });
  const proposed =
    requested === query && eligible
      ? validPaletteFilters(
          suggestions.data ?? [],
          workspaces.map((w) => w.id),
        ).filter((p) => !filters.some((f) => f.field === p.field))
      : [];
  const label = (filter: PaletteFilter) =>
    filter.field === "workspace"
      ? (workspaces.find((w) => w.id === filter.value)?.name ?? "Workspace")
      : FILTER_LABELS[filter.value];
  const remove = (field: PaletteFilter["field"]) => {
    setFilters(filters.filter((f) => f.field !== field));
    input.current?.focus();
  };
  if (!filters.length && !eligible) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2"
      aria-label="Search filters"
    >
      {filters.map((filter) => {
        const values =
          filter.field === "workspace"
            ? workspaces.map((w) => w.id)
            : filter.field === "kind"
              ? PALETTE_KINDS
              : filter.field === "state"
                ? PALETTE_STATES
                : PALETTE_TIMES;
        const choose = (value: string) =>
          setFilters(
            filters.map((current) =>
              current.field === filter.field ? ({ ...current, value } as PaletteFilter) : current,
            ),
          );
        return (
          <span
            key={filter.field}
            className="inline-flex items-center rounded-sm bg-accent text-accent-foreground"
          >
            <select
              aria-label={FIELD_LABELS[filter.field]}
              value={filter.value}
              className={`${controlClass} max-w-40 border-0 bg-transparent`}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey)
                  return;
                // Commit arrow edits in the chip itself, consistently across native popup menus.
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const index = values.findIndex((value) => value === filter.value);
                  choose(
                    values[
                      (index + (event.key === "ArrowDown" ? 1 : -1) + values.length) % values.length
                    ]!,
                  );
                }
                if (event.key === "Backspace" || event.key === "Delete") {
                  event.preventDefault();
                  remove(filter.field);
                }
              }}
              onChange={(event) => choose(event.target.value)}
            >
              {values.map((value) => (
                <option key={value} value={value}>
                  {label({ ...filter, value } as PaletteFilter)}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={`Remove ${FIELD_LABELS[filter.field].toLowerCase()}`}
              className="rounded-sm px-1.5 text-xs hover:bg-background focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => remove(filter.field)}
            >
              ×
            </button>
          </span>
        );
      })}
      {eligible && requested !== query && (
        <button type="button" className={controlClass} onClick={() => setRequested(query)}>
          Suggest filters
        </button>
      )}
      {eligible && requested === query && suggestions.isFetching && (
        <span role="status" className="text-xs text-muted-foreground">
          Suggesting filters…
        </span>
      )}
      {proposed.map((filter) => (
        <button
          type="button"
          key={filter.field}
          className={`${controlClass} border-dashed`}
          aria-label={`Add ${label(filter)}`}
          onClick={() => setFilters([...filters, filter], true)}
        >
          + {label(filter)}
        </button>
      ))}
      {eligible && requested === query && !suggestions.isFetching && !proposed.length && (
        <span role="status" className="text-xs text-muted-foreground">
          No extra filters
        </span>
      )}
    </div>
  );
}
