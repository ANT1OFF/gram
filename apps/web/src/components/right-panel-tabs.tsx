import type { ThreadId, WorkspaceId } from "@gram/contracts";

import { TabsContent } from "@/components/ui/tabs";
import { DocsPanel } from "@/docs/docs-panel";
import { WorkersPanel } from "@/orchestration/workers-panel";
import { ConnectorsPanel } from "@/panels/connectors-panel";
import { DiffPanel } from "@/panels/diff-panel";
import { FilesPanel } from "@/panels/files/files-panel";
import { NotificationsPanel } from "@/panels/notifications-panel";
import { PanelMessage } from "@/panels/panel-message";
import { PrPanel } from "@/panels/pr-panel";
import { PreviewPane } from "@/panels/preview-pane";
import { TerminalPanel } from "@/panels/terminal/terminal-panel";
import { WorktreeBanner } from "@/panels/worktree-banner";
import { OpenPrsPanel } from "@/reviews/open-prs";
import { ReviewRequestsPanel } from "@/reviews/review-requests";

/** The right panel's tab contents, a chunk of their own that `RightPanel` loads lazily. */
export function RightPanelTabs({
  threadId,
  workspaceId,
  previewHere,
  reviewsHere,
  requestsHere,
  openPrsHere,
}: {
  threadId: ThreadId | undefined;
  /** The thread's workspace, whose workers the Workers tab lists. */
  workspaceId: WorkspaceId | undefined;
  previewHere: boolean;
  reviewsHere: boolean;
  requestsHere: boolean;
  openPrsHere: boolean;
}) {
  return (
    <>
      {workspaceId !== undefined && (
        <TabsContent value="workers" className="flex min-h-0 flex-col">
          <WorkersPanel key={workspaceId} workspaceId={workspaceId} />
        </TabsContent>
      )}
      <TabsContent value="diff" className="flex min-h-0 flex-col">
        {threadId && <WorktreeBanner threadId={threadId} />}
        {threadId ? <DiffPanel key={threadId} threadId={threadId} /> : <NoThread />}
      </TabsContent>
      <TabsContent value="pr" className="flex min-h-0 flex-col">
        {threadId ? <PrPanel key={threadId} threadId={threadId} /> : <NoThread />}
      </TabsContent>
      <TabsContent value="files" className="flex min-h-0 flex-col">
        {threadId && <WorktreeBanner threadId={threadId} />}
        {threadId ? <FilesPanel key={threadId} threadId={threadId} /> : <NoThread />}
      </TabsContent>
      <TabsContent value="terminal" className="flex min-h-0 flex-col">
        {threadId ? <TerminalPanel key={threadId} threadId={threadId} /> : <NoThread />}
      </TabsContent>
      {previewHere && (
        <TabsContent value="preview" className="flex min-h-0 flex-col">
          {threadId ? <PreviewPane key={threadId} threadId={threadId} /> : <NoThread />}
        </TabsContent>
      )}
      <TabsContent value="docs" className="flex min-h-0 flex-col">
        <DocsPanel key={workspaceId} workspaceId={workspaceId} />
      </TabsContent>
      <TabsContent value="connectors" className="flex min-h-0 flex-col">
        {threadId ? <ConnectorsPanel key={threadId} threadId={threadId} /> : <NoThread />}
      </TabsContent>
      {reviewsHere && (
        <TabsContent value="reviews" className="flex min-h-0 flex-col">
          {requestsHere && <ReviewRequestsPanel />}
          {openPrsHere && <OpenPrsPanel />}
        </TabsContent>
      )}
      <TabsContent value="notifications" className="flex min-h-0 flex-col">
        <NotificationsPanel />
      </TabsContent>
    </>
  );
}

function NoThread() {
  return <PanelMessage>Open a thread to see its changes.</PanelMessage>;
}
