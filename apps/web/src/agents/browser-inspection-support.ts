import type {
  BrowserInspectionCapabilities,
  DesktopPreview,
  PreviewState,
  ThreadId,
} from "@gram/contracts";
import { useEffect, useState } from "react";

/** Shell evidence is separate from the selected provider's tool support. */
export type PreviewInspectionSupport =
  | { readonly state: "available"; readonly capabilities: BrowserInspectionCapabilities }
  | { readonly state: "unavailable" | "unknown" | "checking"; readonly reason: string };

function previewInspectionSupport(state: PreviewState | null): PreviewInspectionSupport {
  const capabilities = state?.browserInspection?.capabilities;
  return capabilities === undefined
    ? {
        state: "unavailable",
        reason:
          "The attached preview has not reported inspection support. Open Preview in the current desktop shell.",
      }
    : { state: "available", capabilities };
}

/** Reads existing shell state only: never attaches a driver, opens a page or gathers a screenshot. */
export function usePreviewInspectionSupport(
  threadId: ThreadId | undefined,
  bridge: DesktopPreview | undefined,
) {
  const [attempt, setAttempt] = useState(0);
  const [observed, setObserved] = useState<{
    readonly threadId: ThreadId;
    readonly bridge: DesktopPreview;
    readonly attempt: number;
    readonly support: PreviewInspectionSupport;
  }>();
  useEffect(() => {
    if (threadId === undefined || bridge === undefined) return;
    let live = true;
    let updated = false;
    const note = (support: PreviewInspectionSupport) => {
      if (live) setObserved({ threadId, bridge, attempt, support });
    };
    const failed = () =>
      note({
        state: "unknown",
        reason: "Could not read attached preview support. Retry this check.",
      });
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = bridge.onState(threadId, (state) => {
        updated = true;
        note(previewInspectionSupport(state));
      });
      void bridge.state(threadId).then(
        (state) => {
          if (!updated) note(previewInspectionSupport(state));
        },
        () => {
          if (!updated) failed();
        },
      );
    } catch {
      failed();
    }
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [threadId, bridge, attempt]);

  const support: PreviewInspectionSupport =
    threadId === undefined || bridge === undefined
      ? {
          state: "unavailable",
          reason: "Preview inspection needs an attached page in a desktop thread.",
        }
      : observed?.threadId === threadId &&
          observed.bridge === bridge &&
          observed.attempt === attempt
        ? observed.support
        : { state: "checking", reason: "Checking attached preview support…" };
  return { support, retry: () => setAttempt((value) => value + 1) };
}
