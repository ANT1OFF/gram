// @vitest-environment happy-dom
import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { memoryAskOf } from "@/orchestration/ask-model";
import type { NeedsYouItem } from "@/orchestration/needs-you-items";
import { renderWithApi } from "@/panels/test-utils";

import { InboxDetail } from "./inbox-detail";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

afterEach(cleanup);

const W = "w" as WorkspaceId;

/** The orchestrator's question Q1, reading `text`: the same key whatever it reads. */
const question = (text: string): NeedsYouItem => {
  const ask = memoryAskOf(
    W,
    { id: "Q1", text, detail: undefined, open: true, options: [{ label: "Yes" }, { label: "No" }] },
    "t-orc" as ThreadId,
  );
  return {
    key: ask.key,
    ids: ask.ids,
    kind: "question",
    title: text,
    where: "Orchestrator",
    workspaceId: W,
    threadId: "t-orc" as ThreadId,
    owned: true,
    ask,
  };
};

describe("the Inbox's ask", () => {
  it("starts afresh when another request comes where the one shown was, under the same key", () => {
    const first = question("Ship the form first?");
    const other = question("Delete the old forms?");
    expect(other.key).toBe(first.key);
    function Shown() {
      const [item, setItem] = useState(first);
      return (
        <>
          <button type="button" data-testid="swap" onClick={() => setItem(other)} />
          <InboxDetail item={item} now={0} onOpenThread={() => {}} />
        </>
      );
    }
    renderWithApi(<Shown />, createMockApi());
    fireEvent.click(screen.getByTestId("inbox-read-full"));
    expect(screen.getByTestId("inbox-ask").dataset["full"]).toBe("true");
    // Read in full, a key in the moment after the swap would answer what the person never read.
    fireEvent.click(screen.getByTestId("swap"));
    expect(screen.getByTestId("inbox-ask").textContent).toContain("Delete the old forms?");
    expect(screen.getByTestId("inbox-ask").dataset["full"]).toBeUndefined();
  });
});
