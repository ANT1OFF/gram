import {
  FILE_EDIT_VERB,
  isCredentialPath,
  languageFor,
  type DiffFile,
  type FileEdit,
} from "@gram/contracts";
import { ChevronRight } from "lucide-react";
import { useId, useState, type MouseEvent } from "react";
import type { BundledLanguage } from "shiki";

import { cn } from "@/lib/utils";
import { Expand } from "@/motion";
import { showFileAt } from "@/panels/files/files-store";
import { PatchView } from "@/panels/patch-view";

import { useFileRefsScope } from "./file-ref-link";
import { basename, partEdits, PHASE_DISPLAY, toolPhase, type AnyToolPart } from "./parts";

/** Diff rows an opened edit shows before "Show more". */
const EDIT_ROW_BUDGET = 30;

const STATUS: Record<FileEdit["kind"], DiffFile["status"]> = {
  create: "added",
  write: "added",
  modify: "modified",
  delete: "deleted",
};

/** An edit as the diff panel's file, so the transcript draws it with the panel's `PatchView`. */
export const editDiffFile = (edit: FileEdit): DiffFile => ({
  path: edit.movedTo ?? edit.path,
  ...(edit.movedTo === undefined ? {} : { oldPath: edit.path }),
  status: STATUS[edit.kind],
  additions: edit.additions,
  deletions: edit.deletions,
  patch: edit.hunks
    .map(
      (hunk) =>
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
    )
    .join("\n"),
  binary: false,
  tooLarge: false,
});

/** `+4 −1`; a new file only adds, and a deleted one counts nothing worth reading. */
export function EditCounts({
  additions,
  deletions,
  kind = "modify",
}: {
  additions: number;
  deletions: number;
  kind?: FileEdit["kind"] | undefined;
}) {
  if (kind === "delete") return null;
  return (
    <span data-testid="edit-counts" className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-success">+{additions}</span>
      {kind === "modify" && (
        <>
          {" "}
          <span className="text-destructive">−{deletions}</span>
        </>
      )}
    </span>
  );
}

/**
 * A tool call that changes files, as one compact row per file: "Edited file-tabs.tsx +4 −1".
 * Opening a row shows its diff; its file name opens the file in the Files panel.
 */
export function FileEditCard({ part }: { part: AnyToolPart }) {
  const phase = toolPhase(
    part.state,
    part.state === "output-error" ? part.errorText : undefined,
    part.state === "output-available" && part.preliminary === true,
  );
  const edits = partEdits(part);
  const error = part.state === "output-error" ? part.errorText : undefined;
  if (edits.length === 0) {
    // The call hasn't named its file yet.
    return (
      <div
        data-testid="file-edit"
        data-tool-call-id={part.toolCallId}
        className="mb-2 py-0.5 text-sm text-muted-foreground"
      >
        {phase === "pending" || phase === "running" ? "Editing…" : (error ?? "Edit")}
      </div>
    );
  }
  return (
    <div className="mb-2" data-tool-call-id={part.toolCallId}>
      {edits.map((edit, index) => (
        <FileEditRow
          // A patch names each file once.
          key={`${edit.path}:${index}`}
          edit={edit}
          phase={phase}
          error={index === 0 ? error : undefined}
        />
      ))}
    </div>
  );
}

function FileEditRow({
  edit,
  phase,
  error,
}: {
  edit: FileEdit;
  phase: ReturnType<typeof toolPhase>;
  /** Shown under the diff when opened; on the first file only. */
  error: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  // Like a tool card's body: not laid out until first opened, then kept so closing animates.
  const [opened, setOpened] = useState(false);
  const bodyId = useId();
  const scope = useFileRefsScope();
  const working = phase === "pending" || phase === "running";
  // Only a finished call changed the file; one waiting, refused or failed is still "Editing".
  const verb = FILE_EDIT_VERB[edit.kind][phase === "done" ? "done" : "doing"];
  const name = basename(edit.movedTo ?? edit.path);
  const display = PHASE_DISPLAY[phase];
  const openable = edit.hunks.length > 0 || error !== undefined;
  // A deleted file is gone, and a credential file isn't previewed from a link.
  const linked = scope !== undefined && edit.kind !== "delete" && !isCredentialPath(edit.path);
  const toggle = () => {
    if (!openable) return;
    setOpen(!open);
    setOpened(true);
  };
  const showFile = (event: MouseEvent) => {
    event.stopPropagation();
    if (scope) showFileAt(scope.threadId, scope.roots, edit.movedTo ?? edit.path);
  };

  return (
    <div data-testid="file-edit" data-kind={edit.kind} data-open={open}>
      {/* The chevron is the row's control; the rest of the row is a larger target for a mouse. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        onClick={toggle}
        className={cn(
          "group flex max-w-full items-center gap-1.5 py-0.5 text-sm",
          openable && "cursor-pointer",
          working ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {/* Spaces between the flex items render nothing, but make the row read as words. */}
        <span className="shrink-0">{verb}</span>{" "}
        {linked ? (
          <button
            type="button"
            title={edit.movedTo ? `${edit.path} → ${edit.movedTo}` : edit.path}
            onClick={showFile}
            className="min-w-0 truncate rounded-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {name}
          </button>
        ) : (
          <span title={edit.path} className="min-w-0 truncate text-foreground">
            {name}
          </span>
        )}
        {working && <span className="shrink-0">…</span>}{" "}
        {!working && (
          <EditCounts additions={edit.additions} deletions={edit.deletions} kind={edit.kind} />
        )}
        {phase !== "done" && !working && (
          <span className={cn("shrink-0 text-xs", display.tone)}>{display.label}</span>
        )}
        {openable && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={open ? `Hide changes to ${name}` : `Show changes to ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
            className="shrink-0 rounded-sm outline-none group-hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-(--dur-fast)",
                open && "rotate-90",
              )}
            />
          </button>
        )}
      </div>
      <Expand open={open} id={bodyId}>
        {opened && (
          <div className="pt-1 pb-1.5">
            {edit.hunks.length > 0 && (
              <div className="max-h-[32rem] overflow-y-auto rounded-(--radius-md) border border-border bg-card/40">
                <PatchView
                  file={editDiffFile(edit)}
                  budget={EDIT_ROW_BUDGET}
                  numbered={edit.numbered}
                  headers={false}
                  language={languageFor(edit.path) as BundledLanguage | undefined}
                />
              </div>
            )}
            {error !== undefined && (
              <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-destructive">
                {error}
              </pre>
            )}
          </div>
        )}
      </Expand>
    </div>
  );
}
