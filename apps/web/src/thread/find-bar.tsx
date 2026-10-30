import type { ThreadId } from "@gram/contracts";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { imeComposing } from "@/composer/send-key";
import { useReturnFocus } from "@/lib/use-return-focus";

import { useThreadSearch, type ThreadSearchState } from "./use-thread-search";

const FIND_LIMIT = 200;

function statusText(search: ThreadSearchState, index: number, count: number): string {
  switch (search.status) {
    case "idle":
      return "";
    case "searching":
      return "Searching…";
    case "unavailable":
      return "Search isn't available yet";
    case "error":
      return `Search failed: ${search.message}`;
    case "done":
      return count === 0 ? "No matches" : `${index + 1} of ${count}${search.truncated ? "+" : ""}`;
  }
}

/** `⌘F` within a thread: searches its messages and steps through the matches (⏎ / ⇧⏎). */
export function FindBar({
  threadId,
  onReveal,
  onClose,
}: {
  threadId: ThreadId;
  onReveal: (messageId: string) => void;
  onClose: () => void;
}) {
  useReturnFocus();
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  const search = useThreadSearch(query, { threadId, limit: FIND_LIMIT });
  const reveal = useRef(onReveal);
  useEffect(() => {
    reveal.current = onReveal;
  });

  const messageIds =
    search.status === "done"
      ? [...new Set(search.hits.flatMap((hit) => (hit.messageId ? [hit.messageId] : [])))]
      : [];
  const index = messageIds.length === 0 ? -1 : Math.min(current, messageIds.length - 1);
  const currentId = index === -1 ? undefined : messageIds[index];

  useEffect(() => {
    if (currentId) reveal.current(currentId);
  }, [currentId]);

  const step = (delta: number) => {
    if (messageIds.length === 0) return;
    const next = (index + delta + messageIds.length) % messageIds.length;
    setCurrent(next);
    reveal.current(messageIds[next]!);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (imeComposing(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="search"
      data-testid="find-bar"
      className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-3 py-1"
    >
      <input
        autoFocus
        aria-label="Find in thread"
        placeholder="Find in thread…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setCurrent(0);
        }}
        onKeyDown={onKeyDown}
        className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <span
        aria-live="polite"
        data-testid="find-status"
        className="shrink-0 text-xs text-muted-foreground tabular-nums"
      >
        {statusText(search, index, messageIds.length)}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        disabled={messageIds.length === 0}
        onClick={() => step(-1)}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        disabled={messageIds.length === 0}
        onClick={() => step(1)}
      >
        <ChevronDown />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={onClose}>
        <X />
      </Button>
    </div>
  );
}
