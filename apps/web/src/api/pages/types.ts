import type {
  PageId,
  PageList,
  PageMeta,
  PageOpened,
  ThreadId,
  WorkspaceId,
} from "@gram/contracts";

/** `pages.*`: pinned pages, which only the user pins, shows a newer version of, or unpins. */
export interface PagesApi {
  /** The workspace's pinned pages, newest pin first. */
  listPages(workspaceId: WorkspaceId): Promise<PageList>;
  /** Pins the HTML file `threadId`'s Preview tab shows, as a copy in Gram's own state. */
  pinPage(threadId: ThreadId, path: string): Promise<PageMeta>;
  /** The shown version's address, for the shell's pinned pages session only. */
  openPage(workspaceId: WorkspaceId, id: PageId): Promise<PageOpened>;
  /** Shows the version an agent offered; rejects once another offer replaced it. */
  showPageOffer(workspaceId: WorkspaceId, id: PageId, version: number): Promise<PageMeta>;
  unpinPage(workspaceId: WorkspaceId, id: PageId): Promise<void>;
}
