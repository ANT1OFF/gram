import { effectiveCheckout, type ThreadId } from "@gram/contracts";

import {
  useOpenInEditor,
  useOpensLocally,
  useRevealInFileManager,
} from "@/editor/use-open-in-editor";
import { useThreadsStore } from "@/stores/threads";

import { revealInFiles } from "./files/files-store";

/**
 * The thread's effective checkout and the "Show in Files", "Open in editor" and "Reveal" handlers for
 * `DiffFileList` rows. `actions` is empty until the thread is known, and has only "Show in Files"
 * in managed mode.
 */
export function useDiffFileActions(threadId: ThreadId) {
  const thread = useThreadsStore((s) => s.byId[threadId]?.thread);
  const openInEditor = useOpenInEditor();
  const revealInFileManager = useRevealInFileManager();
  const local = useOpensLocally();
  const root = thread === undefined ? undefined : effectiveCheckout(thread).path;
  const actions =
    root === undefined
      ? {}
      : {
          onReveal: (path: string) => revealInFiles(threadId, root, `${root}/${path}`),
          ...(local
            ? {
                onOpenInEditor: (path: string) => void openInEditor(path, { threadId }),
                onRevealInFileManager: (path: string) =>
                  void revealInFileManager(`${root}/${path}`, { threadId }),
              }
            : {}),
        };
  return { root, actions };
}
