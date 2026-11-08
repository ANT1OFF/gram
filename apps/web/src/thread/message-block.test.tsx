// @vitest-environment happy-dom
import type {
  CompactionData,
  GitState,
  GramUIMessage,
  ThreadId,
  WorkerLedgerEntry,
} from "@gram/contracts";
import { serializeReviewNotice } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { mockReviewNotice } from "@/api/mock-babysit";
import { formatMessageTime, notificationTime } from "@/lib/time";
import { renderWithRouter as renderWithApi } from "@/panels/test-utils";
import {
  OrchestratorStreamProvider,
  type OrchestratorStream,
} from "@/orchestration/stream-context";
import type * as Feeds from "@/stores/feeds";
import { createMessageFold } from "@/stores/message-fold";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useUsageLimits } from "@/stores/usage-limits";

import {
  CompactingLine,
  compactingParts,
  compactionLabel,
  compactionParts,
} from "./compaction-marker";
import { errorSentence, unknownResetText } from "./agent-error-card";
import { filePath, MessageBlock } from "./message-block";
import { useRetrySchedule } from "./retry-time";
import { useModelPickerRequests } from "@/composer/model-picker-request";
import { sessionRestartLabel } from "./session-restart-marker";
import { PrRefsContext } from "./pr-ref-link";
import { EMPTY_PR_REF_INDEX, prRefIndexOf, type PrRefIndex } from "./pr-refs";

/** What `feedMessages` returns per thread: the transcript a mounted view would have folded. */
const feed = new Map<string, ReadonlyArray<GramUIMessage>>();
vi.mock("@/stores/feeds", async (original) => ({
  ...(await original<typeof Feeds>()),
  feedMessages: (threadId: string) => feed.get(threadId) ?? [],
  useThreadFeed: (threadId: string, select: (state: { messages: unknown }) => unknown) =>
    select({ messages: feed.get(threadId) ?? [] }),
}));

const T = "t-attach" as ThreadId;
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const withFiles = (
  ...files: ReadonlyArray<{ path: string; mediaType: string; filename: string }>
): GramUIMessage => ({
  id: "m1",
  role: "user",
  parts: [
    { type: "text", text: "what's in this?" },
    ...files.map((file) => ({
      type: "file" as const,
      mediaType: file.mediaType,
      filename: file.filename,
      url: `file://${file.path}`,
    })),
  ],
});

const render = (message: GramUIMessage, readAttachment: unknown) =>
  renderWithApi(
    <MessageBlock
      threadId={T}
      message={message}
      streamingIds={new Set()}
      subagents={new Map()}
      subagentUsage={new Map()}
    />,
    { readAttachment } as never,
  );

const IMAGE = {
  path: "/data/attachments/t-attach/0f0f0f0f-shot.png",
  mediaType: "image/png",
  filename: "shot.png",
};

