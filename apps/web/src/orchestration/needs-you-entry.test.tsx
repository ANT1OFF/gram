// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InboxButton } from "@/inbox/inbox-button";

import {
  NeedsYouEntry,
  needsYouPillWords,
  needsYouScope,
  needsYouSpoken,
  needsYouWords,
} from "./needs-you-entry";

// Round 8: the one way into what needs you read four ways: a "2 need you" pill, a badge on an
// Inbox icon in the title bar, "1 ask" in Quiet and a "?2" chip in an orchestrator's header. It is
// one control now, in one wording, wherever it shows.

const state: { count: number; parts: string[] } = { count: 2, parts: [] };
const openAsks = vi.fn();
const open = vi.fn();
vi.mock("./use-needs-you", () => ({
  useNeedsYou: () => ({
    count: state.count,
    kinds: state.parts.join(", "),
    parts: state.parts,
    open,
    label: "Inbox",
    hint: "⌘⇧I",
  }),
  useNeedsYouPill: () => ({
    count: state.count,
    kinds: state.parts.join(", "),
    parts: state.parts,
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
  state.parts = [];
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

describe("needsYouPillWords", () => {
  // Round 10: the pill said "2 need you" over a Quiet card that said "1 of 1", the second item an
  // error shown nowhere near it. Named by kind, the pill's count is the cards' count.
  it("names the kinds, so the count agrees with the cards", () => {
    expect(needsYouPillWords(2, ["1 question", "1 error"])).toBe("1 question · 1 error");
    expect(needsYouPillWords(1, ["1 approval"])).toBe("1 approval");
    expect(needsYouSpoken(2, ["1 question", "1 error"])).toBe("2 need you: 1 question, 1 error");
  });

  it("says the count alone past two kinds, or with none", () => {
    expect(needsYouPillWords(4, ["1 error", "2 approvals", "1 question"])).toBe("4 need you");
    // A chip in a bar has room for three: Quiet's "1 of 2" card then agrees with its pill.
    expect(needsYouPillWords(3, ["1 error", "1 approval", "1 question"], 3)).toBe(
      "1 error · 1 approval · 1 question",
    );
    expect(needsYouPillWords(5, ["1 error", "2 approvals", "1 question", "1 draft"], 3)).toBe(
      "5 need you",
    );
    expect(needsYouPillWords(0, [])).toBe("Nothing needs you");
    expect(needsYouSpoken(0, [])).toBe("Nothing needs you");
  });
});

describe("the attention entry", () => {
  it("says its kinds in every place it shows", () => {
    state.parts = ["1 question", "1 error"];
    render(
      <>
        <NeedsYouEntry variant="row" data-testid="overview-needs-you" />
        <InboxButton />
      </>,
    );
    for (const id of ["overview-needs-you", "inbox-button"]) {
      const entry = screen.getByTestId(id);
      expect(entry.textContent).toBe("1 question · 1 error");
      expect(entry.getAttribute("aria-label")).toBe("2 need you: 1 question, 1 error (⌘⇧I)");
    }
  });

  it("tints only what asks: an error's words stay muted, and errors alone draw no amber", () => {
    // Round 16: the title bar's "1 error · 1 question" was an amber-outlined pill, a second alarm
    // for the error beside its card and red dot.
    state.parts = ["1 question", "1 error"];
    render(
      <>
        <NeedsYouEntry variant="row" data-testid="row" />
        <InboxButton />
      </>,
    );
    const chip = screen.getByTestId("inbox-button");
    expect(chip.className).not.toMatch(/border-status-needs/);
    for (const entry of [screen.getByTestId("row"), chip]) {
      expect(entry.querySelector(".bg-status-needs-mark")).not.toBeNull();
      expect(within(entry).getByText("1 question").className).toBe("text-status-needs");
      expect(within(entry).getByText("1 error").className).toBe("text-muted-foreground");
    }
    cleanup();

    state.count = 1;
    state.parts = ["1 error"];
    render(
      <>
        <NeedsYouEntry variant="row" data-testid="row" />
        <InboxButton />
      </>,
    );
    for (const entry of [screen.getByTestId("row"), screen.getByTestId("inbox-button")]) {
      expect(entry.textContent).toBe("1 error");
      expect(entry.innerHTML).not.toMatch(/status-needs/);
    }
  });

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
