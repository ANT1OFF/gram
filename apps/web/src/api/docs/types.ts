import type { Doc, DocId, DocList, DocMeta, WorkspaceId } from "@gram/contracts";

/** `docs.*`: the workspace docs its threads publish (`publish_doc`), kept in Gram's own state. */
export interface DocsApi {
  /** The workspace's docs, newest first, without their text. */
  listDocs(workspaceId: WorkspaceId): Promise<DocList>;
  /** One doc with its Markdown; rejects with `NotFound` once it is gone. */
  readDoc(workspaceId: WorkspaceId, id: DocId): Promise<Doc>;
  /**
   * Saves the user's edit over `revision`, the one the pane opened. Rejects with `InvalidState`
   * when the doc moved on since, rather than overwriting the newer text.
   */
  saveDoc(workspaceId: WorkspaceId, id: DocId, content: string, revision: number): Promise<DocMeta>;
}
