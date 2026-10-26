import { AwayNotifications } from "@/desktop/away-notifications";
import { LinkQuestion } from "@/links/link-dialog";
import { FeatureSheet } from "@/orchestration/feature-sheet";
import { FreshSessionDialog } from "@/orchestration/fresh-session";
import { PeekSheet } from "@/orchestration/peek-sheet";
import { WorkersList } from "@/orchestration/workers-list";
import { CommandPalette } from "@/palette/command-palette";
import { ReportIssueDialog } from "@/report-issue/report-issue-dialog";
import { WorkspaceSheet } from "@/settings/workspace-sheet";
import { SessionExpiredScreen } from "@/shell/session-expired";
import { ShortcutOverlay } from "@/shell/shortcut-overlay";
import { ThreadSwitcher } from "@/shell/thread-switcher";
import { Toasts } from "@/shell/toasts";
import { ThreadDialogs } from "@/thread/thread-dialogs";
import { NeedsYouShortcut } from "@/views/view-frame";
import { WhatsNewDialog } from "@/whats-new/whats-new-dialog";

/**
 * What opens over the shell from anywhere: the palette, dialogs, sheets, toasts and the
 * session-expired screen, in the order they stack.
 */
export function AppOverlays() {
  return (
    <>
      <NeedsYouShortcut />
      <CommandPalette />
      <ThreadDialogs />
      <FreshSessionDialog />
      <ThreadSwitcher />
      <WorkersList />
      <WorkspaceSheet />
      <FeatureSheet />
      <PeekSheet />
      <WhatsNewDialog />
      <ReportIssueDialog />
      <ShortcutOverlay />
      <LinkQuestion />
      <Toasts />
      {typeof window !== "undefined" && window.gram?.onNotificationAction !== undefined && (
        <AwayNotifications />
      )}
      <SessionExpiredScreen />
    </>
  );
}
