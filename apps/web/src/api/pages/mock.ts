import {
  PAGE_TITLE_MAX,
  type PageId,
  type PageMeta,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";

import type { MockWorld } from "../mock-world";
import type { PagesApi } from "./types";

const fileTitle = (path: string) =>
  (path.split("#")[0]!.split("/").at(-1) ?? "page")
    .replace(/\.html?$/i, "")
    .slice(0, PAGE_TITLE_MAX);

/**
 * Pinned pages as the server keeps them, in memory. The user pins from the Preview tab through
 * `PagesApi`; an agent's offer is `simulateOfferPage`, as `offer_page_version` would make it.
 */
export function createPagesMock(world: MockWorld) {
  const pages = new Map<WorkspaceId, Map<PageId, PageMeta>>();
  const of = (workspaceId: WorkspaceId) => {
    let found = pages.get(workspaceId);
    if (found === undefined) {
      found = new Map();
      pages.set(workspaceId, found);
    }
    return found;
  };
  let pinned = 0;
  const find = (workspaceId: WorkspaceId, id: PageId) => {
    const page = of(workspaceId).get(id);
    if (page === undefined) throw new Error(`NotFound: The page ${id} isn't pinned`);
    return page;
  };

  const api: PagesApi = {
    listPages: async (workspaceId) => {
      await world.delay(20);
      return { pages: [...of(workspaceId).values()].toSorted((a, b) => b.pinnedAt - a.pinnedAt) };
    },
    pinPage: async (threadId, path) => {
      await world.delay(30);
      const { thread } = world.summary(threadId);
      const workspaceId = thread.workspaceId;
      if (workspaceId === undefined) {
        throw new Error("InvalidState: Pages belong to a workspace, and this thread isn't in one");
      }
      const title = fileTitle(path);
      const at = Date.now();
      const page: PageMeta = {
        id: `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "page"}-${(++pinned).toString(16).padStart(6, "0")}` as PageId,
        workspaceId,
        title,
        version: 1,
        entry: path.split("#")[0]!.split("/").at(-1) ?? "index.html",
        authorThreadId: threadId,
        authorTitle: thread.title,
        pinnedAt: at,
        updatedAt: at,
      };
      of(workspaceId).set(page.id, page);
      world.emit({ type: "pages.changed", workspaceId });
      return page;
    },
    openPage: async (workspaceId, id) => {
      await world.delay(10);
      const page = find(workspaceId, id);
      return {
        url: `http://127.0.0.1:9/gram-pages/mock-${page.id}-v${page.version}-token/${page.entry}`,
        version: page.version,
      };
    },
    showPageOffer: async (workspaceId, id, version) => {
      await world.delay(20);
      const page = find(workspaceId, id);
      if (page.offer?.version !== version) {
        throw new Error("InvalidState: That version isn't on offer any more");
      }
      const { offer, ...rest } = page;
      const shown: PageMeta = {
        ...rest,
        version: offer.version,
        entry: offer.entry,
        title: offer.title,
        updatedAt: Date.now(),
      };
      of(workspaceId).set(id, shown);
      world.emit({ type: "pages.changed", workspaceId });
      return shown;
    },
    unpinPage: async (workspaceId, id) => {
      await world.delay(20);
      find(workspaceId, id);
      of(workspaceId).delete(id);
      world.emit({ type: "pages.changed", workspaceId });
    },
  };

  /** An agent in `threadId` offers a new version of `id`, as `offer_page_version` would. */
  const simulateOfferPage = (threadId: ThreadId, id: PageId, title?: string): PageMeta => {
    const { thread } = world.summary(threadId);
    const workspaceId = thread.workspaceId;
    if (workspaceId === undefined) throw new Error("InvalidState: Pages belong to a workspace");
    const page = find(workspaceId, id);
    const version = Math.max(page.version, page.offer?.version ?? 0) + 1;
    const offered: PageMeta = {
      ...page,
      offer: {
        version,
        entry: page.entry,
        title: title ?? page.title,
        threadId,
        threadTitle: thread.title,
        at: Date.now(),
      },
    };
    of(workspaceId).set(id, offered);
    world.emit({ type: "pages.changed", workspaceId });
    return offered;
  };

  return { ...api, simulateOfferPage };
}
