import type { ThreadId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { useShortcut } from "@/keyboard/registry";
import { lazyPart } from "@/lib/lazy-part";
import { ScriptShortcuts } from "@/scripts/script-shortcuts";
import { focusPaneComposer } from "@/shell/pane-focus";
import { useLayoutStore } from "@/stores/layout";

import { Dialog, DialogShell } from "./dialog-shell";
import { useThreadDialogs } from "./thread-dialogs-store";

/** The dialogs themselves: rename, close, fork, worktrees, scripts and the rest. */
export const threadDialogBodies = lazyPart(() => import("./thread-dialog-bodies"));

const focusedThread = (): ThreadId | undefined => {
  const { grid } = useLayoutStore.getState();
  return grid.panes[grid.focused] ?? undefined;
};

/**
 * Mount once: the thread-action dialogs, and the shortcuts that act on the focused pane's thread.
 * ⌘W closes the pane (the thread keeps running); ⌥⌘W asks to close the thread itself.
 */
export function ThreadDialogs() {
  const navigate = useNavigate();
  const dialog = useThreadDialogs((s) => s.dialog);
  const error = useThreadDialogs((s) => s.error);
  const open = useThreadDialogs((s) => s.open);
  const dismiss = useThreadDialogs((s) => s.dismiss);
  const clearError = useThreadDialogs((s) => s.clearError);
  // A dialog asked for before its code is in hand opens once it is.
  const bodies = threadDialogBodies.useModule(dialog !== undefined);

  useShortcut({
    id: "thread.close",
    keys: "mod+alt+w",
    label: "Close thread…",
    group: "Thread",
    when: () => focusedThread() !== undefined,
    run: () => {
      const threadId = focusedThread();
      if (threadId) open({ kind: "close", threadId });
    },
  });

  useShortcut({
    id: "thread.rename",
    keys: "f2",
    label: "Rename thread…",
    group: "Thread",
    // F2 types nothing, so it works from the composer too.
    allowInInputs: true,
    when: () => focusedThread() !== undefined,
    run: () => {
      const threadId = focusedThread();
      if (threadId) open({ kind: "rename", threadId });
    },
  });

  // The desktop menu owns ⌘W there; this documents it and gives the browser the same behaviour.
  useShortcut({
    id: "pane.close",
    keys: "mod+w",
    label: "Close pane (the thread keeps running)",
    group: "Navigation",
    when: () => !window.gram,
    run: () => {
      const { grid, closePane } = useLayoutStore.getState();
      const othersShown = grid.panes.some((id, index) => id !== null && index !== grid.focused);
      if (othersShown) {
        closePane(grid.focused);
        focusPaneComposer(useLayoutStore.getState().grid.focused, { always: true });
      } else void navigate({ to: "/" });
    },
  });

  return (
    <>
      {dialog !== undefined && bodies !== undefined && (
        <bodies.ThreadDialogBody dialog={dialog} dismiss={dismiss} />
      )}
      <ScriptShortcuts />
      {error !== undefined && (
        <DialogShell testId="thread-action-error" title="That didn't work" onClose={clearError}>
          <p role="alert" className="text-reading">
            {error}
          </p>
          <div className="flex justify-end">
            <Dialog.Close render={<Button type="button" size="sm" />}>OK</Dialog.Close>
          </div>
        </DialogShell>
      )}
    </>
  );
}
