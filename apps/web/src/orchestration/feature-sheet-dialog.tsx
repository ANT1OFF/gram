import { useLocation } from "@tanstack/react-router";
import { useEffect, useId, useRef } from "react";

import { lazyPart } from "@/lib/lazy-part";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { Dialog } from "@/thread/dialog-shell";

import { useFeatureSheet } from "./feature-sheet-store";

/** The sheet's stations, PRs and workers, with the feature's menu and dialogs. */
const featureSheetBody = lazyPart(() => import("./feature-sheet"));

const FEATURE_SHEET_TEST_ID = "feature-sheet";

/** The feature sheet, mounted once. Esc, the close button or going anywhere else closes it. */
export function FeatureSheet() {
  const requested = useFeatureSheet((s) => s.open);
  // Opens once its body is in hand, which the shell preloads after first paint.
  const body = featureSheetBody.useModule(requested);
  const open = requested && body !== undefined;
  const target = useFeatureSheet((s) => s.target);
  const close = useFeatureSheet((s) => s.close);
  const opener = useOpener(open);
  const titleId = useId();
  useCloseOnNavigate(open, close);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid={FEATURE_SHEET_TEST_ID}
          data-surface="overlay"
          data-feature={target?.feature}
          aria-labelledby={titleId}
          // Asking about it or opening a worker moves focus on purpose.
          finalFocus={() =>
            useFeatureSheet.getState().returnFocus ? returnFocusTo(opener)() : false
          }
          className="fixed inset-y-2 end-2 z-50 flex w-[min(28rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-edge bg-popover text-popover-foreground shadow-overlay outline-none transition-[translate,opacity] duration-(--dur-move-base) ease-(--ease-out) data-[ending-style]:translate-x-6 data-[ending-style]:opacity-0 data-[starting-style]:translate-x-6 data-[starting-style]:opacity-0"
        >
          {target !== undefined && body !== undefined && (
            <body.SheetBody
              workspaceId={target.workspaceId}
              feature={target.feature}
              titleId={titleId}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Closes the sheet when the route changes under it. */
function useCloseOnNavigate(open: boolean, close: () => void) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const openedAt = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!open) {
      openedAt.current = undefined;
      return;
    }
    if (openedAt.current === undefined) openedAt.current = pathname;
    else if (openedAt.current !== pathname) close();
  }, [open, pathname, close]);
}
