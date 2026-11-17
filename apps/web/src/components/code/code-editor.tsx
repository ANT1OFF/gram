import { ChevronDown, ChevronUp, X } from "lucide-react";
import {
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { columns, findAll, indent, lineOf, lineStarts } from "./editing";

/** A problem on a line of the text, from 1, set by the host: a build error, a lint finding. */
export interface CodeEditorMarker {
  readonly line: number;
  readonly message: string;
}

/** What a host can do to a `CodeEditor` through its `ref`. */
export interface CodeEditorHandle {
  focus(): void;
  /** Opens Find, with `query` in it when given. */
  find(query?: string): void;
  closeFind(): void;
  /** Puts the caret at the start of `line`, from 1, and scrolls it into view. */
  goToLine(line: number): void;
}

const LINE = "1.25rem";
const MATCH_LIMIT = 1000;

/**
 * A plain code editor: line numbers, no colours, a monospace textarea that scrolls both ways, Find
 * (Ctrl or ⌘ F), and the host's `markers` drawn on their lines and listed under it. Tab indents and
 * Shift+Tab outdents; Escape, then Tab, moves on from it. `readOnly` keeps Find and the markers.
 */
export function CodeEditor({
  value,
  onChange,
  readOnly: readOnlyAsked = false,
  markers = [],
  label,
  tabSize = 2,
  onKeyDown,
  className,
  testId,
  ref,
}: {
  value: string;
  onChange?: ((value: string) => void) | undefined;
  readOnly?: boolean | undefined;
  markers?: readonly CodeEditorMarker[] | undefined;
  /** The editor's name for a screen reader: "Code of App.tsx". */
  label: string;
  /** Spaces a Tab types, and a tab character's width. Default 2. */
  tabSize?: number | undefined;
  /** Called first for every key in the text; `preventDefault` stops the editor's own handling. */
  onKeyDown?: ((event: KeyboardEvent<HTMLTextAreaElement>) => void) | undefined;
  className?: string | undefined;
  testId?: string | undefined;
  ref?: Ref<CodeEditorHandle> | undefined;
}) {
  const readOnly = readOnlyAsked || onChange === undefined;
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const unit = useRef<HTMLSpanElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const escaped = useRef(false);
  const pending = useRef<{ start: number; end: number } | undefined>(undefined);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);

  const starts = useMemo(() => lineStarts(value), [value]);
  const count = starts.length;
  const numbers = useMemo(
    () => Array.from({ length: count }, (_, index) => index + 1).join("\n"),
    [count],
  );
  const widest = useMemo(
    () => value.split("\n").reduce((most, line) => Math.max(most, columns(line, tabSize)), 0),
    [value, tabSize],
  );
  const matches = useMemo(
    () => (finding ? findAll(value, query, MATCH_LIMIT) : []),
    [finding, value, query],
  );
  const at = matches.length ? Math.min(current, matches.length - 1) : -1;
  const marked = useMemo(() => {
    const lines = new Map<number, string[]>();
    for (const marker of markers)
      if (marker.line >= 1 && marker.line <= count)
        lines.set(marker.line, [...(lines.get(marker.line) ?? []), marker.message]);
    return lines;
  }, [markers, count]);

  useLayoutEffect(() => {
    const selection = pending.current;
    if (selection === undefined || area.current === null) return;
    pending.current = undefined;
    area.current.setSelectionRange(selection.start, selection.end);
  });

  const metrics = () => {
    const box = unit.current?.getBoundingClientRect();
    return { column: box?.width || 8, line: box?.height || 20 };
  };

  const reveal = (offset: number, length = 0) => {
    const box = scroller.current;
    if (box === null) return;
    const line = lineOf(starts, offset);
    const column = columns(value.slice(starts[line], offset), tabSize);
    const size = metrics();
    const top = line * size.line;
    const left = column * size.column;
    const gutter = box.querySelector<HTMLElement>("[data-gutter]")?.offsetWidth ?? 0;
    if (top < box.scrollTop || top + size.line > box.scrollTop + box.clientHeight)
      box.scrollTop = Math.max(0, top - box.clientHeight / 3);
    const visible = box.clientWidth - gutter;
    const right = left + Math.max(length, 1) * size.column;
    if (left < box.scrollLeft || right > box.scrollLeft + visible)
      box.scrollLeft = Math.max(0, left - visible / 3);
  };

  const goTo = (index: number) => {
    if (!matches.length) return;
    const next = (index + matches.length) % matches.length;
    setCurrent(next);
    reveal(matches[next]!, query.length);
  };

  const openFind = (initial?: string) => {
    if (initial !== undefined) {
      setQuery(initial);
      setCurrent(0);
    }
    setFinding(true);
    requestAnimationFrame(() => {
      findInput.current?.focus();
      findInput.current?.select();
    });
  };

  const closeFind = () => {
    setFinding(false);
    const text = area.current;
    if (text === null) return;
    text.focus();
    if (at >= 0) text.setSelectionRange(matches[at]!, matches[at]! + query.length);
  };

  const goToLine = (line: number) => {
    const target = Math.min(Math.max(1, Math.floor(line)), count);
    const offset = starts[target - 1]!;
    area.current?.focus();
    area.current?.setSelectionRange(offset, offset);
    reveal(offset);
  };

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    find: (initial?: string) => openFind(initial),
    closeFind,
    goToLine,
  }));

  const replace = (from: number, to: number, insert: string, start: number, end: number) => {
    const text = area.current;
    if (text === null) return;
    text.setSelectionRange(from, to);
    let typed = false;
    try {
      typed = document.execCommand?.("insertText", false, insert) ?? false;
    } catch {
      typed = false;
    }
    if (typed) {
      text.setSelectionRange(start, end);
      return;
    }
    pending.current = { start, end };
    onChange?.(value.slice(0, from) + insert + value.slice(to));
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const command = event.metaKey || event.ctrlKey;
    if (command && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      const { selectionStart, selectionEnd } = event.currentTarget;
      const picked = value.slice(selectionStart, selectionEnd);
      openFind(picked && !picked.includes("\n") ? picked : undefined);
      return;
    }
    if (event.key === "Escape") {
      escaped.current = true;
      return;
    }
    if (event.key === "Shift") return;
    const wasEscaped = escaped.current;
    escaped.current = false;
    if (event.key !== "Tab" || readOnly || wasEscaped || command || event.altKey) return;
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end } = event.currentTarget;
    const edit = indent({ value, start, end }, tabSize, event.shiftKey);
    if (edit.from === edit.to && edit.insert === "") return;
    if (value.slice(edit.from, edit.to) === edit.insert) return;
    replace(edit.from, edit.to, edit.insert, edit.start, edit.end);
  };

  const hint = `${id}-hint`;
  const problems = `${id}-problems`;
  const lineTop = (line: number) => `calc(${line - 1} * ${LINE})`;

  return (
    <div
      data-slot="code-editor"
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border border-input bg-card text-foreground",
        className,
      )}
      data-testid={testId}
    >
      {finding && (
        <div
          role="search"
          className="flex items-center gap-1.5 border-b border-edge px-2 py-1.5 text-meta"
        >
          <Input
            ref={findInput}
            aria-label="Find"
            placeholder="Find"
            value={query}
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              setCurrent(0);
              const first = findAll(value, next, 1)[0];
              if (first !== undefined) reveal(first, next.length);
            }}
            onKeyDown={(event) => {
              const command = event.metaKey || event.ctrlKey;
              if (command && event.key.toLowerCase() === "f") {
                event.preventDefault();
                event.currentTarget.select();
              } else if (event.key === "Enter") {
                event.preventDefault();
                goTo(event.shiftKey ? at - 1 : at + 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeFind();
              }
            }}
            className="h-7 max-w-none min-w-0 flex-1 text-meta"
          />
          <span
            aria-live="polite"
            className="min-w-16 shrink-0 text-right text-muted-foreground tabular-nums"
          >
            {query === ""
              ? ""
              : matches.length === 0
                ? "No matches"
                : `${at + 1} of ${matches.length}${matches.length === MATCH_LIMIT ? "+" : ""}`}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Previous match"
            disabled={!matches.length}
            onClick={() => goTo(at - 1)}
          >
            <ChevronUp aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Next match"
            disabled={!matches.length}
            onClick={() => goTo(at + 1)}
          >
            <ChevronDown aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Close Find" onClick={closeFind}>
            <X aria-hidden />
          </Button>
        </div>
      )}
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto font-mono text-meta [font-variant-ligatures:none]"
        style={{ tabSize, lineHeight: LINE }}
        onMouseDown={(event) => {
          if (
            event.target !== event.currentTarget &&
            event.target !== event.currentTarget.firstChild
          )
            return;
          event.preventDefault();
          area.current?.focus();
          area.current?.setSelectionRange(value.length, value.length);
        }}
      >
        <div className="flex min-w-max py-1.5">
          <div
            data-gutter
            aria-hidden
            className="sticky left-0 z-10 shrink-0 bg-card pr-3 pl-2 text-right text-muted-foreground tabular-nums select-none"
          >
            <pre className="m-0 min-w-6 font-[inherit]">{numbers}</pre>
            {[...marked].map(([line, messages]) => (
              <div
                key={line}
                data-marked-line={line}
                title={messages.join("\n")}
                className="absolute inset-x-0 bg-card"
                style={{ top: lineTop(line), height: LINE }}
              >
                <div className="size-full border-l-2 border-destructive bg-destructive/10 pr-3 font-medium text-danger-text">
                  {line}
                </div>
              </div>
            ))}
          </div>
          <div className="relative mr-6 flex-1">
            <span
              ref={unit}
              aria-hidden
              className="invisible absolute w-[1ch]"
              style={{ height: LINE }}
            />
            {[...marked.keys()].map((line) => (
              <div
                key={line}
                aria-hidden
                className="absolute -inset-x-6 bg-destructive/10"
                style={{ top: lineTop(line), height: LINE }}
              />
            ))}
            {matches.map((offset, index) => {
              const line = lineOf(starts, offset);
              const column = columns(value.slice(starts[line], offset), tabSize);
              const width = columns(value.slice(starts[line], offset + query.length), tabSize);
              return (
                <span
                  key={offset}
                  aria-hidden
                  data-match={index === at ? "current" : "other"}
                  className={cn(
                    "absolute",
                    index === at ? "bg-highlight/50 ring-1 ring-highlight" : "bg-highlight/20",
                  )}
                  style={{
                    top: lineTop(line + 1),
                    height: LINE,
                    left: `${column}ch`,
                    width: `${width - column}ch`,
                  }}
                />
              );
            })}
            <textarea
              ref={area}
              aria-label={label}
              aria-describedby={marked.size ? `${hint} ${problems}` : hint}
              {...(marked.size ? { "aria-invalid": true } : {})}
              value={value}
              readOnly={readOnly}
              onChange={(event) => onChange?.(event.target.value)}
              onKeyDown={keyDown}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              wrap="off"
              data-slot="code-editor-text"
              className="relative block resize-none overflow-hidden border-0 bg-transparent p-0 whitespace-pre text-foreground caret-foreground outline-none"
              style={{
                width: `max(100%, ${widest + 1}ch)`,
                height: `calc(${count} * ${LINE})`,
                lineHeight: LINE,
                tabSize,
                font: "inherit",
              }}
            />
          </div>
        </div>
      </div>
      <span id={hint} className="sr-only">
        {readOnly
          ? "Read only. Ctrl or Command F finds."
          : "Tab indents. Press Escape, then Tab, to move on. Ctrl or Command F finds."}
      </span>
      {markers.length > 0 && (
        <ul
          id={problems}
          aria-label="Problems"
          className="flex max-h-32 flex-col overflow-auto border-t border-edge text-meta"
        >
          {markers.map((marker, index) => (
            <li key={index}>
              <button
                type="button"
                className="flex w-full gap-2 px-3 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
                onClick={() => goToLine(marker.line)}
              >
                <strong className="shrink-0 font-medium text-danger-text">
                  Line {marker.line}.
                </strong>
                <span className="min-w-0 text-muted-foreground">{marker.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
