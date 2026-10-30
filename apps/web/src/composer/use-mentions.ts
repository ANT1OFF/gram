import type { FsFileName, FsFilesResult } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from "react";

import { insertMention, mentionTrigger, rankMentions } from "./mention";
import { imeComposing } from "./send-key";

export interface MentionSource {
  /** What's listed, for caching: a thread and its checkout, or a folder. */
  readonly key: readonly unknown[];
  readonly load: () => Promise<FsFilesResult>;
}

/**
 * `@` file mentions for a textarea whose text lives elsewhere. No `source` (no folder yet) or
 * `disabled` (another list is open) keeps the file list shut.
 */
export function useMentions({
  id,
  text,
  setText,
  source,
  disabled = false,
}: {
  id: string;
  text: string;
  setText: (value: string) => void;
  source: MentionSource | undefined;
  disabled?: boolean;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [hasFocus, setHasFocus] = useState(false);
  const [index, setIndex] = useState(0);
  /** The `@` whose file list was closed, so it stays closed until another `@` is typed. */
  const [dismissedAt, setDismissedAt] = useState<number | undefined>();
  const pendingCaret = useRef<number | undefined>(undefined);
  const pasting = useRef(false);

  const trigger =
    hasFocus && !disabled && source !== undefined ? mentionTrigger(text, caret) : undefined;
  const active = trigger !== undefined && trigger.start !== dismissedAt;
  const files = useQuery({
    queryKey: ["fs.files", ...(source?.key ?? [])],
    queryFn: () => source!.load(),
    enabled: active,
    retry: false,
    staleTime: 30_000,
  });
  const entries =
    active && files.data !== undefined ? rankMentions(files.data.entries, trigger.query) : [];
  const open = entries.length > 0;
  const activeIndex = Math.min(index, entries.length - 1);

  // A choice rewrites the text; the caret lands after what was inserted once React has rendered it.
  useLayoutEffect(() => {
    const next = pendingCaret.current;
    if (next === undefined) return;
    pendingCaret.current = undefined;
    textarea.current?.setSelectionRange(next, next);
  });

  /** Text that arrives whole (a paste, a recalled prompt) doesn't pop the file list open. */
  const quiet = (value: string, at: number) => {
    setCaret(at);
    setDismissedAt(mentionTrigger(value, at)?.start);
  };

  const choose = (entry: FsFileName) => {
    if (trigger === undefined) return;
    const next = insertMention(text, trigger, caret, entry);
    setText(next.text);
    setCaret(next.caret);
    pendingCaret.current = next.caret;
    setIndex(0);
  };

  /** The list's keys while it's open; true when the event was one of them. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.metaKey || event.ctrlKey || event.altKey || imeComposing(event))
      return false;
    const handled = (run: () => void) => {
      event.preventDefault();
      run();
      return true;
    };
    const move = (delta: number) =>
      handled(() => setIndex((activeIndex + delta + entries.length) % entries.length));
    if (event.key === "ArrowDown") return move(1);
    if (event.key === "ArrowUp") return move(-1);
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      return handled(() => choose(entries[activeIndex]!));
    }
    if (event.key === "Escape") return handled(() => setDismissedAt(trigger?.start));
    return false;
  };

  return {
    id,
    open,
    entries,
    activeIndex,
    choose,
    quiet,
    onKeyDown,
    /** From the textarea's `onChange`, with the new value and caret. */
    onChange: (value: string, selectionStart: number) => {
      setIndex(0);
      if (value === "") setDismissedAt(undefined);
      if (pasting.current) {
        pasting.current = false;
        quiet(value, selectionStart);
      } else {
        setCaret(selectionStart);
      }
    },
    /** From `onPaste` when the paste lands as text rather than attachments. */
    onPaste: () => {
      pasting.current = true;
    },
    /** After a send clears the text. */
    reset: () => {
      setDismissedAt(undefined);
      setCaret(0);
    },
    textareaProps: {
      ref: textarea,
      onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) =>
        setCaret(event.currentTarget.selectionStart),
      onFocus: () => setHasFocus(true),
      onBlur: () => setHasFocus(false),
    },
  };
}