beforeEach(() => {
  vi.spyOn(console, "warn");
  vi.spyOn(console, "error");
});
afterEach(() => {
  cleanup();
  try {
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

describe("MessageBlock attachments", () => {
  it("renders an image attachment inline and opens it full size", async () => {
    const readAttachment = vi.fn(async () => ({
      path: IMAGE.path,
      mediaType: "image/png",
      size: 68,
      tooLarge: false,
      base64: PNG,
    }));
    render(withFiles(IMAGE), readAttachment);

    const thumbnail = await screen.findByTestId("attachment-thumbnail");
    expect(readAttachment).toHaveBeenCalledWith(T, IMAGE.path);
    expect(screen.getByTestId("message-attachment")).toHaveProperty("title", IMAGE.path);
    expect(thumbnail.querySelector("img")?.getAttribute("src")).toBe(
      `data:image/png;base64,${PNG}`,
    );

    await userEvent.click(thumbnail);
    const lightbox = await screen.findByTestId("attachment-lightbox");
    expect(lightbox.querySelector("img")?.getAttribute("src")).toBe(`data:image/png;base64,${PNG}`);
    expect(lightbox.textContent).toContain("shot.png");
  });

  it("keeps the chip for a text attachment and for an image format with no preview", async () => {
    const readAttachment = vi.fn();
    render(
      withFiles(
        {
          path: "/data/attachments/t-attach/aa-notes.md",
          mediaType: "text/markdown",
          filename: "notes.md",
        },
        {
          path: "/data/attachments/t-attach/bb-photo.heic",
          mediaType: "image/heic",
          filename: "photo.heic",
        },
      ),
      readAttachment,
    );

    const chips = await screen.findAllByTestId("message-attachment");
    expect(chips.map((chip) => chip.textContent)).toEqual(["notes.md", "photo.heic"]);
    expect(screen.queryByTestId("attachment-thumbnail")).toBeNull();
    expect(readAttachment).not.toHaveBeenCalled();
  });

  it("falls back to the chip when the file is gone", async () => {
    const readAttachment = vi.fn(async () => {
      throw Object.assign(new Error("File not found"), { _tag: "NotFound" });
    });
    render(withFiles(IMAGE), readAttachment);

    await waitFor(() => expect(readAttachment).toHaveBeenCalled());
    const chip = await screen.findByTestId("message-attachment");
    expect(chip.textContent).toBe("shot.png");
    expect(screen.queryByTestId("attachment-thumbnail")).toBeNull();
  });

  it("falls back to the chip for an attachment too large to send inline", async () => {
    const readAttachment = vi.fn(async () => ({
      path: IMAGE.path,
      mediaType: "image/png",
      size: 9_000_000,
      tooLarge: true,
    }));
    render(withFiles(IMAGE), readAttachment);

    await waitFor(() => expect(readAttachment).toHaveBeenCalled());
    expect(screen.queryByTestId("attachment-thumbnail")).toBeNull();
    expect(screen.getByTestId("message-attachment").textContent).toBe("shot.png");
  });
});

describe("filePath", () => {
  it("decodes a POSIX URL and drops the slash before a Windows drive", () => {
    expect(filePath("file:///data/my%20shot.png")).toBe("/data/my shot.png");
    expect(filePath("file:///C:/Users/me/shot.png")).toBe("C:/Users/me/shot.png");
    expect(filePath("https://organization.example.invalid/x.png")).toBe(
      "https://organization.example.invalid/x.png",
    );
  });
});

const reply = (...paths: ReadonlyArray<string>): GramUIMessage => ({
  id: "m2",
  role: "assistant",
  parts: [
    { type: "text", text: "Here is the result." },
    ...paths.map((path) => ({
      type: "file" as const,
      mediaType: "application/octet-stream",
      url: `file://${path}`,
    })),
  ],
});

/** The thread's checkout, which is what decides whether the Files panel can open a path. */
const checkedOutAt = (path: string) =>
  useThreadsStore.setState({
    byId: { [T]: { thread: { id: T, checkout: { kind: "main", path } } } },
  } as never);

describe("MessageBlock files the agent sent", () => {
  it("previews an image inline, named by its file name", async () => {
    const readAttachment = vi.fn(async () => ({
      path: "/tmp/shots/home page.png",
      mediaType: "image/png",
      size: 68,
      tooLarge: false,
      base64: PNG,
    }));
    render(reply("/tmp/shots/home%20page.png"), readAttachment);
    const thumbnail = await screen.findByTestId("attachment-thumbnail");
    expect(thumbnail.getAttribute("aria-label")).toBe("Open home page.png");
    expect(readAttachment).toHaveBeenCalledWith(T, "/tmp/shots/home page.png");
    expect(screen.getByTestId("sent-file").textContent).toContain("home page.png");
  });

  it("offers a file in the checkout as a card that opens it in the Files panel", async () => {
    checkedOutAt("/repo");
    const readAttachment = vi.fn();
    const requestPanel = vi.spyOn(useLayoutStore.getState(), "requestPanel");
    render(reply("/repo/docs/report.md"), readAttachment);
    await userEvent.click(screen.getByRole("button", { name: "Open report.md in Files" }));
    expect(requestPanel).toHaveBeenCalledWith(
      { threadId: T, panel: "files", target: "/repo/docs/report.md" },
      T,
    );
    expect(readAttachment).not.toHaveBeenCalled();
    requestPanel.mockRestore();
  });

  it("gives a file outside the checkout its path to copy, not a Files button that would refuse", async () => {
    checkedOutAt("/repo");
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(reply("/tmp/out/report.pdf"), vi.fn());
    expect(screen.queryByRole("button", { name: /in Files/ })).toBeNull();
    const card = screen.getByRole("button", { name: "Copy the path of report.pdf" });
    expect(card.textContent).toContain("/tmp/out/report.pdf");
    await userEvent.click(card);
    expect(writeText).toHaveBeenCalledWith("/tmp/out/report.pdf");
    expect((await screen.findByText("Path copied")).textContent).toBe("Path copied");
    vi.unstubAllGlobals();
  });
});

const STORED = "/data/attachments/t-attach/tool-0123456789abcdef.png";
const readPart = (toolCallId: string, file: string) => ({
  type: "tool-Read" as const,
  toolCallId,
  state: "output-available" as const,
  input: { file_path: file },
  output: { type: "image" as const, file: { type: "image/png" } },
});
const toolImagePart = (toolCallId: string, path?: string, size = 68) => ({
  type: "data-tool-image" as const,
  data: { toolCallId, mediaType: "image/png", size, ...(path === undefined ? {} : { path }) },
});
const assistantWith = (...parts: GramUIMessage["parts"]): GramUIMessage => ({
  id: "m3",
  role: "assistant",
  parts,
});

const showThinking = (message: GramUIMessage, streaming = true) =>
  renderWithApi(
    <MessageBlock
      threadId={T}
      message={message}
      streamingIds={new Set(streaming ? [message.id] : [])}
      subagents={new Map()}
      subagentUsage={new Map()}
    />,
    {},
  );

describe("MessageBlock thinking indicator", () => {
  it.each(["silent", "summary", "raw", "mixed"] as const)(
    "shows one visual row for %s reasoning without exposing or mutating text",
    (kind) => {
      const fold = createMessageFold("thinking");
      fold.apply({ type: "reasoning-start", id: "r" });
      if (kind === "summary" || kind === "mixed")
        fold.apply({ type: "reasoning-delta", id: "r", delta: "Invented summary." });
      if (kind === "raw" || kind === "mixed") {
        fold.apply({ type: "reasoning-start", id: "r:raw" });
        fold.apply({ type: "reasoning-delta", id: "r:raw", delta: "Invented raw." });
      }
      const before = JSON.stringify(fold.snapshot());
      showThinking(fold.snapshot());
      expect(screen.getAllByTestId("reasoning-note")).toHaveLength(1);
      expect(screen.queryByText(/Invented (summary|raw)/)).toBeNull();
      expect(JSON.stringify(fold.snapshot())).toBe(before);
    },
  );

  it.each(["r", "r:raw"])(
    "keeps the single row until both parts end when %s closes first",
    async (first) => {
      const fold = createMessageFold("thinking");
      for (const [id, text] of [
        ["r", "Invented summary."],
        ["r:raw", "Invented raw."],
      ]) {
        fold.apply({ type: "reasoning-start", id: id! });
        fold.apply({ type: "reasoning-delta", id: id!, delta: text! });
      }
      fold.apply({ type: "reasoning-end", id: first });
      showThinking(fold.snapshot());
      expect(screen.getAllByTestId("reasoning-note")).toHaveLength(1);
      expect(fold.snapshot().parts).toMatchObject([
        {
          type: "reasoning",
          id: "r",
          text: "Invented summary.",
          state: first === "r" ? "done" : "streaming",
        },
        {
          type: "reasoning",
          id: "r:raw",
          text: "Invented raw.",
          state: first === "r:raw" ? "done" : "streaming",
        },
      ]);
      cleanup();
      fold.apply({ type: "reasoning-end", id: first === "r" ? "r:raw" : "r" });
      showThinking(fold.snapshot());
      await waitFor(() => expect(screen.queryByTestId("reasoning-note")).toBeNull());
      expect(fold.snapshot().parts.every((p) => p.type === "reasoning" && p.state === "done")).toBe(
        true,
      );
    },
  );

  it("gates unfinished parts by message streaming without modifying them", () => {
    const message = assistantWith({
      type: "reasoning",
      text: "Invented unfinished text.",
      state: "streaming",
    });
    showThinking(message, false);
    expect(screen.queryByTestId("reasoning-note")).toBeNull();
    expect(message.parts[0]).toMatchObject({
      text: "Invented unfinished text.",
      state: "streaming",
    });
  });
});
const servedImage = () =>
  vi.fn(async (_thread: ThreadId, path: string) => ({
    path,
    mediaType: "image/png",
    size: 68,
    tooLarge: false,
    base64: PNG,
  }));

const nativeImageRead = (output: unknown = { type: "image", path: IMAGE.path }): GramUIMessage => {
  const fold = createMessageFold("native-image");
  fold.apply({
    type: "tool-input-available",
    toolName: "Read",
    toolCallId: "native-read",
    input: { file_path: IMAGE.path },
    dynamic: true,
    providerExecuted: true,
  });
  fold.apply({
    type: "tool-output-available",
    toolCallId: "native-read",
    output,
    dynamic: true,
    providerExecuted: true,
  });
  return JSON.parse(JSON.stringify(fold.snapshot())) as GramUIMessage;
};

describe("MessageBlock tool images", () => {
  it.each(["native", "historical"])(
    "previews a persisted %s Codex Read source through attachment authorization",
    async (kind) => {
      const readAttachment = servedImage();
      render(nativeImageRead(kind === "historical" ? {} : undefined), readAttachment);
      await screen.findByRole("button", { name: "Open 0f0f0f0f-shot.png" });
      expect(readAttachment).toHaveBeenCalledWith(T, IMAGE.path);
      await userEvent.click(screen.getByRole("button", { name: /Read/ }));
      expect(screen.getByTestId("tool-card").textContent).toContain(IMAGE.path);
      if (kind === "historical")
        expect(screen.getByText("No result details were provided.")).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Open 0f0f0f0f-shot.png" }));
      expect(
        (await screen.findByTestId("attachment-lightbox"))
          .querySelector("img")
          ?.getAttribute("src"),
      ).toBe(`data:image/png;base64,${PNG}`);
    },
  );

  it.each(["mcp", "dynamic"])(
    "previews persisted %s inline image blocks without dumping bytes or reading paths",
    async (kind) => {
      const readAttachment = servedImage();
      const output =
        kind === "mcp"
          ? {
              content: [
                { type: "image", mimeType: "image/png", data: PNG },
                { type: "text", text: "Image details" },
              ],
              structuredContent: { width: 1 },
            }
          : [
              { type: "inputImage", imageUrl: `data:image/png;base64,${PNG}` },
              { type: "inputText", text: "Image details" },
            ];
      const message: GramUIMessage = JSON.parse(
        JSON.stringify({
          id: "inline-image",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "mcp__synthetic__view_image",
              toolCallId: "inline-image",
              input: {},
              state: "output-available",
              output,
              providerExecuted: true,
            },
          ],
        }),
      );
      render(message, readAttachment);
      expect(screen.getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${PNG}`);
      // The row says what the call did in words; its raw tool id is in the details.
      await userEvent.click(screen.getByRole("button", { name: /^View image · synthetic/ }));
      expect(screen.getByTestId("tool-raw-name").textContent).toContain(
        "mcp__synthetic__view_image",
      );
      expect(screen.getByTestId("tool-card").textContent).toContain("Image details");
      expect(screen.getByTestId("tool-card").textContent).not.toContain(PNG);
      expect(JSON.stringify(message)).toContain(PNG);
      expect(readAttachment).not.toHaveBeenCalled();
      fireEvent.error(screen.getByRole("img"));
      expect(screen.getByText(/could not be decoded/)).toBeTruthy();
      expect(screen.queryByRole("img")).toBeNull();
    },
  );

  it("bounds historical inline bytes and preserves remote URLs as metadata without fetching them", async () => {
    const readAttachment = servedImage();
    const message: GramUIMessage = {
      id: "inline-large",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "view_image",
          toolCallId: "large",
          input: {},
          state: "output-available",
          output: [
            { type: "inputImage", imageUrl: `data:image/png;base64,${"A".repeat(7_000_000)}` },
            { type: "inputImage", imageUrl: "https://example.com/private.png" },
          ],
          providerExecuted: true,
        },
      ],
    };
    render(message, readAttachment);
    expect(screen.getByTestId("tool-image-missing").textContent).toContain("too large");
    expect(screen.queryByRole("img")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /view_image/ }));
    expect(screen.getByTestId("tool-card").textContent).toContain(
      "https://example.com/private.png",
    );
    expect(screen.getByTestId("tool-card").textContent!.length).toBeLessThan(1000);
    expect(readAttachment).not.toHaveBeenCalled();
  });
  it("shows an honest fallback when the source is not an authorized available attachment", async () => {
    const readAttachment = vi.fn(async () => {
      throw new Error("That file isn't attached to this thread");
    });
    render(nativeImageRead(), readAttachment);
    expect((await screen.findByTestId("tool-image-missing")).textContent).toContain(
      "Image preview unavailable",
    );
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("does not preview a text Read or a failed image Read", async () => {
    const readAttachment = servedImage();
    const message = nativeImageRead("actual file text");
    render(message, readAttachment);
    await userEvent.click(screen.getByRole("button", { name: /Read/ }));
    expect(screen.getByText("actual file text")).toBeTruthy();
    expect(readAttachment).not.toHaveBeenCalled();
    cleanup();
    const failed = {
      ...nativeImageRead(),
      parts: [{ ...message.parts[0], state: "output-error", errorText: "Image could not be read" }],
    } as GramUIMessage;
    render(failed, readAttachment);
    await userEvent.click(screen.getByRole("button", { name: /Read/ }));
    expect(screen.getByText("Image could not be read")).toBeTruthy();
    expect(readAttachment).not.toHaveBeenCalled();
  });

  it("shows a read image as a thumbnail under the closed row and larger in the opened card", async () => {
    const readAttachment = servedImage();
    render(
      assistantWith(readPart("r1", "/repo/shot.png"), toolImagePart("r1", STORED), {
        type: "text",
        text: "A checkerboard.",
      }),
      readAttachment,
    );

    const thumbnail = await screen.findByTestId("attachment-thumbnail");
    expect(readAttachment).toHaveBeenCalledWith(T, STORED);
    expect(screen.getByTestId("tool-images").dataset["size"]).toBe("thumbnail");
    expect(thumbnail.querySelector("img")?.getAttribute("src")).toBe(
      `data:image/png;base64,${PNG}`,
    );

    await userEvent.click(screen.getByRole("button", { name: /Read/ }));
    await waitFor(() => expect(screen.getByTestId("tool-images").dataset["size"]).toBe("large"));
    // Named for the file the agent read, not the content hash it is stored under.
    expect(screen.getByTestId("attachment-thumbnail").getAttribute("aria-label")).toBe(
      "Open shot.png",
    );
    await userEvent.click(screen.getByTestId("attachment-thumbnail"));
    const lightbox = await screen.findByTestId("attachment-lightbox");
    expect(lightbox.querySelector("img")?.getAttribute("alt")).toBe("shot.png");
    expect(lightbox.textContent).toBe("shot.png");
  });

  it("keeps a folded run quiet, and gives each opened row its own images", async () => {
    render(
      assistantWith(
        readPart("r1", "/repo/a.png"),
        toolImagePart("r1", "/data/attachments/t-attach/tool-a.png"),
        readPart("r2", "/repo/b.png"),
        toolImagePart("r2", "/data/attachments/t-attach/tool-b.png"),
        toolImagePart("r2", "/data/attachments/t-attach/tool-c.png"),
      ),
      servedImage(),
    );
    expect(screen.queryByTestId("tool-images")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Read 2 files" }));
    const strips = await screen.findAllByTestId("tool-images");
    expect(strips).toHaveLength(2);
    await waitFor(() =>
      expect(strips.map((s) => s.querySelectorAll("img").length)).toEqual([1, 2]),
    );
  });

  it("says so when the image was too large to keep or its file is gone", async () => {
    const readAttachment = vi.fn(async () => {
      throw Object.assign(new Error("File not found"), { _tag: "NotFound" });
    });
    render(
      assistantWith(readPart("r1", "/repo/huge.png"), toolImagePart("r1", undefined, 7_500_000)),
      readAttachment,
    );
    expect(screen.getByTestId("tool-image-missing").textContent).toBe(
      "Image too large to preview · 7.2 MB",
    );
    expect(readAttachment).not.toHaveBeenCalled();
    cleanup();

    render(
      assistantWith(readPart("r1", "/repo/gone.png"), toolImagePart("r1", STORED)),
      readAttachment,
    );
    expect((await screen.findByTestId("tool-image-missing")).textContent).toBe(
      "Image no longer available",
    );
  });
});

const worker = (repo: string, number: number) =>
  ({ threadId: `w-${number}`, pr: { repo, number } }) as unknown as WorkerLedgerEntry;
/** The fields of a `GitState` a case reads; the rest never matter to references. */
const git = (state: object) => state as GitState;

/** An assistant reply of `text`, rendered against `index` as the transcript's provider would. */
const renderText = (text: string, index: PrRefIndex, openExternal = vi.fn(async () => {})) => {
  renderWithApi(
    <PrRefsContext value={index}>
      <MessageBlock
        threadId={T}
        message={assistantWith({ type: "text", text })}
        streamingIds={new Set()}
        subagents={new Map()}
        subagentUsage={new Map()}
      />
    </PrRefsContext>,
    { openExternal } as never,
  );
  return openExternal;
};
const links = () =>
  screen.queryAllByRole("link").map((a) => [a.textContent, a.getAttribute("href"), a.title]);

describe("MessageBlock PR references", () => {
  it("links each of an orchestrator's bare numbers to the repo its worker's PR is in", async () => {
    const index = prRefIndexOf({
      git: git({ origin: "EXAMPLE/teleport" }),
      boundPr: undefined,
      extraPrs: undefined,
      workers: [
        worker("EXAMPLE/api", 2077),
        worker("EXAMPLE/infra", 729),
        worker("EXAMPLE/web", 3713),
      ],
      repoCount: 4,
    });
    const openExternal = renderText(
      "Merge #2077: every check is green.\n\nMerge #729, then register it.\n\nApprove #3713.\n\nNot #55.",
      index,
    );
    await screen.findByText("#3713");
    expect(links()).toEqual([
      ["#2077", "https://github.com/EXAMPLE/api/pull/2077", "EXAMPLE/api#2077"],
      ["#729", "https://github.com/EXAMPLE/infra/pull/729", "EXAMPLE/infra#729"],
      ["#3713", "https://github.com/EXAMPLE/web/pull/3713", "EXAMPLE/web#3713"],
    ]);
    await userEvent.click(screen.getByRole("link", { name: "#729" }));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/EXAMPLE/infra/pull/729");
  });

  it("always links owner/repo#N and a GitHub PR or issue URL, whatever the thread knows", async () => {
    renderText(
      "See ANT1OFF/gram#94, (EXAMPLE/other#1000000) and https://github.com/EXAMPLE/x/issues/12.",
      EMPTY_PR_REF_INDEX,
    );
    await screen.findByText("ANT1OFF/gram#94");
    expect(links()).toEqual([
      ["ANT1OFF/gram#94", "https://github.com/ANT1OFF/gram/pull/94", "ANT1OFF/gram#94"],
      [
        "EXAMPLE/other#1000000",
        "https://github.com/EXAMPLE/other/pull/1000000",
        "EXAMPLE/other#1000000",
      ],
      [
        "https://github.com/EXAMPLE/x/issues/12",
        "https://github.com/EXAMPLE/x/issues/12",
        "EXAMPLE/x#12",
      ],
    ]);
  });

  it("resolves the thread's own and followed PRs to their badge URLs, and a short repo#N", async () => {
    const index = prRefIndexOf({
      git: git({
        origin: "EXAMPLE/app",
        pr: { number: 5, url: "https://github.com/EXAMPLE/app/pull/5" },
        extraPrs: [{ number: 9, url: "https://github.com/EXAMPLE/lib/pull/9" }],
      }),
      boundPr: undefined,
      extraPrs: [{ repo: "EXAMPLE/lib", number: 9, monitor: false }],
      workers: undefined,
      repoCount: 1,
    });
    renderText("#5 and #9, and lib#3; #4 could be either repo.", index);
    await screen.findByText("#5");
    expect(links()).toEqual([
      // The badges' PRs carry their state, in the glyph, the name and the tooltip.
      ["#5, open", "https://github.com/EXAMPLE/app/pull/5", "EXAMPLE/app#5 · Open"],
      ["#9, open", "https://github.com/EXAMPLE/lib/pull/9", "EXAMPLE/lib#9 · Open"],
      ["lib#3", "https://github.com/EXAMPLE/lib/pull/3", "EXAMPLE/lib#3"],
    ]);
  });

  it("never sends an unknown number to the home repo of a workspace with several", async () => {
    const index = prRefIndexOf({
      git: git({ origin: "EXAMPLE/teleport" }),
      boundPr: undefined,
      extraPrs: undefined,
      workers: undefined,
      repoCount: 3,
    });
    renderText("Merge #55.", index);
    await screen.findByText(/Merge #55/);
    expect(links()).toEqual([]);
  });

  it("links a number nothing knows to the thread's one repo, and leaves it alone with none", async () => {
    const one = prRefIndexOf({
      git: git({ origin: "EXAMPLE/app" }),
      boundPr: undefined,
      extraPrs: undefined,
      workers: undefined,
      repoCount: 1,
    });
    renderText("Fixed in #88.", one);
    expect((await screen.findByRole("link", { name: "#88" })).getAttribute("href")).toBe(
      "https://github.com/EXAMPLE/app/pull/88",
    );
    cleanup();

    renderText("Fixed in #88.", EMPTY_PR_REF_INDEX);
    await screen.findByText(/Fixed in #88/);
    expect(links()).toEqual([]);
  });

  it("leaves a number two known repos share as plain text", async () => {
    const index = prRefIndexOf({
      git: undefined,
      boundPr: undefined,
      extraPrs: undefined,
      workers: [worker("EXAMPLE/api", 12), worker("EXAMPLE/web", 12)],
      repoCount: 2,
    });
    renderText("Approve #12.", index);
    await screen.findByText(/Approve #12/);
    expect(links()).toEqual([]);
  });

  it("never links inside code, headings, words, paths or another link", async () => {
    const index = prRefIndexOf({
      git: git({ origin: "EXAMPLE/app" }),
      boundPr: undefined,
      extraPrs: undefined,
      workers: undefined,
      repoCount: 1,
    });
    renderText(
      [
        "## Step #1",
        "",
        "Run `git show #2` and see [the docs](https://organization.example.invalid/page#3).",
        "",
        "```",
        "merge #4",
        "```",
        "",
        "Issue#5, a/b/c#6, x#7y, #0, #20260928 and #8 after all.",
      ].join("\n"),
      index,
    );
    await screen.findByText("#8");
    expect(links()).toEqual([["#8", "https://github.com/EXAMPLE/app/pull/8", "EXAMPLE/app#8"]]);
  });
});

