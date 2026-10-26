import { ArrowDownWideNarrow, Filter, RefreshCw, Search, X } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import { spin } from "@/motion";
import {
  DEFAULT_PR_OPTIONS,
  selectPrs,
  type PrFilter,
  type PrInformation,
  type PrListOptions,
  type PrSort,
} from "./pr-list-model";

const sortLabels = { recent: "Recent activity", oldest: "Oldest activity", size: "Largest change" };
const filterLabels = {
  all: "All PRs",
  draft: "Drafts",
  ready: "Non-drafts",
  failing: "Checks failing",
  pending: "Checks running",
  unknown: "Checks unknown or cached",
  none: "No checks",
};

export function usePrList<T extends PrInformation>(rows: readonly T[]) {
  const [options, setOptions] = useState(DEFAULT_PR_OPTIONS);
  return { options, setOptions, visible: selectPrs(rows, options) };
}

const control =
  "relative flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground focus-within:ring-2 focus-within:ring-ring";

export function PrListControls({
  label,
  options,
  setOptions,
  total,
  shown,
}: {
  label: string;
  options: PrListOptions;
  setOptions: (options: PrListOptions) => void;
  total: number;
  shown: number;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const active = options.search !== "" || options.filter !== "all" || options.sort !== "recent";
  const refresh = async () => {
    setRefreshing(true);
    setError(false);
    try {
      await api.refreshReviewRequests({ force: true });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["openPrs"] }),
        queryClient.invalidateQueries({ queryKey: ["reviewRequests"] }),
      ]);
    } catch {
      setError(true);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <div className="px-2 pb-1" data-testid="pr-list-controls">
      <div className="flex min-w-0 items-center gap-1">
        <label className="flex min-w-0 flex-1 items-center gap-1 rounded-sm border border-border px-1.5 focus-within:ring-2 focus-within:ring-ring">
          <Search aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <input
            aria-label={`Search ${label}`}
            placeholder="Search PRs…"
            value={options.search}
            onChange={(e) => setOptions({ ...options, search: e.target.value })}
            className="h-6 min-w-0 w-full bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
          />
        </label>
        <Hint label={`Sort: ${sortLabels[options.sort]}`} render={<span className={control} />}>
          <ArrowDownWideNarrow aria-hidden className="size-3.5" />
          <select
            aria-label={`Sort ${label}`}
            value={options.sort}
            onChange={(e) => setOptions({ ...options, sort: e.target.value as PrSort })}
            className="absolute inset-0 w-full cursor-pointer opacity-0"
          >
            <option value="recent">Recent activity</option>
            <option value="oldest">Oldest activity</option>
            <option value="size">Largest change (known)</option>
          </select>
        </Hint>
        <Hint
          label={`Filter: ${filterLabels[options.filter]}`}
          render={<span className={control} />}
        >
          <Filter
            aria-hidden
            className={options.filter === "all" ? "size-3.5" : "size-3.5 text-info"}
          />
          <select
            aria-label={`Filter ${label}`}
            value={options.filter}
            onChange={(e) => setOptions({ ...options, filter: e.target.value as PrFilter })}
            className="absolute inset-0 w-full cursor-pointer opacity-0"
          >
            <option value="all">All displayed PRs</option>
            <option value="draft">Drafts</option>
            <option value="ready">Non-drafts</option>
            <option value="failing">Checks failing</option>
            <option value="pending">Checks running</option>
            <option value="unknown">Checks unknown or cached</option>
            <option value="none">No checks</option>
          </select>
        </Hint>
        <Hint
          label="Check now · refresh both lists"
          render={
            <button
              type="button"
              aria-label={`Refresh ${label}`}
              disabled={refreshing}
              onClick={() => void refresh()}
              className={control}
            />
          }
        >
          <RefreshCw aria-hidden ref={refreshing ? spin : undefined} className="size-3.5" />
        </Hint>
      </div>
      {active && (
        <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
          <span role="status">
            {shown} of {total} · {sortLabels[options.sort]}
            {options.filter !== "all" ? ` · ${filterLabels[options.filter]}` : ""}
          </span>
          <Hint
            label="Reset search, sort and filters"
            render={
              <button
                type="button"
                aria-label={`Reset ${label} view`}
                onClick={() => setOptions(DEFAULT_PR_OPTIONS)}
                className={control}
              />
            }
          >
            <X aria-hidden className="size-3" />
          </Hint>
        </div>
      )}
      {error && (
        <p role="status" className="text-[11px] text-muted-foreground">
          Refresh failed. Showing last known list.
        </p>
      )}
    </div>
  );
}
