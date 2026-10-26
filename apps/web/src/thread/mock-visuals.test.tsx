// @vitest-environment happy-dom
import type { FileImage, MockCardData, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";

import { MockCard, OptionGallery } from "./mock-visuals";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const T = "t-orchestrator" as ThreadId;
const FOLDER = "/repo/.worktrees/feat-needs-you-home/docs/design/mocks/needs-you-home";

const { previewFile, openThread } = useLayoutStore.getState();

/** `fs.image` answering for every screenshot, as the server does for one in the thread's folders. */
const fsImage = vi.fn(async (path: string): Promise<FileImage> => ({
  path,
  mediaType: "image/png",
  size: 3,
  tooLarge: false,
  base64: "cG5n",
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useLayoutStore.setState({ previewFile, openThread });
  document.documentElement.removeAttribute("data-mode");
});

const spyOnLayout = () => {
  const shown = vi.fn();
  const opened = vi.fn();
  useLayoutStore.setState({ previewFile: shown, openThread: opened });
  return { shown, opened };
};

const OPTIONS = [
  {
    label: "A Inbox",
    description: "A restored Inbox",
    image: `${FOLDER}/shots/a-inbox-dark.png`,
    preview: `${FOLDER}/v1.html#a-inbox`,
  },
  { label: "B Jump", description: "A popover" },
  {
    label: "C Hybrid",
    image: `${FOLDER}/shots/c-popover-dark.png`,
    preview: `${FOLDER}/v1.html#C Hybrid · popover`,
  },
];

describe("OptionGallery", () => {
  it("shows each option's screenshot by file name only, and nothing for one without", async () => {
    renderWithApi(<OptionGallery threadId={T} options={OPTIONS} recommended="C Hybrid" />, {
      fsImage,
    });
    const tiles = screen.getAllByTestId("option-visual");
    expect(tiles.map((tile) => tile.dataset["option"])).toEqual(["A Inbox", "C Hybrid"]);
    expect(await screen.findByRole("img", { name: "C Hybrid · c-popover-dark.png" })).toBeTruthy();
    expect(fsImage).toHaveBeenCalledWith(`${FOLDER}/shots/a-inbox-dark.png`, { threadId: T });
    expect(screen.getByTestId("option-gallery").textContent).not.toContain(FOLDER);
    expect(screen.getByText("(recommended)")).toBeTruthy();
  });

  it("enlarges a screenshot in the lightbox on a click", async () => {
    renderWithApi(<OptionGallery threadId={T} options={OPTIONS} />, { fsImage });
    fireEvent.click(await screen.findByRole("button", { name: "Open A Inbox · a-inbox-dark.png" }));
    expect((await screen.findByTestId("attachment-lightbox")).textContent).toContain(
      "A Inbox · a-inbox-dark.png",
    );
  });

  it("opens the asking thread's Preview at the option's board, by the kit's id for it", () => {
    const { shown, opened } = spyOnLayout();
    renderWithApi(<OptionGallery threadId={T} options={OPTIONS} />, { fsImage });
    fireEvent.click(screen.getByRole("button", { name: "Open mock: C Hybrid" }));
    expect(opened).toHaveBeenCalledWith(T);
    expect(navigate).toHaveBeenCalledWith({ to: "/t/$threadId", params: { threadId: T } });
    expect(shown).toHaveBeenCalledWith(T, `${FOLDER}/v1.html#c-hybrid-popover`, {
      previewPane: expect.any(Boolean),
      thread: true,
    });
  });

  it("opens the current version mock.json names with Open mocks", async () => {
    const { shown } = spyOnLayout();
    const fsFile = vi.fn(async (path: string) => ({
      path,
      size: 10,
      binary: false,
      tooLarge: false,
      content: JSON.stringify({
        current: 2,
        versions: [
          { n: 1, file: "v1.html" },
          { n: 2, file: "v2.html" },
        ],
      }),
    }));
    renderWithApi(<OptionGallery threadId={T} options={[]} mock={`${FOLDER}/mock.json`} />, {
      fsImage,
      fsFile,
    });
    const open = screen.getByTestId("question-open-mocks");
    expect(open.textContent).toBe("Open mocks");
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(open);
    expect(shown).toHaveBeenCalledWith(T, `${FOLDER}/v2.html`, expect.anything());
  });

  it("is nothing for a question without pictures", () => {
    renderWithApi(<OptionGallery threadId={T} options={[{ label: "Yes" }, { label: "No" }]} />, {
      fsImage,
    });
    expect(screen.queryByTestId("option-gallery")).toBeNull();
  });

  it("says a screenshot the server refuses can't be shown, by name", async () => {
    const refused = vi.fn(async () => {
      throw Object.assign(new Error("outside"), { _tag: "InvalidState" });
    });
    renderWithApi(<OptionGallery threadId={T} options={OPTIONS.slice(0, 1)} />, {
      fsImage: refused,
    });
    expect((await screen.findByTestId("mock-thumb-missing")).textContent).toBe(
      "a-inbox-dark.png can't be shown",
    );
  });
});

const CARD: MockCardData = {
  title: "Needs you home",
  status: "approved",
  version: 1,
  approved: 1,
  page: `${FOLDER}/v1.html`,
  record: `${FOLDER}/mock.json`,
  directions: [
    {
      name: "A inbox",
      shots: {
        dark: `${FOLDER}/shots/a-inbox-dark.png`,
        light: `${FOLDER}/shots/a-inbox-light.png`,
      },
    },
    {
      name: "C popover",
      board: "c-hybrid-popover",
      shots: { dark: `${FOLDER}/shots/c-popover-dark.png` },
    },
  ],
};

describe("MockCard", () => {
  it("shows the title, version and status, and the shots in the app's mode first", async () => {
    document.documentElement.setAttribute("data-mode", "light");
    renderWithApi(<MockCard threadId={T} mock={CARD} />, { fsImage });
    const card = screen.getByTestId("mock-card");
    expect(screen.getByRole("heading", { name: "Needs you home" })).toBeTruthy();
    expect(screen.getByTestId("mock-version").textContent).toBe("v1");
    expect(screen.getByTestId("mock-status").textContent).toBe("Approved");
    expect(card.dataset["shots"]).toBe("light");
    expect(await screen.findByRole("img", { name: "A inbox · a-inbox-light.png" })).toBeTruthy();
    // A direction with only a dark shot shows that one.
    expect(await screen.findByRole("img", { name: "C popover · c-popover-dark.png" })).toBeTruthy();
    expect(card.textContent).toContain("v1.html");
    expect(card.textContent).not.toContain(FOLDER);
  });

  it("switches dark and light, and opens in Preview in the theme it shows", async () => {
    const { shown } = spyOnLayout();
    renderWithApi(<MockCard threadId={T} mock={CARD} />, { fsImage });
    expect(await screen.findByRole("img", { name: "A inbox · a-inbox-dark.png" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "light" }));
    expect(screen.getByRole("button", { name: "light" }).getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByRole("img", { name: "A inbox · a-inbox-light.png" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("mock-open-preview"));
    expect(shown).toHaveBeenLastCalledWith(T, `${FOLDER}/v1.html`, {
      previewPane: expect.any(Boolean),
      thread: true,
      theme: "light",
    });
    fireEvent.click(screen.getByRole("button", { name: "Open C popover in Preview" }));
    expect(shown).toHaveBeenLastCalledWith(T, `${FOLDER}/v1.html#c-hybrid-popover`, {
      previewPane: expect.any(Boolean),
      thread: true,
      theme: "light",
    });
  });

  it("has no theme switch when no direction has both shots", () => {
    renderWithApi(<MockCard threadId={T} mock={{ ...CARD, directions: [CARD.directions[1]!] }} />, {
      fsImage,
    });
    expect(screen.queryByRole("group", { name: "Screenshots" })).toBeNull();
  });
});

describe("previewFile with a board and a theme", () => {
  it("asks the server for the page alone and keeps its board and theme for the address", () => {
    const threadId = "t-preview-at" as ThreadId;
    useLayoutStore.getState().previewFile(threadId, `${FOLDER}/v1.html#c-hybrid-popover`, {
      previewPane: true,
      theme: "dark",
    });
    expect(useLayoutStore.getState().previewPages[threadId]).toMatchObject({
      file: `${FOLDER}/v1.html`,
      at: "?theme=dark#c-hybrid-popover",
    });
    // Markdown has no board: the fragment is dropped, as the Files panel drops it.
    useLayoutStore.getState().previewFile(threadId, `${FOLDER}/brief.md#open-questions`, {
      previewPane: true,
    });
    const page = useLayoutStore.getState().previewPages[threadId];
    expect(page?.file).toBe(`${FOLDER}/brief.md`);
    expect(page?.at).toBeUndefined();
  });
});
