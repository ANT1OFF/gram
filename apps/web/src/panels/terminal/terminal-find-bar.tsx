import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { useShortcut } from "@/keyboard/registry";
import { cn } from "@/lib/utils";

import type { TerminalFindResults } from "./ghostty-loader";

export interface FindToggles {
  caseSensitive: boolean;
  regex: boolean;
}

/** How the bar drives the terminal's search. */
export interface TerminalFind {
  /** `incremental` keeps the current match while it still matches, as when typing. */
  next(query: string, toggles: FindToggles, incremental?: boolean): void;
  previous(query: string, toggles: FindToggles): void;
  /** Drops the highlights and the selected match. */
  clear(): void;
}

/** An open (or refocus) of the bar; a non-empty `seed` replaces the query. */
export interface FindRequest {
  nonce: number;
  seed: string;
}

type Step = "incremental" | "next" | "previous";

const validPattern = (query: string, regex: boolean) => {
  if (!regex) return true;
  try {
    return typeof new RegExp(query).source === "string";
  } catch {
    return false;
  }
};

const runSearch = (find: TerminalFind, query: string, toggles: FindToggles, step: Step) => {
  if (query === "" || !validPattern(query, toggles.regex)) find.clear();
  else if (step === "previous") find.previous(query, toggles);
  else find.next(query, toggles, step === "incremental");
};

export function findStatus(
  query: string,
  valid: boolean,
  results: TerminalFindResults | undefined,
): string {
  if (query === "") return "";
  if (!valid) return "Invalid pattern";
  if (results === undefined) return "";
  if (results.count === 0) return "No matches";
  return results.index === -1
    ? `${results.count} matches`
    : `${results.index + 1} of ${results.count}`;
}

/**
 * `⌘F` while a terminal has focus: finds in its buffer and highlights every match. ⏎ / ⇧⏎ and ⌘G /
 * ⌘⇧G step through the matches; Esc closes the bar.
 */
export function TerminalFindBar({
  find,
  results,
  request,
  inScope,
  onClose,
}: {
  find: TerminalFind;
  results: TerminalFindResults | undefined;
  request: FindRequest;
  /** Whether focus is within this terminal, bar included. */
  inScope: () => boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(request.seed);
  const [toggles, setToggles] = useState<FindToggles>({ caseSensitive: false, regex: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ find, query, toggles });
  useEffect(() => {
    latest.current = { find, query, toggles };
  });

  // A later request's seed replaces the query during render; its search and focus follow below.
  const [handled, setHandled] = useState(request);
  if (handled !== request) {
    setHandled(request);
    if (request.seed !== "") setQuery(request.seed);
  }
  useEffect(() => {
    if (request.seed !== "") {
      runSearch(latest.current.find, request.seed, latest.current.toggles, "incremental");
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [request]);

  const step = (how: Step) =>
    runSearch(latest.current.find, latest.current.query, latest.current.toggles, how);
  useShortcut({
    id: "terminal.findNext",
    keys: "mod+g",
    label: "Find next in terminal",
    group: "Terminal",
    focusScope: inScope,
    run: () => step("next"),
  });
  useShortcut({
    id: "terminal.findPrevious",
    keys: "mod+shift+g",
    label: "Find previous in terminal",
    group: "Terminal",
    focusScope: inScope,
    run: () => step("previous"),
  });

  const valid = validPattern(query, toggles.regex);
  const canStep = query !== "" && valid && (results?.count ?? 0) > 0;

  const toggle = (name: keyof FindToggles) => {
    const next = { ...toggles, [name]: !toggles[name] };
    setToggles(next);
    // The terminal keeps its last results while the query is unchanged, whatever the toggles.
    find.clear();
    runSearch(find, query, next, "next");
    inputRef.current?.focus();
  };

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    step(event.shiftKey ? "previous" : "next");
  };

  return (
    <div
      role="search"
      data-testid="terminal-find-bar"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
      className="absolute top-2 right-3 z-10 flex items-center gap-1 rounded-md border border-border bg-card py-1 pr-1 pl-2 shadow-md"
    >
      <input
        ref={inputRef}
        aria-label="Find in terminal"
        placeholder="Find"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          runSearch(find, event.target.value, toggles, "incremental");
        }}
        onKeyDown={onFieldKeyDown}
        className="h-6 w-40 min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <span
        aria-live="polite"
        data-testid="terminal-find-status"
        className={cn(
          "shrink-0 text-xs tabular-nums",
          valid ? "text-muted-foreground" : "text-danger-text",
        )}
      >
        {findStatus(query, valid, results)}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Match case"
        title="Match case"
        aria-pressed={toggles.caseSensitive}
        onClick={() => toggle("caseSensitive")}
        className="font-mono text-[11px] aria-pressed:bg-muted aria-pressed:text-foreground"
      >
        Aa
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Use regular expression"
        title="Use regular expression"
        aria-pressed={toggles.regex}
        onClick={() => toggle("regex")}
        className="font-mono text-[11px] aria-pressed:bg-muted aria-pressed:text-foreground"
      >
        .*
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        disabled={!canStep}
        onClick={() => step("previous")}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        disabled={!canStep}
        onClick={() => step("next")}
      >
        <ChevronDown />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Close find" onClick={onClose}>
        <X />
      </Button>
    </div>
  );
}
