import type { ThreadId } from "@gram/contracts";
import { Pencil } from "lucide-react";

import { useDraftStore } from "@/stores/drafts";

/** Shown above the composer while "Edit from here" is pending. */
export function EditBanner({ threadId }: { threadId: ThreadId }) {
  const editing = useDraftStore((s) => s.edits[threadId]);
  if (!editing) return null;

  const cancel = () => {
    const drafts = useDraftStore.getState();
    drafts.cancelEdit(threadId);
    drafts.setText(threadId, "");
  };

  return (
    <div
      role="status"
      data-testid="edit-banner"
      className="mx-auto flex w-full max-w-(--thread-max-width) items-center gap-2 px-6 pt-2 text-xs text-muted-foreground"
    >
      <Pencil aria-hidden className="size-3 shrink-0" />
      <span>
        Editing an earlier message. Sending removes it and everything after
        {editing.files ? ", and restores files" : ""}.
      </span>
      <button
        type="button"
        className="ml-auto shrink-0 rounded-(--radius-sm) px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
        onClick={cancel}
      >
        Cancel edit
      </button>
    </div>
  );
}
