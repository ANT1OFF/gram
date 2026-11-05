import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DrawnCheck } from "@/motion";

import { WhyDisabled } from "./fields";

/**
 * The footer of a settings section that saves as a whole, such as custom models: what the section
 * edits on the left, then where it stands (Unsaved changes, or ✓ Saved once stored) and its Save
 * button, which stays a quiet outline until there is something to save. Every other setting saves
 * as it changes and says "Saved" beside its own name (`SavedMark`).
 */
export function SaveFooter({
  dirty,
  saved,
  onSave,
  label = "Save",
  children,
}: {
  /** Something differs from what is stored. */
  dirty: boolean;
  /** The last save succeeded and nothing has changed since. */
  saved: boolean;
  onSave: () => void;
  label?: string;
  /** The section's other actions, such as Add model. */
  children?: ReactNode;
}) {
  return (
    <div
      data-testid="settings-save-footer"
      className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-3"
    >
      {children}
      <div className="ms-auto flex items-center gap-3">
        {dirty ? (
          <span data-testid="settings-unsaved" className="text-meta text-warning-text">
            Unsaved changes
          </span>
        ) : (
          saved && (
            <span
              role="status"
              className="gram-fade inline-flex items-center gap-0.5 text-meta text-success-text"
            >
              <DrawnCheck className="size-3.5" />
              Saved
            </span>
          )
        )}
        <WhyDisabled reason={dirty ? undefined : "Nothing to save: no changes yet."}>
          <Button
            size="sm"
            variant={dirty ? "default" : "outline"}
            disabled={!dirty}
            onClick={onSave}
          >
            {label}
          </Button>
        </WhyDisabled>
      </div>
    </div>
  );
}
