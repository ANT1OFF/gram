// @vitest-environment happy-dom
import type {
  Doc,
  DocCardData,
  DocId,
  DocMeta,
  ThreadId,
  ThreadSummary,
  WorkspaceId,
} from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Api } from "@/api/types";
import { loadMarkdown } from "@/components/ai-elements/markdown-loader";
import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { DocCard } from "./doc-card";
import { PinnedDocChip, pinnedDocOf } from "./doc-chip";
import { useDocPane } from "./doc-pane-store";
import { DocsPanel } from "./docs-panel";
import { DocsStrip } from "./docs-strip";
import { withoutRepeatedTitle } from "./doc-view";
import { WorkersDocs } from "@/orchestration/workers-docs";

const WS = "ws-docs" as WorkspaceId;
const WORKER = "t-worker" as ThreadId;
const OTHER = "t-other" as ThreadId;
const SOLO = "t-solo" as ThreadId;
const NOW = Date.UTC(2026, 10, 5, 14, 30);
const MINUTE = 60_000;

const meta = (n: number, patch: Partial<DocMeta> = {}): DocMeta => ({
  id: `doc-${n}` as DocId,
  workspaceId: WS,
  title: `Doc ${n}`,
  authorThreadId: WORKER,
  authorTitle: "cp-artifacts",
  createdAt: NOW - n * 10 * MINUTE,
  updatedAt: NOW - n * 10 * MINUTE,
  updatedBy: "agent",
  revision: 1,
  bytes: 10,
  excerpt: `Opening words of doc ${n}.`,
  ...patch,
});

const REPORT = `# Gap analysis

What Gram lacks.

| Feature | State |
| --- | --- |
| Docs | New |

\`\`\`ts
const x = 1;
\`\`\`
`;

const docsApi = (docs: DocMeta[], content = REPORT) => {
  const saveDoc = vi.fn<Api["saveDoc"]>(async (_ws, id, text, revision) => ({
    ...docs.find((d) => d.id === id)!,
    revision: revision + 1,
    updatedBy: "user" as const,
    bytes: text.length,
  }));
  const api: Partial<Api> = {
    listDocs: vi.fn(async () => ({ docs })),
    readDoc: vi.fn(async (_ws, id): Promise<Doc> => ({
      ...docs.find((d) => d.id === id)!,
      content,
    })),
    saveDoc,
  };
  return { api, saveDoc };
};

const summary = (id: ThreadId, workspaceId: WorkspaceId | undefined): ThreadSummary =>
  ({
    thread: { id, title: id, ...(workspaceId === undefined ? {} : { workspaceId }) },
  }) as unknown as ThreadSummary;

