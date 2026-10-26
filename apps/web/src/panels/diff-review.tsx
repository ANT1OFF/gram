import type { ThreadId } from "@gram/contracts";
import { MessageSquare, MessageSquarePlus, X } from "lucide-react";
import { createContext, useContext, useMemo, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  commentLabel,
  useDiffComments,
  useDiffCommentsStore,
  type DiffComment,
} from "@/stores/diff-comments";

/** Lines picked in one hunk of one file, `anchor` where the pick began and `head` where it ends. */
interface LineSelection {
  path: string;
  hunk: number;
  anchor: number;
  head: number;
}

/** What a patch needs to take comments: the pick, the open editor, and the thread's drafts. */
export interface DiffReview {
  threadId: ThreadId;
  selection: LineSelection | undefined;
  /** The selection's comment editor is open. */
  composing: boolean;
  /** The draft whose note is being edited. */
  editing: string | undefined;
  comments: readonly DiffComment[];
  /** Picks a line; `extend` stretches the pick from its anchor within the same hunk. */
  select(path: string, hunk: number, line: number, extend: boolean): void;
  clear(): void;
  compose(): void;
  add(comment: Omit<DiffComment, "id">): void;
  edit(id: string | undefined): void;
}

export const DiffReviewContext = createContext<DiffReview | undefined>(undefined);

export const useDiffReview = () => useContext(DiffReviewContext);

/**
 * The Diff panel's comment state for `threadId`, to provide through `DiffReviewContext`. A new
 * `diff` (another scope, or a refresh that changed it) drops the pick and any open editor, which
 * point into the old one.
 */
export function useDiffReviewState(threadId: ThreadId, diff: unknown): DiffReview {
  const comments = useDiffComments(threadId);
  const [selection, setSelection] = useState<LineSelection>();
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [seenDiff, setSeenDiff] = useState(diff);
  if (diff !== seenDiff) {
    setSeenDiff(diff);
    setSelection(undefined);
    setComposing(false);
    setEditing(undefined);
  }
  return useMemo(
    () => ({
      threadId,
      selection,
      composing,
      editing,
      comments,
      select: (path, hunk, line, extend) => {
        setComposing(false);
        setSelection((current) =>
          extend && current?.path === path && current.hunk === hunk
            ? { ...current, head: line }
            : { path, hunk, anchor: line, head: line },
        );
      },
      clear: () => {
        setSelection(undefined);
        setComposing(false);
      },
      compose: () => setComposing(true),
      add: (comment) => {
        useDiffCommentsStore.getState().add(threadId, { ...comment, id: crypto.randomUUID() });
        setSelection(undefined);
        setComposing(false);
      },
      edit: setEditing,
    }),
    [threadId, selection, composing, editing, comments],
  );
}

/** `line 14` or `lines 12-14`, for a range of new or old line numbers. */
export const linesLabel = (start: number, end: number) =>
  start === end ? `line ${start}` : `lines ${start}-${end}`;

const ROW_CELL = "border-y border-border bg-card px-2 py-1.5 font-sans";

/** Under a pick: the way to comment on it without the context menu. */
export function CommentActionRow({
  span,
  label,
  onCompose,
  onClear,
}: {
  span: number;
  label: string;
  onCompose: () => void;
  onClear: () => void;
}) {
  return (
    <tr data-testid="diff-comment-action">
      <td colSpan={span} className={ROW_CELL}>
        <div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" onClick={onCompose}>
            <MessageSquarePlus data-icon="inline-start" />
            Comment on {label}
          </Button>
          <button
            type="button"
            aria-label="Clear the selection"
            title="Clear the selection"
            onClick={onClear}
            className="rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden className="size-3" />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** A note for the agent being written: ⌘⏎ adds it, Esc cancels. */
export function CommentEditorRow({
  span,
  label,
  initial = "",
  submitLabel,
  onSubmit,
  onCancel,
}: {
  span: number;
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState(initial);
  const submit = () => {
    if (note.trim() !== "") onSubmit(note.trim());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      // Here ⌘⏎ adds the comment; the composer's Send must not also take it.
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };
  return (
    <tr data-testid="diff-comment-editor">
      <td colSpan={span} className={ROW_CELL}>
        <textarea
          // The editor opens because the user asked to write in it.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          aria-label={`Comment on ${label}`}
          placeholder="A note for the agent: it goes with your next message"
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={onKeyDown}
          className="block w-full resize-y rounded-md border border-input bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <div className="mt-1 flex items-center justify-end gap-1">
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="xs" disabled={note.trim() === ""} onClick={submit}>
            {submitLabel}
            <kbd className="font-mono text-[10px] opacity-70">⌘⏎</kbd>
          </Button>
        </div>
      </td>
    </tr>
  );
}

/** A draft comment, under the line it ends on; right-click edits or deletes it. */
export function CommentNoteRow({ span, comment }: { span: number; comment: DiffComment }) {
  return (
    <tr data-testid="diff-comment" data-comment={comment.id}>
      <td colSpan={span} className={ROW_CELL}>
        <div className="flex min-w-0 items-start gap-1.5 text-xs">
          <MessageSquare aria-hidden className="mt-0.5 size-3 shrink-0 text-info" />
          <span className="sr-only">Draft comment on {commentLabel(comment)}:</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {comment.note}
          </span>
          <span className="shrink-0 text-muted-foreground">draft</span>
        </div>
      </td>
    </tr>
  );
}
