// @vitest-environment happy-dom
import { serializeHumanReviewNotice, serializeReviewNotice } from "@gram/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { mockHumanReviewNotice, mockReviewNotice } from "@/api/mock-babysit";

import { HumanReviewNoticeCard, ReviewNoticeCard } from "./review-notice-card";

afterEach(cleanup);

describe("ReviewNoticeCard", () => {
  it("shows the round, verdict, merge state and failing checks", () => {
    const notice = { ...mockReviewNotice(412), round: 17 };
    render(<ReviewNoticeCard notice={notice} text={serializeReviewNotice(notice)} />);
    const card = screen.getByRole("article", { name: /#412/ });
    expect(card.textContent).toContain("17");
    expect(within(card).getByTestId("notice-verdict").dataset.verdict).toBe("changesRequested");
    expect(card.textContent).toContain(notice.mergeState);
    const checks = within(card).getByRole("list", { name: "Failing checks" });
    expect(
      within(checks)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining("test (windows)")]);
  });

  it("lists blockers and suggestions with linked locations", () => {
    const notice = mockReviewNotice(412);
    render(<ReviewNoticeCard notice={notice} text="" />);
    const blockers = screen.getByRole("region", { name: "Blockers" });
    expect(within(blockers).getAllByRole("listitem")).toHaveLength(1);
    expect(
      within(blockers).getByRole("link", { name: "src/retry.ts:42" }).getAttribute("href"),
    ).toBe("https://github.com/example/api/pull/412#discussion_PRRC_1");
    // The finding's body, from the bot's review.
    expect(blockers.textContent).toContain("swallows the last error");
    expect(screen.getByRole("region", { name: "Suggestions" })).toBeTruthy();
  });

  it("says when there is no verdict and renders unlinked findings as text", () => {
    render(
      <ReviewNoticeCard
        notice={{
          kind: "review",
          number: 7,
          blockers: [],
          suggestions: [{ reviewThreadId: "t1", path: "a.ts", body: "  Tidy\n this. " }],
          ciFailed: [],
        }}
        text=""
      />,
    );
    expect(screen.getByTestId("notice-verdict").dataset.verdict).toBe("none");
    expect(screen.queryByRole("region", { name: "Blockers" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Failing checks" })).toBeNull();
    const suggestions = screen.getByRole("region", { name: "Suggestions" });
    expect(within(suggestions).queryByRole("link")).toBeNull();
    expect(within(suggestions).getByText("Tidy this.")).toBeTruthy();
  });

  it("reveals the exact text sent to the agent", async () => {
    const notice = mockReviewNotice(412);
    const text = serializeReviewNotice(notice);
    render(<ReviewNoticeCard notice={notice} text={text} />);
    expect(screen.queryByTestId("notice-text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Text sent to the agent" }));
    expect((await screen.findByTestId("notice-text")).textContent).toBe(text);
  });
});

describe("HumanReviewNoticeCard", () => {
  it("lists each person's verdict, marks the new one, and keeps the agent's text", async () => {
    const notice = mockHumanReviewNotice(412);
    const text = serializeHumanReviewNotice(notice);
    render(<HumanReviewNoticeCard notice={notice} text={text} />);
    const card = screen.getByRole("article", { name: /#412/ });
    const [first, second] = within(card).getAllByRole("listitem");
    expect(first?.textContent).toContain("octocat");
    expect(within(first!).getByTestId("notice-verdict").dataset.verdict).toBe("changesRequested");
    expect(within(first!).getByText("New")).toBeTruthy();
    expect(within(second!).getByTestId("notice-verdict").dataset.verdict).toBe("approved");
    expect(within(second!).queryByText("New")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Text sent to the agent" }));
    expect((await screen.findByTestId("notice-text")).textContent).toBe(text);
  });
});
