import type { PrDetail, PrLabel, ThreadId } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Tag, X } from "lucide-react";
import { useRef, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { focusIfConnected, focusLost } from "@/lib/use-return-focus";

import { Notice, useReviewAction } from "./review/review-thread-card";

const inputCls =
  "h-7 min-w-0 flex-1 rounded-lg border border-input bg-transparent px-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function Swatch({ label }: { label: PrLabel }) {
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full bg-muted-foreground"
      style={
        /^[0-9a-f]{6}$/i.test(label.color) ? { backgroundColor: `#${label.color}` } : undefined
      }
    />
  );
}

/** The PR's GitHub labels as chips: remove one with its ×, add one of the repository's labels. */
export function PrLabels({ threadId, detail }: { threadId: ThreadId; detail: PrDetail }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const action = useReviewAction();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const repoLabels = useQuery({
    queryKey: ["pr.labels.list", threadId],
    queryFn: () => api.prLabelsList(threadId),
    enabled: adding,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const labels = detail.labels ?? [];
  const onPr = new Set(labels.map((label) => label.name.toLowerCase()));
  const needle = filter.trim().toLowerCase();
  const options = (repoLabels.data?.labels ?? [])
    .filter((label) => !onPr.has(label.name.toLowerCase()))
    .filter((label) => label.name.toLowerCase().includes(needle))
    .slice(0, 8);

  const stripRef = useRef<HTMLDivElement>(null);
  const close = () => {
    setAdding(false);
    setFilter("");
    // The form leaves with its focused field: back to "Add label…".
    setTimeout(() => {
      if (focusLost()) focusIfConnected(stripRef.current?.querySelector("[data-add-label]"));
    }, 0);
  };

  const change = (kind: "add" | "remove", name: string) =>
    action.run(async () => {
      if (kind === "add") {
        await api.prLabelsAdd(threadId, [name]);
        close();
      } else {
        await api.prLabelsRemove(threadId, [name]);
      }
      await queryClient.invalidateQueries({ queryKey: ["git.prDetail", threadId] });
      return kind === "add" ? `Added ${name}` : `Removed ${name}`;
    });

  return (
    <div ref={stripRef} className="flex min-w-0 flex-col gap-1 has-[form]:basis-full">
      <div
        data-testid="pr-labels"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
      >
        {labels.length > 0 && <span>Labels</span>}
        {labels.length > 0 && (
          <ul aria-label="Labels" className="flex flex-wrap items-center gap-1">
            {labels.map((label) => (
              <li
                key={label.name}
                title={label.description || undefined}
                className="flex items-center gap-1 rounded-full border border-border py-0.5 ps-2 pe-0.5 text-foreground"
              >
                <Swatch label={label} />
                {label.name}
                <button
                  type="button"
                  aria-label={`Remove label ${label.name}`}
                  disabled={action.pending}
                  onClick={() => void change("remove", label.name)}
                  className="rounded-full p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <X aria-hidden className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {!adding && (
          <Button
            data-add-label
            size="xs"
            variant="outline"
            className="border-dashed text-muted-foreground"
            disabled={action.pending}
            onClick={() => setAdding(true)}
          >
            <Tag aria-hidden />
            Add label…
          </Button>
        )}
      </div>
      {adding && (
        <form
          aria-label="Add label"
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const exact = options.find((label) => label.name.toLowerCase() === needle);
            const choice = exact ?? (options.length === 1 ? options[0] : undefined);
            if (choice) void change("add", choice.name);
          }}
        >
          <div className="flex items-center gap-1">
            <input
              aria-label="Filter repository labels"
              // oxlint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className={inputCls}
              placeholder="Filter labels"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") close();
              }}
            />
            <Button type="button" size="xs" variant="ghost" onClick={close}>
              Cancel
            </Button>
          </div>
          {repoLabels.isPending ? (
            <p className="text-xs text-muted-foreground">Loading labels…</p>
          ) : repoLabels.isError ? (
            <p role="alert" className="text-xs text-destructive">
              {errorMessage(repoLabels.error)}
            </p>
          ) : options.length === 0 ? (
            <p className="text-xs text-muted-foreground">No matching labels</p>
          ) : (
            <ul aria-label="Repository labels" className="flex flex-wrap gap-1">
              {options.map((label) => (
                <li key={label.name}>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    title={label.description || undefined}
                    disabled={action.pending}
                    onClick={() => void change("add", label.name)}
                  >
                    <Swatch label={label} />
                    {label.name}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </form>
      )}
      <Notice notice={action.notice} />
    </div>
  );
}
