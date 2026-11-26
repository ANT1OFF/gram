// @vitest-environment happy-dom
import type { Doc, DocId, DocMeta, ThreadId, WorkspaceId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { servedAllBut } from "@/api/served";
import type { Api } from "@/api/types";
import { loadMarkdown } from "@/components/ai-elements/markdown-loader";
import { renderWithApi } from "@/panels/test-utils";

import { useDocPane } from "./doc-pane-store";
import { DocsPanel } from "./docs-panel";

const WS = "ws-docs" as WorkspaceId;
const NOW = Date.UTC(2026, 10, 26, 14, 30);
const MINUTE = 60_000;

const meta = (n: number, patch: Partial<DocMeta> = {}): DocMeta => ({
  id: `doc-${n}` as DocId,
  workspaceId: WS,
  title: `Doc ${n}`,
  authorThreadId: "t-worker" as ThreadId,
  authorTitle: "cp-artifacts",
  createdAt: NOW - n * 10 * MINUTE,
  updatedAt: NOW - n * 10 * MINUTE,
  updatedBy: "agent",
  revision: 1,
  bytes: 10,
  excerpt: `Opening words of doc ${n}.`,
  ...patch,
});

const archivedMeta = (n: number, patch: Partial<DocMeta> = {}) =>
  meta(n, { archivedAt: NOW - n * MINUTE, archivedReason: "pr-merged", ...patch });

/** A fake docs API over an active and an archived set, which archive and restore move between. */
const docsApi = (active: DocMeta[], archived: DocMeta[]) => {
  const state = { active: [...active], archived: [...archived] };
  const archiveDoc = vi.fn<Api["archiveDoc"]>(async (_ws, id) => {
    const doc = state.active.find((each) => each.id === id)!;
    return { ...doc, archivedAt: NOW, archivedReason: "manual" };
  });
  const restoreDoc = vi.fn<Api["restoreDoc"]>(async (_ws, id) => {
    const {
      archivedAt: _at,
      archivedReason: _reason,
      ...doc
    } = state.archived.find((each) => each.id === id)!;
    return doc;
  });
  const api: Partial<Api> = {
    listDocs: vi.fn(async () => ({ docs: state.active, archived: state.archived.length })),
    listArchivedDocs: vi.fn(async () => ({ docs: state.archived })),
    readDoc: vi.fn(async (_ws, id): Promise<Doc> => ({
      ...[...state.active, ...state.archived].find((each) => each.id === id)!,
      content: "Body.",
    })),
    markDocOpened: vi.fn(async () => undefined),
    archiveDoc,
    restoreDoc,
  };
  return { api, archiveDoc, restoreDoc };
};

const rowTitles = () =>
  screen.queryAllByTestId("doc-row").map((row) => row.getAttribute("data-doc-id"));

beforeAll(async () => {
  await loadMarkdown();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  useDocPane.setState({ open: {} });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the Docs tab's search, Archive and Restore", () => {
  it("narrows the list to docs whose title has every word searched for", async () => {
    const { api } = docsApi(
      [meta(1, { title: "Security review of #42" }), meta(2, { title: "Storage plan" })],
      [],
    );
    renderWithApi(<DocsPanel workspaceId={WS} />, api);
    await screen.findAllByTestId("doc-row");
    fireEvent.change(screen.getByTestId("docs-search"), { target: { value: "REVIEW 42" } });
    expect(rowTitles()).toEqual(["doc-1"]);
    fireEvent.change(screen.getByTestId("docs-search"), { target: { value: "nothing like it" } });
    expect(rowTitles()).toEqual([]);
  });

  it("archives a doc from its row", async () => {
    const { api, archiveDoc } = docsApi([meta(1)], []);
    renderWithApi(<DocsPanel workspaceId={WS} />, api);
    await act(async () => fireEvent.click(await screen.findByTestId("doc-archive")));
    expect(archiveDoc).toHaveBeenCalledWith(WS, "doc-1");
  });

  it("folds the archived docs under Archived, searched too, and restores one from its row", async () => {
    const { api, restoreDoc } = docsApi(
      [meta(1)],
      [archivedMeta(2, { title: "Old review" }), archivedMeta(3, { title: "Old plan" })],
    );
    renderWithApi(<DocsPanel workspaceId={WS} />, api);
    const toggle = await screen.findByTestId("docs-archived-toggle");
    expect(toggle.textContent).toContain("2");
    // Folded: nothing archived is listed or read until it is opened.
    expect(rowTitles()).toEqual(["doc-1"]);
    expect(api.listArchivedDocs).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() => expect(rowTitles()).toEqual(["doc-1", "doc-2", "doc-3"]));
    fireEvent.change(screen.getByTestId("docs-search"), { target: { value: "plan" } });
    expect(rowTitles()).toEqual(["doc-3"]);
    await act(async () => fireEvent.click(screen.getByTestId("doc-restore")));
    expect(restoreDoc).toHaveBeenCalledWith(WS, "doc-3");
  });

  it("says why a restore was refused, in the server's words, which name the fix", async () => {
    const { api, restoreDoc } = docsApi([meta(1)], [archivedMeta(2)]);
    restoreDoc.mockRejectedValueOnce(
      new Error("InvalidState: This workspace already has 200 active docs. Archive one first."),
    );
    renderWithApi(<DocsPanel workspaceId={WS} />, api);
    fireEvent.click(await screen.findByTestId("docs-archived-toggle"));
    await act(async () => fireEvent.click(await screen.findByTestId("doc-restore")));
    expect((await screen.findByTestId("docs-action-error")).textContent).toContain(
      "Archive one first",
    );
  });

  it("keeps the list when every doc is archived, with the Archived section to reach them", async () => {
    const { api } = docsApi([], [archivedMeta(2)]);
    renderWithApi(<DocsPanel workspaceId={WS} />, api);
    expect(await screen.findByTestId("docs-archived-toggle")).toBeTruthy();
    expect(screen.queryByTestId("docs-empty")).toBeNull();
  });

  it("opens an archived doc read-only, with Restore in place of Edit", async () => {
    const { api, restoreDoc } = docsApi([], [archivedMeta(2)]);
    useDocPane.setState({ open: { [WS]: "doc-2" as DocId } });
    renderWithApi(<DocsPanel workspaceId={WS} />, api);
    await act(async () => fireEvent.click(await screen.findByTestId("doc-view-restore")));
    expect(restoreDoc).toHaveBeenCalledWith(WS, "doc-2");
    expect(screen.getByTestId<HTMLButtonElement>("doc-edit").hidden).toBe(true);
    expect(screen.getByTestId("doc-meta").textContent).toMatch(/archived \d{2}:\d{2}/);
  });

  it("offers neither Archive, Restore nor the Archived section on a server older than them", async () => {
    const { api } = docsApi([meta(1)], [archivedMeta(2)]);
    renderWithApi(<DocsPanel workspaceId={WS} />, {
      ...api,
      served: servedAllBut(["docs.archive", "docs.listArchived", "docs.restore"]),
    });
    await screen.findAllByTestId("doc-row");
    expect(screen.queryByTestId("doc-archive")).toBeNull();
    expect(screen.queryByTestId("docs-archived")).toBeNull();
  });
});
