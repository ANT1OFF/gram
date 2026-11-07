import {
  docExcerpt,
  docTitle,
  type Doc,
  type DocId,
  type ThreadId,
  type WorkspaceId,
} from "@gram/contracts";

import type { MockWorld } from "../mock-world";
import type { DocsApi } from "./types";

/** What an agent's `publish_doc` call says, as `simulatePublishDoc` takes it. */
export interface MockPublishDoc {
  readonly title?: string;
  readonly content: string;
  /** An existing doc to update; absent for a new one. */
  readonly id?: DocId;
}

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "") || "doc";

const metaOf = ({ content: _content, ...meta }: Doc) => meta;

/**
 * The workspace docs as the server keeps them, in memory: specs publish with `simulatePublishDoc`,
 * as a thread's `publish_doc` would, which leaves its card in the thread and its orchestrator's
 * chat and tells the clients, and the doc pane reads and saves through `DocsApi`.
 */
export function createDocsMock(world: MockWorld) {
  const docs = new Map<WorkspaceId, Map<DocId, Doc>>();
  const of = (workspaceId: WorkspaceId) => {
    let found = docs.get(workspaceId);
    if (found === undefined) {
      found = new Map();
      docs.set(workspaceId, found);
    }
    return found;
  };
  let published = 0;

  const api: DocsApi = {
    listDocs: async (workspaceId) => {
      await world.delay(20);
      const list = [...of(workspaceId).values()]
        .map(metaOf)
        .toSorted((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      return { docs: list };
    },
    readDoc: async (workspaceId, id) => {
      await world.delay(20);
      const doc = of(workspaceId).get(id);
      if (doc === undefined) throw new Error(`NotFound: No doc ${id} in this workspace`);
      return doc;
    },
    saveDoc: async (workspaceId, id, content, revision) => {
      await world.delay(30);
      const doc = of(workspaceId).get(id);
      if (doc === undefined) throw new Error(`NotFound: No doc ${id} in this workspace`);
      if (doc.revision !== revision) {
        throw new Error(
          `InvalidState: ${doc.title} changed since you opened it (now revision ${doc.revision}). ` +
            "Copy your edit, reload the doc and apply it again.",
        );
      }
      const saved: Doc = {
        ...doc,
        content,
        updatedAt: Math.max(Date.now(), doc.updatedAt),
        updatedBy: "user",
        revision: doc.revision + 1,
        bytes: new TextEncoder().encode(content).length,
        excerpt: docExcerpt(content),
      };
      of(workspaceId).set(id, saved);
      world.emit({ type: "docs.changed", workspaceId });
      return metaOf(saved);
    },
  };

  /** Publishes or updates a doc as `threadId`'s `publish_doc` would; answers the doc. */
  const simulatePublishDoc = (threadId: ThreadId, input: MockPublishDoc, at = Date.now()): Doc => {
    const { thread } = world.summary(threadId);
    const workspaceId = thread.workspaceId;
    if (workspaceId === undefined) throw new Error("InvalidState: Docs belong to a workspace");
    const existing = input.id === undefined ? undefined : of(workspaceId).get(input.id);
    if (input.id !== undefined && existing === undefined) {
      throw new Error(`InvalidState: No doc ${input.id} in this workspace`);
    }
    const bytes = new TextEncoder().encode(input.content).length;
    const doc: Doc =
      existing === undefined
        ? {
            id: `${slug(input.title ?? "")}-${(++published).toString(16).padStart(6, "0")}` as DocId,
            workspaceId,
            title: docTitle(input.title ?? "Untitled"),
            authorThreadId: threadId,
            authorTitle: thread.title,
            createdAt: at,
            updatedAt: at,
            updatedBy: "agent",
            revision: 1,
            bytes,
            excerpt: docExcerpt(input.content),
            content: input.content,
          }
        : {
            ...existing,
            title: input.title === undefined ? existing.title : docTitle(input.title),
            updatedAt: Math.max(at, existing.updatedAt),
            updatedBy: "agent",
            revision: existing.revision + 1,
            bytes,
            excerpt: docExcerpt(input.content),
            content: input.content,
          };
    of(workspaceId).set(doc.id, doc);
    const part = {
      type: "data-doc" as const,
      id: `doc:${doc.id}:${doc.revision}`,
      data: {
        id: doc.id,
        workspaceId,
        title: doc.title,
        authorThreadId: doc.authorThreadId,
        authorTitle: doc.authorTitle,
        action: existing === undefined ? ("published" as const) : ("updated" as const),
        revision: doc.revision,
        at: doc.updatedAt,
        excerpt: doc.excerpt,
      },
    };
    world.putDataPart(threadId, part);
    const orchestrator = thread.role === "orchestrator" ? undefined : thread.spawnedBy?.threadId;
    if (orchestrator !== undefined && world.threads().some((t) => t.thread.id === orchestrator)) {
      world.putDataPart(orchestrator, part);
    }
    world.emit({ type: "docs.changed", workspaceId });
    return doc;
  };

  return { ...api, simulatePublishDoc };
}
