// @vitest-environment happy-dom
/* oxlint-disable anti-slop/no-module-mocking -- a throwing ./markdown is a lost streamdown chunk */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEXT = "Use **bold** and `code`.";

// Each test loads the modules afresh, so the loader starts with nothing loaded.
const freshModules = async () => {
  const { MessageResponse } = await import("./message");
  const { loadMarkdown } = await import("./markdown-loader");
  return { MessageResponse, loadMarkdown };
};

/** What the browser says of the window's connection, which the slow-link check reads. */
const overLink = (effectiveType: string) =>
  Object.defineProperty(navigator, "connection", { value: { effectiveType }, configurable: true });

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  cleanup();
  vi.doUnmock("./markdown");
  Reflect.deleteProperty(navigator, "connection");
});

describe("MessageResponse while streamdown loads", () => {
  it("keeps the text's place unseen, then renders it as markdown", async () => {
    const { MessageResponse } = await freshModules();
    const { container } = render(<MessageResponse mode="static">{TEXT}</MessageResponse>);

    const pending = screen.getByTestId("markdown-pending");
    expect(pending.className).toContain("invisible");
    expect(pending.getAttribute("aria-busy")).toBe("true");
    expect(pending.textContent).toBe(TEXT);

    const bold = await screen.findByText("bold");
    expect(bold.closest("strong, [data-streamdown='strong']")).not.toBeNull();
    expect(screen.queryByTestId("markdown-pending")).toBeNull();
    expect(container.textContent).not.toContain("**");
  });

  it("renders at once when streamdown loaded first, as the shell's preload does", async () => {
    const { MessageResponse, loadMarkdown } = await freshModules();
    await loadMarkdown();
    render(<MessageResponse mode="static">{TEXT}</MessageResponse>);
    expect(screen.queryByTestId("markdown-pending")).toBeNull();
    expect(screen.getByText("bold")).toBeTruthy();
  });

  it("shows the text plain when streamdown can't be loaded", async () => {
    vi.doMock("./markdown", () => {
      throw new Error("chunk gone");
    });
    const { MessageResponse, loadMarkdown } = await freshModules();
    render(<MessageResponse mode="static">{TEXT}</MessageResponse>);
    await expect(loadMarkdown()).rejects.toThrow();

    const pending = await screen.findByTestId("markdown-pending");
    await vi.waitFor(() => expect(pending.className).not.toContain("invisible"));
    expect(pending.getAttribute("aria-busy")).toBeNull();
    expect(pending.textContent).toBe(TEXT);
  });

  it("shows the text plain over a slow link while streamdown loads, then as markdown", async () => {
    overLink("2g");
    const { MessageResponse } = await freshModules();
    const { container } = render(<MessageResponse mode="static">{TEXT}</MessageResponse>);

    const pending = screen.getByTestId("markdown-pending");
    expect(pending.className).not.toContain("invisible");
    expect(pending.getAttribute("aria-busy")).toBeNull();
    expect(pending.textContent).toBe(TEXT);

    await screen.findByText("bold");
    expect(screen.queryByTestId("markdown-pending")).toBeNull();
    expect(container.textContent).not.toContain("**");
  });
});
