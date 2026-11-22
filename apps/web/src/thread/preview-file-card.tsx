import type { ThreadId } from "@gram/contracts";
import { FileText, LayoutDashboard } from "lucide-react";
import { createContext, lazy, Suspense, useContext, useState } from "react";

import { Button } from "@/components/ui/button";
import { closeBeside } from "@/orchestration/beside-store";
import { useFeature } from "@/settings/use-diagnostics";
import { useOpenThread } from "@/shell/thread-switcher";
import { useLayoutStore } from "@/stores/layout";

import type { PreviewableFile } from "./preview-files";

const FileQuickLook = lazy(() =>
  import("@/panels/files/file-quick-look").then((m) => ({ default: m.FileQuickLook })),
);

const KIND_LABEL = { markdown: "Markdown", html: "HTML page" } as const;

const nameOf = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const folderOf = (path: string) => path.slice(0, path.length - nameOf(path).length - 1);

/**
 * Where a file card's Preview shows the file: the Preview tab beside the thread (`tab`), or a
 * window over the app (`window`) for a thread shown in the right pane, which has no Preview tab of
 * its own. The worker pane sets `window`.
 */
export const FilePreviewPlace = createContext<"tab" | "window">("tab");

/**
 * A folder's last part, behind an ellipsis when it is more than two deep: the card has room for where
 * the file sits, not for the whole way there from the disk's root. The full path is its tooltip.
 */
export const nearFolder = (folder: string): string => {
  const parts = folder.split(/[\\/]/).filter((part) => part !== "");
  return parts.length <= 2 ? folder : `…/${parts.at(-1)}`;
};

/**
 * A Markdown or HTML file the agent wrote, under the message that wrote it: Preview shows it rendered
 * in the Preview tab, or in the Files panel where there is no Preview tab, or in a window over the
 * app from a worker in the right pane. A long name wraps to a second line rather than being cut, as
 * a published page's card does.
 */
export function PreviewFileCard({ threadId, file }: { threadId: ThreadId; file: PreviewableFile }) {
  const previewPane = useFeature("previewPane");
  const previewFile = useLayoutStore((s) => s.previewFile);
  const place = useContext(FilePreviewPlace);
  const [looking, setLooking] = useState(false);
  const Icon = file.kind === "html" ? LayoutDashboard : FileText;
  const name = nameOf(file.path);
  const open = () =>
    place === "window" ? setLooking(true) : previewFile(threadId, file.path, { previewPane });
  return (
    <div
      data-testid="preview-file-card"
      data-path={file.path}
      className="my-2 flex max-w-xl items-center gap-3 rounded-lg border border-edge bg-card px-3 py-2"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon aria-hidden className="size-icon-row" />
      </span>
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer text-left"
        title={file.path}
        onClick={open}
      >
        <span className="line-clamp-2 text-reading font-medium wrap-anywhere">{name}</span>
        <span className="block truncate text-meta text-muted-foreground">
          {KIND_LABEL[file.kind]} · {nearFolder(folderOf(file.path))}
        </span>
      </button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={`Preview ${name}`}
        onClick={open}
      >
        Preview
      </Button>
      {looking && (
        <QuickLookFromPane threadId={threadId} path={file.path} onClose={() => setLooking(false)} />
      )}
    </div>
  );
}

function QuickLookFromPane({
  threadId,
  path,
  onClose,
}: {
  threadId: ThreadId;
  path: string;
  onClose: () => void;
}) {
  const previewPane = useFeature("previewPane");
  const previewFile = useLayoutStore((s) => s.previewFile);
  const openThread = useOpenThread();
  return (
    <Suspense fallback={null}>
      <FileQuickLook
        threadId={threadId}
        path={path}
        onClose={onClose}
        onOpenInTab={() => {
          onClose();
          closeBeside();
          openThread(threadId);
          previewFile(threadId, path, { previewPane, thread: true });
        }}
      />
    </Suspense>
  );
}
