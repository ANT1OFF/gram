import type { SavedWork, ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { formatStamp } from "@/lib/time";
import { DiffFileList } from "@/panels/diff-files";

import { DialogShell } from "./dialog-shell";
import { SavedFiles } from "./saved-work";
import { linesWord, savedWhat } from "./saved-work-words";

// View diff's dialog, loaded when it first opens: the diff panel's rows stay out of the first paint.

/**
 * The saved diff, as the machine last sent it: each file in the diff panel's own rows. Once this Gram
 * restarted since the save it has only the record, so it lists the files and says so.
 */
export default function SavedDiffDialog({
  threadId,
  saved,
  onClose,
}: {
  threadId: ThreadId;
  saved: SavedWork;
  onClose: () => void;
}) {
  const api = useApi();
  const query = useQuery({
    queryKey: ["thread", threadId, "savedDiff", saved.at],
    queryFn: () => api.savedDiff(threadId),
    staleTime: Infinity,
  });
  const diff = query.data?.saved;
  return (
    <DialogShell
      testId="saved-diff"
      title={`Saved at ${formatStamp(saved.at)}`}
      description={
        <>
          {savedWhat(saved)}
          {saved.base === undefined ? "" : `, against ${saved.base}`}
          {" · "}
          {linesWord(saved)}
        </>
      }
      onClose={onClose}
      className="w-[min(60rem,94vw)]"
    >
      {query.isPending ? (
        <p className="text-meta text-muted-foreground">Reading the saved diff…</p>
      ) : query.isError ? (
        <p data-testid="saved-diff-failed" className="text-meta break-words">
          Couldn't read the saved diff: {errorMessage(query.error)}
        </p>
      ) : diff === undefined ? (
        <div data-testid="saved-diff-gone" className="flex flex-col gap-2">
          <p className="text-meta text-muted-foreground">
            Gram restarted since this save, so it no longer has the changes themselves, only the
            files. They are kept with the worker&apos;s branch, and come back when it resumes.
          </p>
          <SavedFiles saved={saved} shown={saved.files.length} />
        </div>
      ) : (
        <div className="-mx-5 border-t border-border">
          {diff.note !== undefined && (
            <p className="px-5 py-2 text-meta text-muted-foreground">{diff.note}</p>
          )}
          <DiffFileList files={diff.files} />
        </div>
      )}
    </DialogShell>
  );
}
