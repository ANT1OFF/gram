import { useLocation } from "@tanstack/react-router";
import { useEffect, useId, useRef } from "react";

import { lazyPart } from "@/lib/lazy-part";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { Dialog, OverlayBackdrop, OverlayContent, SHEET_POPUP } from "@/thread/dialog-shell";

import { useFeatureSheet } from "./feature-sheet-store";

const featureSheetBody = lazyPart(() => import("./feature-sheet"));

const FEATURE_SHEET_TEST_ID = "feature-sheet";

/** The feature sheet, mounted once. Esc, the close button or going anywhere else closes it. */
export function FeatureSheet() {
  const requested = useFeatureSheet((s) => s.open);
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
        <OverlayBackdrop />
        <Dialog.Popup
          data-testid={FEATURE_SHEET_TEST_ID}
          data-surface="overlay"
          data-feature={target?.feature}
          aria-labelledby={titleId}
          finalFocus={() =>
            useFeatureSheet.getState().returnFocus ? returnFocusTo(opener)() : false
          }
          className={SHEET_POPUP}
        >
          <OverlayContent>
            {target !== undefined && body !== undefined && (
              <body.SheetBody
                workspaceId={target.workspaceId}
                feature={target.feature}
                titleId={titleId}
              />
            )}
          </OverlayContent>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

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