const { revealPanel } = useLayoutStore.getState();
let revealed: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await loadMarkdown();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  revealed = vi.fn();
  useLayoutStore.setState({ revealPanel: revealed as never });
  useDocPane.setState({ open: {} });
  useThreadsStore.setState({
    byId: {
      [WORKER]: summary(WORKER, WS),
      [OTHER]: summary(OTHER, WS),
      [SOLO]: summary(SOLO, undefined),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useLayoutStore.setState({ revealPanel });
  useThreadsStore.setState({ byId: {} });
});

describe("DocCard", () => {
  const card: DocCardData = {
    id: "gap-analysis-3f9a2c" as DocId,
    workspaceId: WS,
    title: "Harness features for gram: gap analysis",
    authorThreadId: WORKER,
    authorTitle: "cp-artifacts",
    action: "published",
    revision: 1,
    at: NOW - 2 * MINUTE,
    excerpt: "What Gram lacks.",
  };

  it("says who published it and when, and opens it in the Docs tab", () => {
    renderWithApi(<DocCard card={card} />, {});
    const shown = screen.getByTestId("doc-card");
    expect(shown.textContent).toContain("Harness features for gram: gap analysis");
    expect(shown.textContent).toContain("Published by cp-artifacts · 2m ago");
    expect(shown.textContent).toContain("What Gram lacks.");
    expect(
      within(shown)
        .getByText(/Published by/)
        .getAttribute("title"),
    ).toMatch(/^Published \d{2}:\d{2}$/);
    fireEvent.click(screen.getByRole("button", { name: `Open ${card.title}` }));
    expect(useDocPane.getState().open[WS]).toBe(card.id);
    expect(revealed).toHaveBeenCalledWith("docs");
  });

  it("says Updated for an update", () => {
    renderWithApi(<DocCard card={{ ...card, action: "updated", revision: 2 }} />, {});
    expect(screen.getByTestId("doc-card").textContent).toContain("Updated by cp-artifacts");
  });
});

describe("DocsStrip", () => {
  it("shows the latest docs and View all opens the whole list", async () => {
    const { api } = docsApi([1, 2, 3, 4].map((n) => meta(n)));
    useDocPane.setState({ open: { [WS]: "doc-2" as DocId } });
    renderWithApi(<DocsStrip workspaceId={WS} />, api);
    await screen.findByTestId("docs-strip");
    expect(screen.getAllByTestId("doc-row").map((row) => row.dataset["docId"])).toEqual([
      "doc-1",
      "doc-2",
      "doc-3",
    ]);
    fireEvent.click(screen.getByTestId("docs-view-all"));
    expect(screen.getByTestId("docs-view-all").textContent).toBe("View all 4");
    expect(useDocPane.getState().open[WS]).toBeUndefined();
    expect(revealed).toHaveBeenCalledWith("docs");
  });

  it("renders nothing for a workspace without docs, unless asked to say so", async () => {
    const { api } = docsApi([]);
    const { unmount } = renderWithApi(<DocsStrip workspaceId={WS} />, api);
    await waitFor(() => expect(api.listDocs).toHaveBeenCalled());
    expect(screen.queryByTestId("docs-strip")).toBeNull();
    unmount();
    renderWithApi(<DocsStrip workspaceId={WS} empty />, api);
    expect((await screen.findByTestId("docs-strip")).textContent).toContain("No docs yet");
  });
});

describe("DocsPanel", () => {
  it("lists the workspace's docs and opens one, rendered with its 24-hour times", async () => {
    const { api } = docsApi([
      meta(1, { title: "Gap analysis", updatedAt: NOW - 5 * MINUTE, revision: 2 }),
      meta(2),
    ]);
    renderWithApi(<DocsPanel workspaceId={WS} />, api);
    const rows = await screen.findAllByTestId("doc-row");
    expect(rows[0]!.textContent).toContain("Opening words of doc 1.");
    fireEvent.click(rows[0]!);
    expect(await screen.findByTestId("doc-title")).toHaveProperty("textContent", "Gap analysis");
    const stamps = screen.getByTestId("doc-meta").textContent!;
    expect(stamps).toMatch(/^By cp-artifacts · \d{2}:\d{2} · updated \d{2}:\d{2}$/);
    const body = screen.getByTestId("doc-body");
    expect(body.hasAttribute("data-transcript")).toBe(true);
    // The title is said once, by the header: the doc's own leading `# Gap analysis` is left out.
    await waitFor(() => expect(within(body).getByRole("table")).toBeTruthy());
    expect(within(body).queryByRole("heading", { name: "Gap analysis" })).toBeNull();
    expect(body.textContent).toContain("What Gram lacks.");
    // Its table reads in the panel's own scroll, with no box of its own and no toolbar.
    const table = within(body).getByRole("table");
    expect((table.parentElement as HTMLElement).style.maxHeight).toBe("");
    expect(within(body).queryByTitle(/copy table|download table|fullscreen/i)).toBeNull();
    expect(body.textContent).toContain("const x = 1;");
    fireEvent.click(screen.getByTestId("doc-back"));
    expect(await screen.findAllByTestId("doc-row")).toHaveLength(2);
  });

  it("saves an edit over the revision it opened", async () => {
    const { api, saveDoc } = docsApi([meta(1, { revision: 3 })], "Old text.");
    useDocPane.setState({ open: { [WS]: "doc-1" as DocId } });
    renderWithApi(<DocsPanel workspaceId={WS} />, api);
    fireEvent.click(await screen.findByTestId("doc-edit"));
    expect(screen.getByTestId("doc-edit").getAttribute("aria-pressed")).toBe("true");
    const editor = screen.getByTestId("doc-editor") as HTMLTextAreaElement;
    expect(editor.value).toBe("Old text.");
    expect((screen.getByTestId("doc-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(editor, { target: { value: "New text." } });
    await act(async () => fireEvent.click(screen.getByTestId("doc-save")));
    expect(saveDoc).toHaveBeenCalledWith(WS, "doc-1", "New text.", 3);
    await waitFor(() => expect(screen.queryByTestId("doc-editor")).toBeNull());
  });

  it("says why a save was refused and keeps the edit", async () => {
    const { api, saveDoc } = docsApi([meta(1)], "Old text.");
    saveDoc.mockRejectedValueOnce(
      Object.assign(new Error("Doc 1 changed since you opened it (now revision 2)."), {
        _tag: "InvalidState",
      }),
    );
    useDocPane.setState({ open: { [WS]: "doc-1" as DocId } });
    renderWithApi(<DocsPanel workspaceId={WS} />, api);
    fireEvent.click(await screen.findByTestId("doc-edit"));
    fireEvent.change(screen.getByTestId("doc-editor"), { target: { value: "Mine." } });
    await act(async () => fireEvent.click(screen.getByTestId("doc-save")));
    expect((await screen.findByTestId("doc-save-error")).textContent).toContain(
      "changed since you opened it",
    );
    expect((screen.getByTestId("doc-editor") as HTMLTextAreaElement).value).toBe("Mine.");
  });

  it("says docs need a workspace where the window is on none", () => {
    renderWithApi(<DocsPanel workspaceId={undefined} />, docsApi([]).api);
    expect(document.body.textContent).toContain("Docs belong to a workspace");
  });
});

describe("WorkersDocs", () => {
  it("fills the Workers tab's slot with the Docs strip", async () => {
    const { api } = docsApi([meta(1)]);
    renderWithApi(<WorkersDocs workspaceId={WS} />, api);
    const strip = await screen.findByTestId("docs-strip");
    expect(within(strip).getByTestId("doc-row").dataset["docId"]).toBe("doc-1");
    expect(within(strip).getByTestId("docs-view-all")).toBeTruthy();
  });
});

describe("PinnedDocChip", () => {
  it("pins the doc the thread last saved, with its age", async () => {
    const { api } = docsApi([
      meta(1, { authorThreadId: OTHER, title: "Someone else's" }),
      meta(2, { title: "Older of mine" }),
      meta(3, { title: "Mine", updatedAt: NOW - 2 * MINUTE }),
    ]);
    renderWithApi(<PinnedDocChip threadId={WORKER} />, api);
    const chip = await screen.findByTestId("pinned-doc");
    expect(chip.textContent).toBe("Mine· updated 2m ago");
    fireEvent.click(chip);
    expect(useDocPane.getState().open[WS]).toBe("doc-3");
  });

  it("shows nothing for a thread with no doc of its own", async () => {
    const { api } = docsApi([meta(1, { authorThreadId: OTHER })]);
    renderWithApi(<PinnedDocChip threadId={WORKER} />, api);
    await waitFor(() => expect(api.listDocs).toHaveBeenCalled());
    expect(screen.queryByTestId("pinned-doc")).toBeNull();
    expect(pinnedDocOf(undefined, WORKER)).toBeUndefined();
  });
});

describe("withoutRepeatedTitle", () => {
  it("leaves out a leading heading that repeats the title, whatever its case or spacing", () => {
    expect(withoutRepeatedTitle("# Gap analysis\n\nBody.", "Gap analysis")).toBe("Body.");
    expect(withoutRepeatedTitle("\n#  gap  Analysis ##\r\nBody.", "Gap analysis")).toBe("Body.");
    expect(withoutRepeatedTitle("# Gap analysis", "Gap analysis")).toBe("");
  });

  it("keeps a heading that says something else, a lower heading and a doc without one", () => {
    expect(withoutRepeatedTitle("# Findings\n\nBody.", "Gap analysis")).toBe("# Findings\n\nBody.");
    expect(withoutRepeatedTitle("## Gap analysis\nBody.", "Gap analysis")).toBe(
      "## Gap analysis\nBody.",
    );
    expect(withoutRepeatedTitle("Body.\n# Gap analysis", "Gap analysis")).toBe(
      "Body.\n# Gap analysis",
    );
  });
});
