import { Popover } from "@base-ui/react/popover";
import type { DraftStash, ThreadId } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Trash2 } from "lucide-react";

import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import { errorMessage } from "@/api/errors";
import { formatRelative } from "@/lib/time";

import { useStashMenuStore } from "./stash-store";
import { PHONE_HIT } from "./styles";

export const stashesQueryKey = (threadId: ThreadId) =>
  ["stashes", threadId] as const;

/** What a stashed draft shows in the list: its first line, or what it had attached. */
export function stashPreview(stash: DraftStash): string {
  const line = stash.text.trim().split("\n")[0] ?? "";
  if (line !== "") return line;
  const count = stash.attachments.length;
  return count === 1 ? "1 attachment" : `${count} attachments`;
}

/**
 * The stash by the composer, an archive glyph with a count, and the list it opens (also from ⌘K):
 * each stash previewed with its age, restored with a click or discarded. Hidden while the thread
 * has none.
 */
export function StashMenu({
  threadId,
  onRestore,
  onError,
  keep = [],
}: {
  threadId: ThreadId;
  onRestore: (stash: DraftStash) => void;
  onError: (message: string) => void;
  /** Upload paths the composer's live draft uses, which discarding a stash must not delete. */
  keep?: readonly string[];
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const open = useStashMenuStore((s) => s.openFor === threadId);
  const { data: stashes = [] } = useQuery({
    queryKey: stashesQueryKey(threadId),
    queryFn: () => api.listStashes(threadId),
  });
  if (stashes.length === 0 && !open) return null;

  const setOpen = (next: boolean) => {
    const store = useStashMenuStore.getState();
    if (next) store.open(threadId);
    else store.close();
  };
  const discard = (stash: DraftStash) =>
    api
      .removeStash(threadId, stash.id, keep)
      // The list closes with its last stash rather than staying open empty.
      .then(() => stashes.length === 1 && setOpen(false))
      .catch((error: unknown) =>
        onError(`Couldn't discard the draft: ${errorMessage(error)}`),
      )
      .finally(
        () =>
          void queryClient.invalidateQueries({
            queryKey: stashesQueryKey(threadId),
          }),
      );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Hint
        label={`Stashed drafts (${stashes.length})`}
        render={
          <Popover.Trigger
            data-testid="stash-trigger"
            aria-label={`Stashed drafts (${stashes.length})`}
            className={`flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-2 text-meta font-medium text-muted-foreground tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:focus-ring ${PHONE_HIT}`}
          />
        }
      >
        <Archive aria-hidden className="size-icon-bar" />
        {stashes.length}
      </Hint>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={6}
          className="isolate z-50"
        >
          <Popover.Popup
            data-testid="stash-menu"
            data-surface="overlay"
            aria-label="Stashed drafts"
            className="w-80 origin-(--transform-origin) rounded-md border border-edge bg-popover p-1 text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
          >
            {stashes.length === 0 ? (
              <p className="px-2 py-1.5 text-reading text-muted-foreground">
                No stashed drafts.
              </p>
            ) : (
              <ul
                aria-label="Stashed drafts"
                className="flex max-h-72 flex-col overflow-y-auto"
              >
                {stashes.map((stash) => (
                  <li key={stash.id} className="group flex items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Restore draft: ${stashPreview(stash)}`}
                      className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left text-body outline-none hover:bg-accent focus-visible:bg-accent"
                      onClick={() => {
                        setOpen(false);
                        onRestore(stash);
                      }}
                    >
                      <span className="truncate">{stashPreview(stash)}</span>
                      <span className="text-meta text-muted-foreground">
                        {formatRelative(stash.createdAt)}
                        {stash.attachments.length > 0 &&
                        stash.text.trim() !== ""
                          ? ` · ${stash.attachments.length} attached`
                          : ""}
                      </span>
                    </button>
                    <Hint
                      label={`Discard draft: ${stashPreview(stash)}`}
                      render={
                        <button
                          type="button"
                          aria-label={`Discard draft: ${stashPreview(stash)}`}
                          className="grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
                          onClick={() => void discard(stash)}
                        />
                      }
                    >
                      <Trash2 aria-hidden className="size-icon-row" />
                    </Hint>
                  </li>
                ))}
              </ul>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
