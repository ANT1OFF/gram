// The user's WebRTC switch on a thread's Preview page (`DesktopPreview.setWebRtc`) gives WebRTC to
// whatever serves that address, and the thread's agent writes the app it serves. So the switch
// stays off while a turn is under way, and goes off as the agent starts one.

import type { DesktopPreview, ThreadStatus } from "@gram/contracts";

/** A turn is under way, waiting on the user or not: the agent may change what the page serves. */
export const turnUnderWay = (status: ThreadStatus | undefined): boolean =>
  status === "starting" ||
  status === "running" ||
  status === "needsApproval" ||
  status === "needsInput";

/** The shell's preview, or the mock API's stand-in for it. */
const previewBridge = (): DesktopPreview | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window.gram?.preview ?? window.gramMock?.shell.preview);

/** Ends the switch on `threadId`'s page when its agent starts a turn (`before` → `after`). */
export function endWebRtcAtTurn(
  threadId: string,
  before: ThreadStatus | undefined,
  after: ThreadStatus,
  bridge: DesktopPreview | undefined = previewBridge(),
): void {
  if (turnUnderWay(before) || !turnUnderWay(after)) return;
  void bridge?.setWebRtc?.(threadId, false);
}
