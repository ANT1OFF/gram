import type { GramUIMessage, ThreadId } from "@gram/contracts";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { imeComposing } from "@/composer/send-key";
import { keyLabel } from "@/keyboard/registry";
import { useReturnFocus } from "@/lib/use-return-focus";

import { useFindHighlight, type FindTarget } from "./find-highlight";
import { findMatches, startIndex, stepMatch } from "./find-model";
import { useThreadSearch } from "./use-thread-search";

/** Where the transcript stood when find opened, to go back to on Esc. */
export interface ScrollAnchor {
  /** The first row in view, and how far its top sat below the view's. */
  readonly messageId: string | undefined;
  readonly top: number;
  /** It was at the bottom, following what arrives. */
  readonly atEnd: boolean;
}

/** The transcript's scroller's place now, as `ScrollAnchor` says it. */
export function scrollAnchor(scroller: HTMLElement | null | undefined): ScrollAnchor | undefined {
  if (!scroller) return undefined;
  const view = scroller.getBoundingClientRect();
  const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
  const rows = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")]
    .map((row) => ({ row, box: row.getBoundingClientRect() }))
    .filter(({ box }) => box.bottom > view.top)
    .toSorted((a, b) => a.box.top - b.box.top);
  const first = rows[0];
  return {
    messageId: first?.row.dataset.messageId,
    top: first === undefined ? 0 : first.box.top - view.top,
    atEnd,
  };
}

/** Older history than is loaded: the server's hits there, one a message, until a step loads it. */
const OLDER_LIMIT = 200;

/**
 * ⌘F within a thread: finds the words in every loaded message, its tool calls' input and output
 * included, whether the transcript has drawn its row or not, and the server's hits in older history.
 * Matches are marked where drawn; ⏎ steps up to older ones and ⇧⏎ down, from the newest. Esc closes
 * it and puts the transcript back where it was; the close button leaves it on the match.
 */
export function FindBar({
  threadId,
  messages,
  earlier,
  getScroller,
  onReveal,
  onClose,
}: {
  threadId: ThreadId;
  /** The transcript's messages, top to bottom, drawn or not. */
  messages: readonly GramUIMessage[];
  /** The thread has history older than `messages`. */
  earlier: boolean;
  getScroller: () => HTMLElement | null | undefined;
  /** Scrolls the transcript to a message it hasn't drawn, loading it first if need be. */
  onReveal: (messageId: string) => void;
  /** `restore`: where the transcript stood when find opened, to scroll back to. */
  onClose: (restore: ScrollAnchor | undefined) => void;
}) {
  useReturnFocus();
  const [query, setQuery] = useState("");
  /** The current match, by key, so it holds while messages stream in; else the newest. */
  const [currentKey, setCurrentKey] = useState<string>();
  // Taken as find opens, before any step scrolls.
  const [anchor] = useState(() => scrollAnchor(getScroller()));

  const local = useMemo(() => findMatches(messages, query), [messages, query]);
  const older = useThreadSearch(earlier ? query : "", { threadId, limit: OLDER_LIMIT });
  const matches = useMemo(() => {
    if (older.status !== "done") return local.matches;
    const loaded = new Set(messages.map((m) => m.id));
    const seen = new Set<string>();
    const unloaded: FindTarget[] = [];
    for (const hit of older.hits) {
      if (!hit.messageId || loaded.has(hit.messageId) || seen.has(hit.messageId)) continue;
      seen.add(hit.messageId);
      unloaded.push({ key: `older:${hit.messageId}`, messageId: hit.messageId, occurrence: 0 });
    }
    // Older than anything loaded: they come first, top to bottom. The server ranks them, so their
    // order among themselves is its, not the transcript's.
    return [...unloaded, ...local.matches];
  }, [local.matches, older, messages]);

  const count = matches.length;
  let at = matches.findIndex((m) => m.key === currentKey);
  // An older hit, once its step has loaded it, is the first match in its message.
  if (at === -1 && currentKey?.startsWith("older:")) {
    const messageId = currentKey.slice("older:".length);
    at = matches.findIndex((m) => m.messageId === messageId);
  }
  const index = at === -1 ? startIndex(count) : at;
  const target = index === -1 ? undefined : matches[index];
  const truncated = local.truncated || (older.status === "done" && older.truncated);

  useFindHighlight(getScroller, query.trim() === "" ? "" : query, target, onReveal);

  const step = (delta: number) => {
    if (count === 0) return;
    setCurrentKey(matches[stepMatch(index, delta, count)]!.key);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (imeComposing(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? 1 : -1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose(anchor);
    }
  };

  const status =
    query.trim() === ""
      ? ""
      : count === 0
        ? older.status === "searching"
          ? "Searching…"
          : "No matches"
        : `${index + 1} of ${count}${truncated ? "+" : ""}`;
  const inTool = target?.toolCallId !== undefined;

  return (
    <div
      role="search"
      data-testid="find-bar"
      className="flex shrink-0 items-center gap-1 border-b border-edge bg-card px-3 py-1"
    >
      <input
        autoFocus
        aria-label="Find in thread"
        placeholder="Find in thread…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setCurrentKey(undefined);
        }}
        onKeyDown={onKeyDown}
        className="h-7 min-w-0 flex-1 bg-transparent text-reading outline-none placeholder:text-muted-foreground"
      />
      {inTool && (
        <span data-testid="find-in-tool" className="shrink-0 text-meta text-muted-foreground">
          In tool output
        </span>
      )}
      <span
        aria-live="polite"
        data-testid="find-status"
        // Still asking the server about history older than what is loaded: the count may grow.
        aria-busy={older.status === "searching" || undefined}
        className="shrink-0 text-meta text-muted-foreground tabular-nums"
      >
        {status}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match (⏎)"
        title="Previous match (⏎)"
        disabled={count === 0}
        onClick={() => step(-1)}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Next match (${keyLabel("⇧")}⏎)`}
        title={`Next match (${keyLabel("⇧")}⏎)`}
        disabled={count === 0}
        onClick={() => step(1)}
      >
        <ChevronDown />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close find, staying here"
        title="Close find, staying here (Esc goes back)"
        onClick={() => onClose(undefined)}
      >
        <X />
      </Button>
    </div>
  );
}
