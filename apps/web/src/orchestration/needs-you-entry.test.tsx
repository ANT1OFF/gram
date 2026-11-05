// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InboxButton } from "@/inbox/inbox-button";

import { NeedsYouEntry, needsYouScope, needsYouWords } from "./needs-you-entry";

// Round 8: the one way into what needs you read four ways: a "2 need you" pill, a badge on an
// Inbox icon in the title bar, "1 ask" in Quiet and a "?2" chip in an orchestrator's header. It is
// one control now, in one wording, wherever it shows.

const state = { count: 2 };
const openAsks = vi.fn();
const open = vi.fn();
vi.mock("./use-needs-you", () => ({
  useNeedsYou: () => ({ count: state.count, kinds: "", open, label: "Inbox", hint: "⌘⇧I" }),
  useNeedsYouPill: () => ({
    count: state.count,
    kinds: "",
    open,
    label: "Inbox",
    hint: "⌘⇧I",
    scope: "1 in Gram\n1 elsewhere",
    openAsks,
  }),
}));

afterEach(() => {
  cleanup();
  state.count = 2;
  openAsks.mockClear();
  open.mockClear();
});

describe("needsYouWords", () => {
  it("says the count one way", () => {
    expect(needsYouWords(1)).toBe("1 needs you");
    expect(needsYouWords(2)).toBe("2 need you");
    expect(needsYouWords(0)).toBe("Nothing needs you");
    expect(needsYouScope(2, "1 in Gram")).toBe("2 need you across all workspaces\n1 in Gram");
  });
});

describe("the attention entry", () => {
  it("reads the same in the sidebar, the title bar and Quiet, and opens the newest ask", () => {
    render(
      <>
        <NeedsYouEntry variant="row" data-testid="overview-needs-you" />
        <InboxButton />
        <NeedsYouEntry variant="chip" data-testid="quiet-asks" />
      </>,
    );
    for (const id of ["overview-needs-you", "inbox-button", "quiet-asks"]) {
      const entry = screen.getByTestId(id);
      expect(entry.textContent).toBe("2 need you");
      expect(entry.dataset["count"]).toBe("2");
      fireEvent.click(entry);
    }
    expect(openAsks).toHaveBeenCalledTimes(3);
    // No icon with a number on it, no "ask", no "?2".
    expect(document.body.textContent).not.toMatch(/\basks?\b|\?\d/);
  });

  it("leaves the bars a quiet Inbox icon, and the sidebar its grey words, with nothing waiting", () => {
    state.count = 0;
    render(
      <>
        <NeedsYouEntry variant="row" data-testid="overview-needs-you" />
        <InboxButton />
        <NeedsYouEntry variant="chip" data-testid="quiet-asks" />
      </>,
    );
    expect(screen.getByTestId("overview-needs-you").textContent).toBe("Nothing needs you");
    expect(screen.getByTestId("inbox-button").textContent).toBe("");
    expect(screen.getByTestId("inbox-button").getAttribute("aria-label")).toBe("Inbox (⌘⇧I)");
    expect(screen.queryByTestId("quiet-asks")).toBeNull();
  });
});
