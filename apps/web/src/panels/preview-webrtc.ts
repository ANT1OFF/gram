// The user's WebRTC switch on a thread's Preview page (`DesktopPreview.setWebRtc`) gives WebRTC to
// whatever serves that address, and any agent working in the thread's folder may write the app it
// serves: the thread's own, another thread's or a worker's on the same folder. So the switch stays
// off while a turn is under way in any thread whose folders overlap the page's thread's, and goes
// off whenever the app hears of one, by an event or a reconnect's snapshot alike. Turning it off is
// a no-op where it is off already, so it is asked on every such status, not only at a turn's start.
// A process an agent left running (a watcher, a dev server) starts no turn, and isn't seen.

import {
  checkoutRoots,
  type DesktopPreview,
  type Thread,
  type ThreadStatus,
  type ThreadSummary,
} from "@gram/contracts";

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

type Folders = Pick<
  Thread,
  "checkout" | "currentCheckout" | "extraCheckouts" | "additionalDirectories"
>;

const foldersOf = (thread: Folders) => [
  ...checkoutRoots(thread),
  ...(thread.additionalDirectories ?? []),
];

/** `path` is `root` or inside it. */
const within = (path: string, root: string) => {
  const base = root.replace(/[\\/]+$/, "");
  if (base === "") return false;
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
};

/** Whether an agent working in `a`'s folders may write what `b`'s folders serve, or the reverse. */
export const sharesFolder = (a: Folders, b: Folders): boolean => {
  const left = foldersOf(a);
  const right = foldersOf(b);
  return left.some((x) => right.some((y) => within(x, y) || within(y, x)));
};

/** Whether a turn is under way in a thread sharing `threadId`'s folders, its own included. */
export const folderBusy = (
  byId: Readonly<Record<string, ThreadSummary>>,
  threadId: string,
): boolean => {
  const page = byId[threadId];
  if (page === undefined) return false;
  return Object.values(byId).some(
    (other) =>
      turnUnderWay(other.status) &&
      (other.thread.id === threadId || sharesFolder(other.thread, page.thread)),
  );
};

/**
 * Ends the switch on the page of every thread sharing a folder with a thread whose turn is under
 * way: `working`, from a status event, or every thread of `byId`, after a snapshot.
 */
export function endWebRtcWhereAgentsWork(
  byId: Readonly<Record<string, ThreadSummary>>,
  working: ReadonlyArray<string> = Object.keys(byId),
  bridge: DesktopPreview | undefined = previewBridge(),
): void {
  if (bridge?.setWebRtc === undefined) return;
  const busy = working.flatMap((id) => {
    const summary = byId[id];
    return summary !== undefined && turnUnderWay(summary.status) ? [summary.thread] : [];
  });
  if (busy.length === 0) return;
  for (const summary of Object.values(byId))
    if (
      busy.some((thread) => thread.id === summary.thread.id || sharesFolder(thread, summary.thread))
    )
      void bridge.setWebRtc(summary.thread.id, false);
}
