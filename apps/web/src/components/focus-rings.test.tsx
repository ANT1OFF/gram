// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AttachmentChips } from "@/composer/attachment-chips";
import { Toasts } from "@/shell/toasts";
import { useThreadsStore } from "@/stores/threads";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ notifications: [] });
});

/** A keyboard focus ring from the theme's focus token, which the contrast matrix checks. */
const hasRing = (element: Element) =>
  /\bfocus-visible:ring-(2|3)\b/.test(element.className) &&
  /\bfocus-visible:ring-ring\b/.test(element.className);

describe("focus rings", () => {
  it("marks keyboard focus on an attachment's Remove button", () => {
    render(
      <AttachmentChips
        items={[{ key: "a", name: "notes.md", status: "ready" }]}
        onRemove={() => {}}
      />,
    );
    expect(hasRing(screen.getByRole("button", { name: "Remove notes.md" }))).toBe(true);
  });

  it("marks keyboard focus on a toast's buttons", () => {
    render(<Toasts />);
    act(() =>
      useThreadsStore.getState().applyEvent({
        type: "notify",
        kind: "info",
        title: "Saved",
        body: "",
        threadId: "t1" as ThreadId,
      }),
    );
    const buttons = screen.getByTestId("toast").querySelectorAll("button");
    expect([...buttons].every(hasRing)).toBe(true);
  });
});