/** The hint the pointer shows over `element`: the nearest title, which a native hint uses. */
const hint = (element: Element) => element.closest("[title]")?.getAttribute("title");

describe("MessageBlock sent time", () => {
  const AT = Date.UTC(2026, 9, 6, 12, 37, 12);
  const sentAt = formatMessageTime(AT);
  const stamp = notificationTime(AT);

  it("shows when a user message arrived in its actions, ahead of them, and not over its bubble", () => {
    render(
      {
        id: "u1",
        role: "user",
        metadata: { createdAt: AT },
        parts: [{ type: "text", text: "ship it" }],
      },
      undefined,
    );
    const time = screen.getByTestId("message-sent-at");
    expect(time.textContent).toBe(stamp);
    // Its own hint has the seconds and the zone.
    expect(hint(time)).toBe(sentAt);
    expect(time.getAttribute("datetime")).toBe("2026-10-06T12:37:12.000Z");
    expect(time.compareDocumentPosition(screen.getByTestId("message-copy"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The row says it already, so the bubble doesn't say it again.
    expect(hint(screen.getByText("ship it"))).toBeUndefined();
    expect(screen.getByTestId("message-copy").getAttribute("aria-label")).toBe("Copy message");
  });

  it("dates a notice and a reply in their actions, the reply's after its fork buttons", () => {
    const notice = mockReviewNotice(412);
    render(
      {
        id: "n1",
        role: "user",
        metadata: { createdAt: AT },
        parts: [
          { type: "text", text: serializeReviewNotice(notice) },
          { type: "data-review-notice", data: notice },
        ],
      },
      undefined,
    );
    expect(screen.getByTestId("message-sent-at").textContent).toBe(stamp);
    expect(hint(screen.getByRole("article", { name: "Review update on #412" }))).toBeUndefined();
    cleanup();

    render(
      {
        ...assistantWith({ type: "text", text: "Read it." }, readPart("c1", "/r/a.ts")),
        metadata: { createdAt: AT + 60_000 },
      },
      undefined,
    );
    const time = screen.getByTestId("message-sent-at");
    expect(time.textContent).toBe(notificationTime(AT + 60_000));
    expect(hint(time)).toBe(formatMessageTime(AT + 60_000));
    expect(time.getAttribute("datetime")).toBe("2026-10-06T12:38:12.000Z");
    expect(screen.getByTestId("message-more").compareDocumentPosition(time)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(hint(screen.getByText("Read it."))).toBeUndefined();
    expect(hint(screen.getByTestId("tool-card"))).toBeUndefined();
    // A reply the agent can't be forked from yet explains why in a tooltip, with no time over it.
    expect(screen.getByTestId("message-fork").getAttribute("aria-description")).toBe(
      "This reply can't be forked from yet",
    );
  });

  it("keeps the time as a hint over a message with no actions: one streaming, or a subagent's", () => {
    const streamed = {
      ...assistantWith({ type: "text", text: "Working on it" }),
      metadata: { createdAt: AT },
    };
    renderWithApi(
      <MessageBlock
        threadId={T}
        message={streamed}
        streamingIds={new Set([streamed.id])}
        subagents={new Map()}
        subagentUsage={new Map()}
      />,
      {} as never,
    );
    expect(hint(screen.getByText("Working on it"))).toBe(sentAt);
    expect(screen.queryByTestId("message-sent-at")).toBeNull();
    cleanup();

    render(
      {
        ...assistantWith({ type: "text", text: "Subagent found it" }),
        metadata: { createdAt: AT, parentToolUseId: "task-1" },
      },
      undefined,
    );
    expect(hint(screen.getByText("Subagent found it"))).toBe(sentAt);
    expect(screen.queryByTestId("message-sent-at")).toBeNull();
  });

  it("shows nothing for a message without a date", () => {
    render(assistantWith({ type: "text", text: "Undated." }), undefined);
    expect(hint(screen.getByText("Undated."))).toBeUndefined();
    expect(screen.queryByTestId("message-sent-at")).toBeNull();
  });
});

describe("MessageBlock agent errors", () => {
  const E = "t-error" as ThreadId;
  const error = {
    kind: "rateLimit",
    httpStatus: 429,
    retryable: true,
    text: "The provider is rate limiting requests (HTTP 429).",
    turnId: "turn-1",
    at: 7,
  } as const;
  const sent: GramUIMessage = {
    id: "u1",
    role: "user",
    metadata: { turnId: "turn-1" as never },
    parts: [{ type: "text", text: "Fix the build" }],
  };
  const failed: GramUIMessage = {
    id: "error-turn-1",
    role: "assistant",
    parts: [{ type: "data-agent-error", id: "error-turn-1", data: error as never }],
  };
  const show = (send: unknown, lastError: unknown, status = "error") => {
    feed.set(E, [sent, failed]);
    useThreadsStore.setState({
      byId: {
        [E]: { status, thread: { id: E, lastError, checkout: { kind: "main", path: "/r" } } },
      },
    } as never);
    return renderWithApi(
      <MessageBlock
        threadId={E}
        message={failed}
        streamingIds={new Set()}
        subagents={new Map()}
        subagentUsage={new Map()}
      />,
      { send } as never,
    );
  };

  it("shows why the turn failed, and sends its message again from Retry", async () => {
    const send = vi.fn(async () => ({ queued: false }));
    show(send, error);
    expect(screen.getByTestId("agent-error").textContent).toContain(error.text);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(send).toHaveBeenCalledWith(E, { text: "Fix the build" });
  });

  it("says when a retry didn't reach the agent, and clears it on the next try", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = new Error("socket closed");
    let fail = true;
    const send = vi.fn(async () => {
      if (fail) throw refused;
      return { queued: false };
    });
    show(send, error);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    const unsent = await screen.findByTestId("retry-unsent");
    // A dropped connection may have lost the answer after the message went, so it isn't "unsent".
    expect(unsent.textContent).toBe(
      "Couldn't confirm the retry reached the agent: socket closed. Check the transcript before trying again.",
    );
    // The turn's own failure stays, and Retry is there to try again.
    expect(screen.getByTestId("agent-error").textContent).toContain(error.text);
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByTestId("retry-unsent")).toBeNull());
    expect(send).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledExactlyOnceWith("retry turn", refused);
    logged.mockClear();
  });

  it("says nothing was sent only for a refusal made before the message was taken", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = Object.assign(new Error("The thread is closing"), { _tag: "InvalidState" });
    const send = vi.fn(async () => {
      throw refused;
    });
    show(send, error);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect((await screen.findByTestId("retry-unsent")).textContent).toBe(
      "The retry was refused, so nothing was sent: The thread is closing",
    );
    expect(logged).toHaveBeenCalledExactlyOnceWith("retry turn", refused);
    logged.mockClear();
  });

  it("reads as a quiet receipt once the message was sent again, recovered once that ended well", () => {
    // Read on the retry's own day, so it says its clock alone.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 4, 14, 6));
    onTestFinished(() => clock.mockRestore());
    const again: GramUIMessage = {
      id: "u2",
      role: "user",
      metadata: { createdAt: Date.UTC(2026, 10, 4, 14, 5) },
      parts: [{ type: "text", text: "Fix the build" }],
    };
    const built: GramUIMessage = {
      id: "a2",
      role: "assistant",
      metadata: { turnEnd: { at: Date.UTC(2026, 10, 4, 14, 6), reason: "completed" } },
      parts: [{ type: "text", text: "Built.", state: "done" }],
    };
    show(vi.fn(), error, "idle");
    feed.set(E, [sent, failed, again, built]);
    cleanup();
    renderWithApi(
      <MessageBlock
        threadId={E}
        message={failed}
        streamingIds={new Set()}
        subagents={new Map()}
        subagentUsage={new Map()}
      />,
      {} as never,
    );
    const card = screen.getByTestId("agent-error");
    expect(card.dataset["state"]).toBe("retried");
    expect(card.getAttribute("role")).toBe("status");
    // What was done and how it went leads; the failure it got past folds under Details.
    expect(screen.getByTestId("agent-error-retried").textContent).toMatch(
      /^Retried at \d\d:\d\d · succeeded$/,
    );
    expect(card.dataset["recovered"]).toBe("true");
    expect(screen.queryByTestId("agent-error-history")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByTestId("agent-error-history").textContent).toContain(error.text);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(card.querySelector(".text-destructive")).toBeNull();
  });

  it("shows the attempts as one card on the newest, with the earlier ones behind a disclosure", async () => {
    const second = { ...error, turnId: "turn-2", at: 9 } as const;
    const again: GramUIMessage = {
      id: "u2",
      role: "user",
      metadata: { turnId: "turn-2" as never },
      parts: [{ type: "text", text: "Fix the build" }],
    };
    const failedAgain: GramUIMessage = {
      id: "error-turn-2",
      role: "assistant",
      parts: [{ type: "data-agent-error", id: "error-turn-2", data: second as never }],
    };
    feed.set(E, [sent, failed, again, failedAgain]);
    useThreadsStore.setState({
      byId: {
        [E]: {
          status: "error",
          thread: { id: E, lastError: second, checkout: { kind: "main", path: "/r" } },
        },
      },
    } as never);
    renderWithApi(
      <>
        <MessageBlock
          threadId={E}
          message={failed}
          streamingIds={new Set()}
          subagents={new Map()}
          subagentUsage={new Map()}
        />
        <MessageBlock
          threadId={E}
          message={failedAgain}
          streamingIds={new Set()}
          subagents={new Map()}
          subagentUsage={new Map()}
        />
      </>,
      {} as never,
    );
    // The first attempt's card folds into the newest one.
    const [newest, ...rest] = screen.getAllByTestId("agent-error");
    expect(rest).toHaveLength(0);
    expect(newest?.dataset["state"]).toBe("failed");
    expect(newest?.textContent).toContain("attempt 2 of 2 · needs action");
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    const earlier = screen.getByRole("button", { name: "1 earlier attempt" });
    expect(screen.queryByTestId("agent-error-earlier-attempt")).toBeNull();
    await userEvent.click(earlier);
    expect((await screen.findByTestId("agent-error-earlier-attempt")).textContent).toContain(
      "Attempt 1",
    );
  });

  it("offers an automatic retry in 30 s and another model once throttling repeats", async () => {
    // Only timeouts and Date are faked, pinned to a fixed clock; the card's tick and the router keep
    // their real timers.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: 1_800_000_000_000 });
    onTestFinished(() => {
      vi.useRealTimers();
      useRetrySchedule.setState({ due: {} });
      useModelPickerRequests.setState({ asked: {} });
    });
    const second = { ...error, turnId: "turn-2", at: 9 } as const;
    const again: GramUIMessage = {
      id: "u2",
      role: "user",
      metadata: { turnId: "turn-2" as never },
      parts: [{ type: "text", text: "Fix the build" }],
    };
    const failedAgain: GramUIMessage = {
      id: "error-turn-2",
      role: "assistant",
      parts: [{ type: "data-agent-error", id: "error-turn-2", data: second as never }],
    };
    feed.set(E, [sent, failed, again, failedAgain]);
    useThreadsStore.setState({
      byId: {
        [E]: {
          status: "error",
          thread: { id: E, lastError: second, checkout: { kind: "main", path: "/r" } },
        },
      },
    } as never);
    const send = vi.fn(async () => ({ queued: false }));
    renderWithApi(
      <MessageBlock
        threadId={E}
        message={failedAgain}
        streamingIds={new Set()}
        subagents={new Map()}
        subagentUsage={new Map()}
      />,
      { send } as never,
    );
    // Try another model asks this thread's picker to open, not whichever pane has focus.
    fireEvent.click(screen.getByTestId("agent-error-other-model"));
    expect(screen.getByTestId("agent-error-other-model").textContent).toBe("Try another model");
    expect(useModelPickerRequests.getState().asked).toEqual({ [E]: 1 });

    const auto = screen.getByTestId("agent-error-auto-retry");
    expect(auto.textContent).toBe("Retry automatically in 30 s");
    fireEvent.click(auto);
    expect(screen.getByTestId("agent-error-auto-retry-armed").textContent).toContain(
      "Retrying in 30 s",
    );
    // Retry stays, as Retry now, while the automatic one counts down.
    expect(screen.getByTestId("agent-error-retry").textContent).toBe("Retry now");
    // Cancelled, nothing goes.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useRetrySchedule.getState().due).toEqual({});
    vi.advanceTimersByTime(60_000);
    expect(send).not.toHaveBeenCalled();
    // Armed again, it sends the turn's message once the 30 s pass, by Retry's own path.
    fireEvent.click(screen.getByTestId("agent-error-auto-retry"));
    vi.advanceTimersByTime(29_000);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(send).toHaveBeenCalledWith(E, { text: "Fix the build" });
  });

  it("offers no automatic retry or other model on a first rate limit", () => {
    show(vi.fn(), error);
    expect(screen.queryByTestId("agent-error-auto-retry")).toBeNull();
    expect(screen.queryByTestId("agent-error-other-model")).toBeNull();
  });

  it("says plainly when the provider gave no reset time, with Retry now and Usage beside it", () => {
    show(vi.fn(), error);
    // Throttled requests, which a retry may get past, stay "Rate limited", with Retry a full
    // button under the message rather than a corner control.
    expect(screen.getByTestId("agent-error-title").textContent).toBe("Rate limited");
    const retry = screen.getByTestId("agent-error-retry");
    expect(retry.textContent).toBe("Retry");
    expect(retry.className).not.toContain("h-6");
    const sentence = screen.getByText(error.text);
    expect(sentence.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const time = screen.getByTestId("agent-error-retry-time");
    expect(time.dataset["known"]).toBe("false");
    expect(time.textContent).toBe("The provider gave no reset time. Retry now, or check Usage.");
    expect(screen.getByTestId("agent-error-usage").getAttribute("href")).toBe("/usage");
    expect(screen.queryByTestId("agent-error-retry-then")).toBeNull();
  });

  it("never guesses a time beside a reset it doesn't know, an older stored sentence included", () => {
    // Round 8: "Try again in a moment." sat beside "when this clears isn't known".
    show(vi.fn(), { ...error, text: `${error.text} Try again in a moment.` });
    const card = screen.getByTestId("agent-error").textContent ?? "";
    expect(card).not.toContain("in a moment");
    expect(card).not.toContain("isn't known");
    expect(card).toContain(error.text);
    expect(errorSentence("unknown", "Try again in a moment.")).toBe("Try again in a moment.");
    // On a gateway, the gateway is who gave no time; with nothing to resend, only Usage is offered.
    expect(unknownResetText("gateway", false)).toBe("The gateway gave no reset time. Check");
  });

  it.each([
    { when: "before midnight", now: new Date(2026, 10, 5, 23, 59, 55), stamp: "6 Nov 00:59" },
    { when: "after midnight", now: new Date(2026, 10, 6, 0, 0, 5), stamp: "01:00" },
  ])(
    "names the provider's reset as the time to try again, and retries then on request ($when)",
    ({ now, stamp }) => {
      // Local calendar dates exercise midnight in any host zone. Only Date is faked, so the
      // router and user interactions keep their real timers.
      vi.useFakeTimers({ toFake: ["Date"] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      vi.setSystemTime(now);
      const resetsAt = Date.now() + 60 * 60 * 1000;
      useUsageLimits.setState({
        limits: {
          claude: {
            fiveHour: { utilization: 1, status: "rejected", resetsAt, expiresAt: resetsAt },
          },
        },
      });
      const limit = {
        ...error,
        retryable: false,
        text: "The usage limit is reached (HTTP 429). It resets on the provider's schedule.",
      };
      const send = vi.fn(async () => ({ queued: false }));
      feed.set(E, [sent, { ...failed, parts: [{ ...failed.parts[0], data: limit } as never] }]);
      useThreadsStore.setState({
        byId: {
          [E]: {
            status: "error",
            thread: {
              id: E,
              lastError: limit,
              model: { agent: "claude", model: "opus" },
              checkout: { kind: "main", path: "/r" },
            },
          },
        },
      } as never);
      renderWithApi(
        <MessageBlock
          threadId={E}
          message={{ ...failed, parts: [{ ...failed.parts[0], data: limit } as never] }}
          streamingIds={new Set()}
          subagents={new Map()}
          subagentUsage={new Map()}
        />,
        { send } as never,
      );
      const time = screen.getByTestId("agent-error-retry-time");
      expect(time.dataset["known"]).toBe("true");
      // A spent usage limit is named for what it is, with its reset, never "Rate limited". The
      // reset is said once in words, in the title; the button carries it as its action.
      expect(screen.getByTestId("agent-error-title").textContent).toBe(
        `Usage limit · resets ${stamp}`,
      );
      const card = screen.getByTestId("agent-error").textContent ?? "";
      expect(card).not.toContain("Try again at");
      expect(card).not.toContain("Retry then");
      expect(card).not.toContain("provider's schedule");
      expect(screen.getByTestId("agent-error-retry-then").textContent).toBe(`Retry at ${stamp}`);
      expect(screen.getByTestId("agent-error-usage").textContent).toBe("Usage");
      // The body is one sentence: the reset it also named is in the title.
      expect(
        screen.getByText("The usage limit is reached (HTTP 429).", { exact: true }),
      ).toBeTruthy();
      // Sending now would only repeat the refusal: no Retry, only Retry at.
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      fireEvent.click(screen.getByTestId("agent-error-retry-then"));
      expect(screen.getByTestId("agent-error-retry-scheduled").textContent).toContain(
        `Retrying at ${stamp} while Gram is open`,
      );
      expect(Object.keys(useRetrySchedule.getState().due)).toEqual([`${E}:${limit.at}`]);
      expect(send).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(useRetrySchedule.getState().due).toEqual({});
      expect(screen.getByTestId("agent-error-retry-then")).toBeTruthy();
      useUsageLimits.setState({ limits: {} });
    },
  );

  it("offers no retry once a later turn has moved on, or for a refusal that would only repeat", () => {
    show(vi.fn(), { ...error, at: 8 });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    cleanup();
    show(vi.fn(), error, "running");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    cleanup();
    const refused = { ...error, kind: "gatewayRefused", retryable: false } as const;
    feed.set(E, [sent, { ...failed, parts: [{ ...failed.parts[0], data: refused } as never] }]);
    renderWithApi(
      <MessageBlock
        threadId={E}
        message={{ ...failed, parts: [{ ...failed.parts[0], data: refused } as never] }}
        streamingIds={new Set()}
        subagents={new Map()}
        subagentUsage={new Map()}
      />,
      {} as never,
    );
    expect(screen.getByTestId("agent-error").dataset["kind"]).toBe("gatewayRefused");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

const showCompaction = (data: CompactionData) =>
  renderWithApi(
    <MessageBlock
      threadId={T}
      message={{
        id: "m-compact",
        role: "assistant",
        parts: [
          { type: "text", text: "Done with the first half.", state: "done" },
          { type: "data-compaction", id: "compaction:c1", data },
          { type: "text", text: "Carrying on.", state: "done" },
        ],
      }}
      streamingIds={new Set()}
      subagents={new Map()}
      subagentUsage={new Map()}
    />,
    {} as never,
  );

describe("MessageBlock compaction marker", () => {
  afterEach(cleanup);

  const AT = Date.UTC(2026, 9, 1, 12, 32);
  const UTC = { timeZone: "UTC" };

  it("uses a 24-hour compaction clock, 00 at midnight, whatever the locale", () => {
    const intl = { timeZone: "Europe/Oslo" };
    const data = { trigger: "auto", at: AT } as const;
    expect(compactionLabel(data, AT + 60_000, intl)).toBe("Context compacted · 14:32");
    expect(compactionLabel(data, AT + 86_400_000, intl)).toBe("Context compacted · 1 Oct 14:32");
    const midnight = Date.UTC(2026, 9, 1, 22, 5);
    expect(compactionLabel({ ...data, at: midnight }, midnight, intl)).toBe(
      "Context compacted · 00:05",
    );
  });

  it("reads as the time and the tokens before and after, leaving out what wasn't reported", () => {
    const full = { trigger: "auto", preTokens: 182_400, postTokens: 23_900, at: AT } as const;
    expect(compactionLabel(full, AT + 60_000, UTC)).toBe(
      "Context compacted · 12:32 · 182K → 24K tokens",
    );
    expect(compactionLabel(full, AT + 86_400_000, UTC)).toBe(
      "Context compacted · 1 Oct 12:32 · 182K → 24K tokens",
    );
    expect(compactionLabel({ trigger: "auto", preTokens: 42 }, AT, UTC)).toBe(
      "Context compacted · from 42 tokens",
    );
    expect(compactionLabel({ trigger: "manual" }, AT, UTC)).toBe("Context compacted");
    // Halves a narrow thread can wrap between, so the tokens move down rather than off the edge.
    expect(compactionParts(full, AT + 86_400_000, UTC)).toEqual([
      "Context compacted · 1 Oct 12:32",
      "182K → 24K tokens",
    ]);
  });

  it("stands between the text before and after it, and opens to the summary", async () => {
    showCompaction({
      trigger: "manual",
      preTokens: 13_952,
      postTokens: 3_765,
      summary: "1. **Intent**",
    });
    const marker = screen.getByTestId("compaction");
    const text = marker.closest("[data-testid=message-assistant]")!.textContent!;
    expect(text.indexOf("Done with the first half.")).toBeLessThan(
      text.indexOf("Context compacted"),
    );
    expect(text.indexOf("Context compacted")).toBeLessThan(text.indexOf("Carrying on."));
    const toggle = marker.querySelector("button")!;
    expect(toggle.textContent).toBe("Context compacted · 14K → 4K tokens");
    expect(toggle.getAttribute("title")).toMatch(/on request/);
    expect(screen.queryByTestId("compaction-summary")).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByTestId("compaction-summary").textContent).toBe("1. **Intent**");
  });

  it("marks a session restart with its time, and the date when it wasn't today", () => {
    expect(sessionRestartLabel({ at: AT }, AT + 60_000, UTC)).toBe(
      "Session restarted · config reloaded · 12:32",
    );
    expect(sessionRestartLabel({ at: AT }, AT + 86_400_000, UTC)).toBe(
      "Session restarted · config reloaded · 1 Oct 12:32",
    );
    expect(sessionRestartLabel({ at: AT, reason: "mcpConfig" }, AT + 60_000, UTC)).toBe(
      "Session restarted · MCP config changed · 12:32",
    );
    renderWithApi(
      <MessageBlock
        threadId={T}
        message={{
          id: "m-restart",
          role: "assistant",
          parts: [{ type: "data-session-restart", id: "r1", data: { at: Date.now() } }],
        }}
        streamingIds={new Set()}
        subagents={new Map()}
        subagentUsage={new Map()}
      />,
      {} as never,
    );
    expect(screen.getByTestId("session-restart").getAttribute("title")).toMatch(
      /same conversation/,
    );
  });

  it("runs live while compacting: what, how long, and the context it started from", () => {
    expect(compactingParts({ startedAt: AT, preTokens: 182_400 }, AT + 12_400)).toEqual([
      "Compacting context…",
      "12s",
      "from 182K tokens",
    ]);
    expect(compactingParts({ startedAt: AT }, AT + 65_000)).toEqual([
      "Compacting context…",
      "1m 05s",
    ]);
    renderWithApi(<CompactingLine compaction={{ startedAt: Date.now(), trigger: "manual" }} />, {});
    const line = screen.getByRole("status");
    expect(line.textContent).toContain("Compacting context…");
    expect(line.getAttribute("title")).toMatch(/on request/);
  });

  it("opens an explanation when the agent shares no summary", async () => {
    showCompaction({ trigger: "auto", preTokens: 42 });
    await userEvent.click(
      screen.getByRole("button", { name: "Context compacted · from 42 tokens" }),
    );
    expect(screen.getByTestId("compaction-details").textContent).toContain("Summary not provided");
    expect(screen.queryByTestId("compaction-summary")).toBeNull();
  });
});

describe("MessageBlock for another thread's message", () => {
  const W = "t-worker" as ThreadId;
  const fromWorker: GramUIMessage = {
    id: "m-w",
    role: "user",
    metadata: { createdAt: Date.UTC(2026, 9, 20, 9, 42) },
    parts: [
      { type: "text", text: "The user explicitly reconfirmed: merge #311." },
      {
        type: "data-thread-origin",
        id: "m-w",
        data: { threadId: W, title: "Fix login", depth: 2, feature: "login" },
      },
    ],
  };

  it("sits on the agents' side under its sender, not in the user's bubble", () => {
    render(fromWorker, undefined);
    const block = screen.getByTestId("message-from-thread");
    expect(block.className).toContain("is-assistant");
    expect(block.className).not.toContain("is-user");
    expect(screen.queryByTestId("message-user")).toBeNull();
    expect(screen.getByTestId("message-origin").textContent).toContain("Fix login· worker");
    expect(screen.getByTestId("message-thread").textContent).toContain(
      "The user explicitly reconfirmed: merge #311.",
    );
    expect(screen.getByTestId("message-actions").className).toContain("justify-start");
  });

  it("leaves the user's own message in their bubble, as typed", () => {
    render(withFiles(), undefined);
    const block = screen.getByTestId("message-user");
    expect(block.className).toContain("is-user");
    expect(block.textContent).toContain("what's in this?");
    expect(screen.queryByTestId("message-origin")).toBeNull();
    expect(screen.queryByTestId("message-from-thread")).toBeNull();
    expect(screen.getByTestId("message-actions").className).toContain("justify-end");
  });
});

describe("MessageBlock actions in the orchestrator's chat", () => {
  const stream: OrchestratorStream = {
    plan: { messages: [], extras: new Map(), digests: [], foldedInto: new Map() },
    cards: new Map(),
    workers: [],
  };
  const inChat = (message: GramUIMessage) =>
    renderWithApi(
      <OrchestratorStreamProvider stream={stream}>
        <MessageBlock
          threadId={T}
          message={message}
          streamingIds={new Set()}
          subagents={new Map()}
          subagentUsage={new Map()}
        />
      </OrchestratorStreamProvider>,
      {} as never,
    );
  const said: GramUIMessage = {
    id: "u-float",
    role: "user",
    metadata: { createdAt: 1_700_000_000_000 },
    parts: [{ type: "text", text: "Add the shortcut sheet too." }],
  };
  const answered = {
    ...assistantWith({ type: "text", text: "Started it." }),
    metadata: { createdAt: 1_700_000_060_000 },
  } as GramUIMessage;

  it("float over a reply and beside a bubble there, and keep their row elsewhere", () => {
    inChat(said);
    const user = screen.getByTestId("message-actions");
    expect(user.dataset["floating"]).toBe("true");
    // Where there is no room or no hovering pointer, the same strip is the in-flow row.
    expect(user.className).toContain("justify-end");
    expect(user.className).toContain("float-actions:right-full");
    cleanup();

    inChat(answered);
    const strip = screen.getByTestId("message-actions");
    expect(strip.dataset["floating"]).toBe("true");
    expect(strip.className).toContain("float-actions:bottom-0");
    cleanup();

    render(answered, undefined);
    expect(screen.getByTestId("message-actions").dataset["floating"]).toBeUndefined();
  });

  it("keep a notice's actions in their row under its card", () => {
    const notice = mockReviewNotice(412);
    inChat({
      id: "n-float",
      role: "user",
      metadata: { createdAt: 1_700_000_000_000 },
      parts: [
        { type: "text", text: serializeReviewNotice(notice) },
        { type: "data-review-notice", data: notice },
      ],
    });
    expect(screen.getByTestId("message-actions").dataset["floating"]).toBeUndefined();
  });
});
