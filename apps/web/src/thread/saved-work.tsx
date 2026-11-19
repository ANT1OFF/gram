import { savedFileCount, type SavedWork, type ThreadId } from "@gram/contracts";
import { FileText } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/api/errors";
import { formatStamp } from "@/lib/time";
import { useThreadsStore } from "@/stores/threads";

import { filesWord } from "./saved-work-words";

// What was last saved of a worker's work on a joined machine (`Thread.savedWork`): the time, the
// files and their diff. The machine-lost card names it, as do the task's card and the worker's row,
// and View diff opens the diff as the machine last sent it, which is readable while it is away.

/** View diff's dialog (`saved-diff-dialog.tsx`), loaded when first opened. */
export const SavedDiffDialog = lazy(() => import("./saved-diff-dialog"));

/** A save's lines: plus and minus in their tones. */
export function SavedLines({ saved }: { saved: Pick<SavedWork, "additions" | "deletions"> }) {
  return (
    <span className="shrink-0 font-mono text-meta tabular-nums">
      <span className="text-success">+{saved.additions}</span>{" "}
      <span className="text-destructive">−{saved.deletions}</span>
    </span>
  );
}

/** The save's first files with their lines, then the rest counted on one line. */
export function SavedFiles({ saved, shown = 2 }: { saved: SavedWork; shown?: number }) {
  const first = saved.files.slice(0, shown);
  const rest = saved.files.slice(shown);
  const restCount = rest.length + saved.more;
  const restLines = {
    additions: rest.reduce((sum, file) => sum + file.additions, 0),
    deletions: rest.reduce((sum, file) => sum + file.deletions, 0),
  };
  if (first.length === 0) return null;
  return (
    <ul
      data-testid="saved-files"
      className="mt-2 flex flex-col divide-y divide-border rounded-(--radius-md) border border-border text-meta"
    >
      {first.map((file) => (
        <li key={file.path} className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
          <FileText aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
            {file.path}
          </span>
          <SavedLines saved={file} />
        </li>
      ))}
      {restCount > 0 && (
        <li className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-muted-foreground">
          <FileText aria-hidden className="size-icon-row shrink-0" />
          <span className="min-w-0 flex-1 truncate">and {filesWord(restCount)} more</span>
          {/* The ones past what the record lists have no counts here; the diff has them. */}
          {saved.more === 0 && <SavedLines saved={restLines} />}
        </li>
      )}
    </ul>
  );
}

/**
 * Under a worker on its task's card: what its last save held and when, with the diff a click away;
 * once its machine was lost, that it was and Resume worker. Nothing for a worker with no save, which
 * is one on this machine or on a host that doesn't say.
 */
export function SavedWorkLine({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const saved = useThreadsStore((s) => s.byId[threadId]?.thread.savedWork);
  const lost = useThreadsStore((s) => {
    const summary = s.byId[threadId];
    const error = summary?.thread.lastError;
    return summary?.status === "error" && error?.machineLost !== undefined ? error : undefined;
  });
  const [viewing, setViewing] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [failed, setFailed] = useState<string | undefined>();
  if (saved === undefined && lost === undefined) return null;
  const count = saved === undefined ? 0 : savedFileCount(saved);
  const resume = async () => {
    setResuming(true);
    setFailed(undefined);
    try {
      await api.resumeAfterMachineLost(threadId);
    } catch (e) {
      console.error("resume after machine lost", e);
      setFailed(`Couldn't resume the worker: ${errorMessage(e)}`);
    } finally {
      setResuming(false);
    }
  };
  return (
    <li
      data-testid="feature-card-saved"
      data-lost={lost === undefined ? undefined : "true"}
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-meta text-muted-foreground"
    >
      {saved !== undefined && count > 0 ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="text-foreground">Changes</span>
          <SavedLines saved={saved} />
          <span className="truncate">
            in {filesWord(count)} · saved{" "}
            <span className="tabular-nums" title={formatStamp(saved.at)}>
              {formatStamp(saved.at)}
            </span>
          </span>
          <button
            type="button"
            data-testid="feature-card-diff"
            onClick={() => setViewing(true)}
            className="shrink-0 rounded-sm text-foreground underline underline-offset-4 outline-none hover:text-primary focus-visible:focus-ring"
          >
            Diff
          </button>
        </span>
      ) : saved !== undefined ? (
        <span>
          Nothing changed yet · saved <span className="tabular-nums">{formatStamp(saved.at)}</span>
        </span>
      ) : null}
      {saved?.lastFailure !== undefined && (
        <span
          data-testid="feature-card-save-failed"
          className="basis-full truncate text-warning-text"
          title={saved.lastFailure}
        >
          Last save{" "}
          <span className="tabular-nums">{formatStamp(saved.lastAttemptAt ?? saved.at)}</span>{" "}
          failed: {saved.lastFailure}
        </span>
      )}
      {lost !== undefined && (
        <Button
          size="xs"
          variant="outline"
          data-testid="feature-card-resume"
          disabled={resuming}
          title={
            saved === undefined || saved.at > lost.at
              ? "Starts its machine, puts its folder back as last saved, and tells the worker what was cut off."
              : count === 0
                ? "Starts from the branch, with the conversation as it was."
                : `Starts its machine, puts the ${filesWord(count)} back as saved at ${formatStamp(saved.at)}, and tells the worker what was cut off.`
          }
          onClick={() => void resume()}
        >
          {resuming ? "Resuming…" : "Resume worker"}
        </Button>
      )}
      {failed !== undefined && <span className="basis-full text-foreground">{failed}</span>}
      {viewing && saved !== undefined && (
        <Suspense fallback={null}>
          <SavedDiffDialog threadId={threadId} saved={saved} onClose={() => setViewing(false)} />
        </Suspense>
      )}
    </li>
  );
}
