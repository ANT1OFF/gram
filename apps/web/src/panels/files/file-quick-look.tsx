import { checkoutRoots, type ThreadId } from "@gram/contracts";
import { PanelRight } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { useThreadFeed } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";
import { Dialog, OverlayBackdrop } from "@/thread/dialog-shell";
import { threadHost } from "@/thread/machine-mark";
import { useMachineMark } from "@/thread/machine-marker";
import { markdownRoot, writesTo } from "@/thread/preview-files";

import { turnUnderWay } from "../preview-webrtc";

import { FilePreview } from "./file-preview";

export const FILE_QUICK_LOOK_TEST_ID = "file-quick-look";

const nameOf = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

/**
 * What a thread's agent did to `path`, from its transcript, and whether it is still at work: what
 * a preview follows the agent's writes by and falls back to when the file is gone.
 */
export function useFileWrites(threadId: ThreadId, path: string) {
  const messages = useThreadFeed(threadId, (s) => s.messages);
  const writes = useMemo(() => writesTo(messages, path), [messages, path]);
  const working = useThreadsStore((s) => turnUnderWay(s.byId[threadId]?.status));
  return { ...writes, working };
}

/**
 * A file a thread's agent wrote, in a window over the app at reading width: from a worker in the
 * right pane, which has no room for a Preview tab, and popped out of the Preview tab. It reads the
 * file where the thread's folder is, this machine or the one it runs on, through the same reads
 * as the Files panel, so what that refuses (outside the thread's folders, a credential) stays
 * refused. It reads again after each write while the agent works, and when the file is no longer
 * there it shows what the agent last wrote.
 */
export function FileQuickLook({
  threadId,
  path,
  onClose,
  onOpenInTab,
}: {
  threadId: ThreadId;
  path: string;
  onClose: () => void;
  /** Shown as Open in tab: where the place it opened from has a Preview tab to move it to. */
  onOpenInTab?: (() => void) | undefined;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <OverlayBackdrop />
        <Dialog.Popup
          data-testid={FILE_QUICK_LOOK_TEST_ID}
          data-path={path}
          data-surface="overlay"
          aria-label={`Preview ${nameOf(path)}`}
          className="fixed top-1/2 left-1/2 z-50 flex h-[min(56rem,calc(100dvh-4rem))] w-[min(60rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-edge bg-popover text-popover-foreground shadow-overlay outline-none transition-[scale,opacity] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0 phone:inset-0 phone:h-dvh phone:w-full phone:translate-x-0 phone:translate-y-0 phone:rounded-none phone:border-0"
        >
          <QuickLookBody
            threadId={threadId}
            path={path}
            onClose={onClose}
            onOpenInTab={onOpenInTab}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function QuickLookBody({
  threadId,
  path,
  onClose,
  onOpenInTab,
}: {
  threadId: ThreadId;
  path: string;
  onClose: () => void;
  onOpenInTab: (() => void) | undefined;
}) {
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const mark = useMachineMark(threadHost(thread));
  const { count, content, working } = useFileWrites(threadId, path);
  const roots = useMemo(
    () =>
      thread === undefined
        ? []
        : [...checkoutRoots(thread), ...(thread.additionalDirectories ?? [])],
    [thread],
  );
  const root = markdownRoot(path, roots);
  const elsewhere = !roots.some((each) => path.startsWith(`${each.replace(/[\\/]+$/, "")}/`));
  const away = mark?.state !== undefined;

  const actions = (
    <>
      {mark?.name !== undefined && (
        <span
          data-testid="file-quick-look-machine"
          className="shrink-0 text-muted-foreground"
          title={mark.hint}
        >
          {away ? `${mark.name} · ${mark.state}` : mark.name}
        </span>
      )}
      {working && !away && (
        <span
          data-testid="file-quick-look-live"
          className="flex shrink-0 items-center gap-1 text-muted-foreground"
          title="Read again after each change the agent makes"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
          Following
        </span>
      )}
      {onOpenInTab !== undefined && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          data-testid="file-quick-look-open-tab"
          onClick={onOpenInTab}
        >
          <PanelRight aria-hidden />
          Open in tab
        </Button>
      )}
    </>
  );

  return (
    <FilePreview
      threadId={threadId}
      root={root}
      path={path}
      elsewhere={elsewhere}
      writes={count}
      written={content}
      actions={actions}
      onClose={onClose}
    />
  );
}
