// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useDraftStore } from "@/stores/drafts";
import { useThreadsStore } from "@/stores/threads";

import { Composer } from "./composer";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));

const THREAD = "t-flaky" as ThreadId;
const ROOT = "/Users/dev/code/api/.worktrees/fix-flaky-retry";

const setup = () => {
  useThreadsStore.setState({
    byId: {
      [THREAD]: { status: "idle", thread: { id: THREAD, checkout: { path: ROOT } } },
    } as never,
  });
  const api = createMockApi({ speed: 0, autoplay: false });
  const fsFiles = vi.spyOn(api, "fsFiles");
  renderWithApi(<Composer threadId={THREAD} focused />, api);
  const composer = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
  return { composer, fsFiles, user: userEvent.setup() };
};

const files = () => screen.queryByRole("listbox", { name: "Files" });
const offered = () =>
  within(screen.getByRole("listbox", { name: "Files" }))
    .getAllByRole("option")
    .map((option) => option.getAttribute("aria-label"));

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
  useDraftStore.setState({ text: {} });
});

describe("Composer @ mentions", () => {
  it("offers the checkout's top level on @, folders first, without git-ignored folders", async () => {
    const { composer, fsFiles, user } = setup();
    await user.click(composer);
    await user.type(composer, "look at @");
    await waitFor(() => expect(files()).not.toBeNull());
    expect(offered()).toEqual([
      ".github/",
      "docs/",
      "fixtures/",
      "src/",
      ".env.example",
      ".gitignore",
      "latest",
      "package.json",
      "README.md",
    ]);
    expect(fsFiles).toHaveBeenCalledWith({ threadId: THREAD });
    expect(composer.getAttribute("aria-controls")).toBe(`mention-menu-${THREAD}`);
  });

  it("filters as you type and inserts the chosen file with a space, caret after it", async () => {
    const { composer, user } = setup();
    await user.click(composer);
    await user.type(composer, "why @retry");
    await waitFor(() => expect(offered()[0]).toBe("src/retry.ts"));
    expect(offered()).toContain("src/retry.test.ts");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(composer.value).toBe("why @src/retry.test.ts ");
    expect(composer.selectionStart).toBe(composer.value.length);
    expect(files()).toBeNull();
  });

  it("leaves Enter and the arrows to an input method still composing", async () => {
    const { composer, user } = setup();
    await user.click(composer);
    await user.type(composer, "why @retry");
    await waitFor(() => expect(offered()[0]).toBe("src/retry.ts"));
    // A candidate accepted with Enter, or browsed with ↓, belongs to the input method.
    fireEvent.keyDown(composer, { key: "ArrowDown", isComposing: true });
    fireEvent.keyDown(composer, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(composer.value).toBe("why @retry");
    expect(files()).not.toBeNull();
    // Composition over, Enter picks the first file as before.
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer.value).toBe("why @src/retry.ts ");
  });

  it("keeps a chosen folder open, listing its children", async () => {
    const { composer, user } = setup();
    await user.click(composer);
    await user.type(composer, "@sr");
    await waitFor(() => expect(offered()[0]).toBe("src/"));
    await user.keyboard("{Tab}");
    expect(composer.value).toBe("@src/");
    await waitFor(() =>
      expect(offered()).toEqual([
        "src/clock.ts",
        "src/index.ts",
        "src/retry.test.ts",
        "src/retry.ts",
      ]),
    );
  });

  it("closes on Escape and stays closed for that @, until another one is typed", async () => {
    const { composer, user } = setup();
    await user.click(composer);
    await user.type(composer, "@do");
    await waitFor(() => expect(files()).not.toBeNull());
    await user.keyboard("{Escape}");
    expect(files()).toBeNull();
    await user.type(composer, "cs");
    expect(files()).toBeNull();
    expect(composer.value).toBe("@docs");
    await user.type(composer, " and @src");
    await waitFor(() => expect(offered()[0]).toBe("src/"));
  });

  it("stays shut for an email address, inside a code fence and for pasted text", async () => {
    const { composer, fsFiles, user } = setup();
    await user.click(composer);
    await user.type(composer, "mail me@example");
    expect(files()).toBeNull();

    await user.clear(composer);
    await user.type(composer, "```{Enter}@src");
    expect(files()).toBeNull();

    await user.clear(composer);
    await user.paste("see @src/retry.ts");
    expect(composer.value).toBe("see @src/retry.ts");
    expect(files()).toBeNull();
    expect(fsFiles).not.toHaveBeenCalled();
  });

  it("closes when the composer loses focus", async () => {
    const { composer, user } = setup();
    await user.click(composer);
    await user.type(composer, "@");
    await waitFor(() => expect(files()).not.toBeNull());
    fireEvent.blur(composer);
    expect(files()).toBeNull();
  });
});
