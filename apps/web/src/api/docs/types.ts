import type { Doc, DocId, DocList, DocMeta, ThreadId, WorkspaceId } from "@gram/contracts";

/** `docs.*`: the workspace docs its threads publish (`publish_doc`), kept in Gram's own state. */
export interface DocsApi {
  /** The workspace's active docs, newest first, without their text, and how many are archived. */
  listDocs(workspaceId: WorkspaceId): Promise<DocList>;
  /** Its archived docs, the latest archived first (`docs.listArchived`). */
  listArchivedDocs(workspaceId: WorkspaceId): Promise<DocList>;
  /** Archives the doc as the user (`docs.archive`): it leaves the list for the Archived section. */
  archiveDoc(workspaceId: WorkspaceId, id: DocId): Promise<DocMeta>;
  /**
   * Restores an archived doc as the user (`docs.restore`). Rejects with `InvalidState`, saying
   * what to do, while the workspace's active docs are full or its PR has another active doc.
   */
  restoreDoc(workspaceId: WorkspaceId, id: DocId): Promise<DocMeta>;
  /** One doc with its Markdown; rejects with `NotFound` once it is gone. */
  readDoc(workspaceId: WorkspaceId, id: DocId): Promise<Doc>;
  /**
   * Saves the user's edit over `revision`, the one the pane opened. Rejects with `InvalidState`
   * when the doc moved on since, rather than overwriting the newer text.
   */
  saveDoc(workspaceId: WorkspaceId, id: DocId, content: string, revision: number): Promise<DocMeta>;
  /**
   * Puts the doc's chip above `threadId`'s composer away for good, on the server's thread record
   * (`thread.hideDoc`), so every client stops showing it and a later save doesn't bring it back.
   */
  hideDoc(threadId: ThreadId, id: DocId): Promise<void>;
  /** The pane opened the doc, which keeps it from automatic archiving for a while (`docs.opened`). */
  markDocOpened(workspaceId: WorkspaceId, id: DocId): Promise<void>;
  /**
   * Archives every workspace's docs the user neither saved nor opened in the last `days`
   * (`docs.archiveOlderThan`); resolves to how many went.
   */
  archiveDocsOlderThan(days: number): Promise<number>;
}
