import type { ThreadId } from "@gram/contracts";
import { FileText, LayoutDashboard } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useFeature } from "@/settings/use-diagnostics";
import { useLayoutStore } from "@/stores/layout";

import type { PreviewableFile } from "./preview-files";

const KIND_LABEL = { markdown: "Markdown", html: "HTML page" } as const;

const nameOf = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const folderOf = (path: string) => path.slice(0, path.length - nameOf(path).length - 1);

/**
 * A Markdown or HTML file the agent wrote, under the message that wrote it: Open shows it rendered
 * in the Preview tab, or in the Files panel where there is no Preview tab.
 */
export function PreviewFileCard({ threadId, file }: { threadId: ThreadId; file: PreviewableFile }) {
  const previewPane = useFeature("previewPane");
  const previewFile = useLayoutStore((s) => s.previewFile);
  const Icon = file.kind === "html" ? LayoutDashboard : FileText;
  const name = nameOf(file.path);
  const open = () => previewFile(threadId, file.path, { previewPane });
  return (
    <div
      data-testid="preview-file-card"
      data-path={file.path}
      className="my-2 flex max-w-md items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon aria-hidden className="size-4" />
      </span>
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer text-left"
        title={file.path}
        onClick={open}
      >
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {KIND_LABEL[file.kind]} · {folderOf(file.path)}
        </span>
      </button>
      <Button type="button" size="sm" variant="outline" aria-label={`Open ${name}`} onClick={open}>
        Open
      </Button>
    </div>
  );
}
