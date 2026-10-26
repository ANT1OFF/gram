// @vitest-environment happy-dom
import { serializeHumanReviewNotice, serializeReviewNotice } from "@gram/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { mockHumanReviewNotice, mockReviewNotice } from "@/api/mock-babysit";

import { HumanReviewNoticeCard, ReviewNoticeCard } from "./review-notice-card";

afterEach(cleanup);

describe("ReviewNoticeCard", () => {
  it("shows the round, verdict, merge state and failing checks", () => {
    const notice = mockReviewNotice(412);
    render(<ReviewNoticeCard notice={notice} text={serializeReviewNotice(notice)} />);
    const card = screen.getByRole("article", { name: "Review update on #412" });
    expect(within(card).getByText("Round 3")).toBeTruthy();
    expect(within(card).getByTestId("notice-verdict").textContent).toBe("Changes requested");
    expect(card.textContent).toContain("Merge state BLOCKED");
    expect(
      within(within(card).getByRole("list", { name: "Failing checks" })).getByText(
        "Failing: test (windows)",
      ),
    ).toBeTruthy();
  });

  it("lists blockers and suggestions with linked locations", () => {
    const notice = mockReviewNotice(412);
    render(<ReviewNoticeCard notice={notice} text="" />);
    const blockers = screen.getByRole("region", { name: "Blockers" });
    expect(within(blockers).getByText("Blockers (1)")).toBeTruthy();
    expect(
      within(blockers).getByRole("link", { name: "src/retry.ts:42" }).getAttribute("href"),
    ).toBe("https://github.com/example/api/pull/412#discussion_PRRC_1");
    expect(within(blockers).getByText(/swallows the last error/)).toBeTruthy();
    const suggestions = screen.getByRole("region", { name: "Suggestions" });
    expect(within(suggestions).getByText("src/retry.test.ts:18")).toBeTruthy();
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
    expect(screen.getByTestId("notice-verdict").textContent).toBe("No verdict yet");
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
    const card = screen.getByRole("article", { name: "Review from a person on #412" });
    const [first, second] = within(card).getAllByRole("listitem");
    expect(first?.textContent).toContain("octocat");
    expect(within(first!).getByTestId("notice-verdict").textContent).toBe("Changes requested");
    expect(within(first!).getByText("New")).toBeTruthy();
    expect(first?.textContent).toContain("needs a test for the last attempt");
    expect(within(second!).getByTestId("notice-verdict").textContent).toBe("Approved");
    expect(within(second!).queryByText("New")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Text sent to the agent" }));
    expect((await screen.findByTestId("notice-text")).textContent).toBe(text);
  });
});
