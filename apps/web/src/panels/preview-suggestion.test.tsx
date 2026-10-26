// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LinkQuestion } from "@/links/link-dialog";
import { useLayoutStore } from "@/stores/layout";

import { PreviewSuggestionNotice } from "./preview-suggestion";

const T = "t-flaky" as ThreadId;

const suggest = (target: string, threadId = T) =>
  act(() =>
    useLayoutStore.getState().requestPanel({ threadId, panel: "preview", target }, threadId),
  );

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "gram");
  useLayoutStore.setState({ previewSuggestion: undefined });
});

describe("PreviewSuggestionNotice", () => {
  it("offers a loopback URL and opens it only when clicked and confirmed", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <>
        <PreviewSuggestionNotice threadId={T} />
        <LinkQuestion />
      </>,
    );
    suggest("http://127.0.0.1:5173/dashboard");

    const notice = screen.getByTestId("preview-suggestion");
    expect(notice.textContent).toContain(
      "Agent suggests previewing http://127.0.0.1:5173/dashboard",
    );
    expect(open).not.toHaveBeenCalled();

    // In a browser the page asks first, as for any link the agent wrote.
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Open link" }));
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith("http://127.0.0.1:5173/dashboard", "_blank", "noopener"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss preview suggestion" }));
    expect(screen.queryByTestId("preview-suggestion")).toBeNull();
  });

  it("opens through the desktop bridge when present", () => {
    const openExternal = vi.fn(async () => true);
    Object.defineProperty(window, "gram", { value: { openExternal }, configurable: true });
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<PreviewSuggestionNotice threadId={T} />);
    suggest("http://[::1]:8080/");

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(openExternal).toHaveBeenCalledWith("http://[::1]:8080/");
    expect(open).not.toHaveBeenCalled();
  });

  it("shows nothing for a non-loopback URL or another thread's suggestion", () => {
    render(<PreviewSuggestionNotice threadId={T} />);
    suggest("https://organization.example.invalid/");
    suggest("http://organization.example.invalid:3000/");
    expect(screen.queryByTestId("preview-suggestion")).toBeNull();

    suggest("http://localhost:3000/", "t-other" as ThreadId);
    expect(useLayoutStore.getState().previewSuggestion).toBeDefined();
    expect(screen.queryByTestId("preview-suggestion")).toBeNull();
  });
});
