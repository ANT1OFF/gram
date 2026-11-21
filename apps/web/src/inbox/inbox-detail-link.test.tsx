// @vitest-environment happy-dom
import {
  waitViewOf,
  type DesktopBridge,
  type ThreadId,
  type WaitId,
  type WaitItem,
  type WorkspaceId,
} from "@gram/contracts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import type { NeedsYouItem } from "@/orchestration/needs-you-items";
import { renderWithApi } from "@/panels/test-utils";

import { InboxDetail } from "./inbox-detail";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

const T = "t-orc" as ThreadId;
const PR = "https://github.com/example/api/pull/431";

const step = (link: string): NeedsYouItem => {
  const item: WaitItem = {
    id: "w-1" as WaitId,
    kind: "action",
    title: "Merge example/api#431 by hand",
    body: "The merge queue refuses it.",
    link,
    source: "agent",
    createdAt: 0,
  };
  const view = waitViewOf(T, item);
  return {
    key: view.key,
    ids: [view.key],
    kind: "wait",
    title: view.title,
    where: "Orchestrator",
    workspaceId: "w" as WorkspaceId,
    threadId: T,
    owned: true,
    wait: { item, view },
  };
};

let openExternal: ReturnType<typeof vi.fn<(url: string) => Promise<boolean>>>;
beforeEach(() => {
  openExternal = vi.fn(async () => true);
  (window as { gram?: Partial<DesktopBridge> }).gram = { openExternal };
});
afterEach(() => {
  cleanup();
  delete (window as { gram?: unknown }).gram;
});

describe("a step to take with a link", () => {
  it("opens the link in the browser from the header and from the row", () => {
    renderWithApi(<InboxDetail item={step(PR)} now={0} onOpenThread={() => {}} />, createMockApi());
    fireEvent.click(screen.getByTestId("inbox-open-link"));
    expect(openExternal).toHaveBeenCalledWith(PR);
    fireEvent.click(screen.getByTestId("waiting-open"));
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenLastCalledWith(PR);
  });

  it("lets the title be selected without folding the step, and a plain click folds it", () => {
    renderWithApi(<InboxDetail item={step(PR)} now={0} onOpenThread={() => {}} />, createMockApi());
    const toggle = screen.getByTestId("waiting-item-toggle");
    const title = screen.getByText("Merge example/api#431 by hand");
    const range = document.createRange();
    range.selectNodeContents(title);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.click(title);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("waiting-item-detail").textContent).toContain("merge queue");
    window.getSelection()!.removeAllRanges();
    fireEvent.click(title);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("offers no Open for a link that isn't http(s)", () => {
    for (const link of ["javascript:alert(1)", "file:///etc/passwd"]) {
      renderWithApi(
        <InboxDetail item={step(link)} now={0} onOpenThread={() => {}} />,
        createMockApi(),
      );
      expect(screen.queryByTestId("inbox-open-link")).toBeNull();
      expect(screen.queryByTestId("waiting-open")).toBeNull();
      cleanup();
    }
    expect(openExternal).not.toHaveBeenCalled();
  });
});
