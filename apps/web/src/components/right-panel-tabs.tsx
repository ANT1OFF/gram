import type { ThreadId, WorkspaceId } from "@gram/contracts";

import { TabsContent } from "@/components/ui/tabs";
import { DocsPanel } from "@/docs/docs-panel";
import { PagesPanel } from "@/pages/pages-panel";
import { WorkerPane } from "@/orchestration/worker-pane";
import { WorkersPanel, type OrchestratorView } from "@/orchestration/workers-panel";
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
import { CommandPanel } from "@/thread/command-panel";
import type { OpenCommand } from "@/thread/command-view-model";
import { ReviewRequestsPanel } from "@/reviews/review-requests";

/**
 * The pane's Workers mode: an orchestrator's workers, or one of them open (`worker`), in place of
 * the tabs. In the same lazy chunk as the tabs' contents.
 */
export function WorkersMode({
  workspaceId,
  worker,
  record,
  orchestrator,
}: {
  workspaceId: WorkspaceId;
  worker: ThreadId | undefined;
  record: boolean;
  orchestrator:
    | { readonly views: readonly OrchestratorView[]; readonly onPick: (value: string) => void }
    | undefined;
}) {
  if (worker !== undefined) {
    return <WorkerPane workspaceId={workspaceId} worker={worker} record={record} />;
  }
  return (
    <WorkersPanel
      key={workspaceId}
      workspaceId={workspaceId}
      orchestrator={orchestrator}
      closable
    />
  );
}

/** The right panel's tab contents, a chunk of their own that `RightPanel` loads lazily. */
export function RightPanelTabs({
  threadId,
  workspaceId,
  besideWorker,
  besideRecord,
  command,
  previewHere,
  reviewsHere,
  requestsHere,
  openPrsHere,
}: {
  threadId: ThreadId | undefined;
  /** The thread's workspace, whose workers the Workers tab lists. */
  workspaceId: WorkspaceId | undefined;
  /** The worker open beside the chat, which the Thread tab shows. */
  besideWorker: ThreadId | undefined;
  /** It is a finished worker's record. */
  besideRecord: boolean;
  /** The command opened from the strip above the composer, which the Command tab shows. */
  command: OpenCommand | undefined;
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
      {besideWorker !== undefined && workspaceId !== undefined && (
        <TabsContent value="thread" className="flex min-h-0 flex-col">
          <WorkerPane workspaceId={workspaceId} worker={besideWorker} record={besideRecord} />
        </TabsContent>
      )}
      {command !== undefined && (
        <TabsContent value="command" className="flex min-h-0 flex-col">
          <CommandPanel
            key={`${command.threadId}:${command.taskId ?? command.toolCallId}`}
            open={command}
          />
        </TabsContent>
      )}
      <TabsContent value="diff" className="flex min-h-0 flex-col">
        {threadId && <WorktreeBanner threadId={threadId} />}
        {threadId ? <DiffPanel key={threadId} threadId={threadId} prLink /> : <NoThread />}
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
      <TabsContent value="pages" className="flex min-h-0 flex-col">
        <PagesPanel key={workspaceId} workspaceId={workspaceId} />
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
