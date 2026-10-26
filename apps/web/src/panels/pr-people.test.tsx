// @vitest-environment happy-dom
import type { PrDetail, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockPrDetail } from "@/api/mock-git";

import { PrPeople, PrReviewers, reviewerRoster, splitNames } from "./pr-people";
import { renderWithApi } from "./test-utils";

const T = "t-flaky" as ThreadId;
const detail = mockPrDetail(T).detail!;

const withPeople = (people: Pick<PrDetail, "reviewRequests" | "latestReviews">): PrDetail => ({
  ...detail,
  ...people,
});

afterEach(cleanup);

describe("reviewerRoster", () => {
  it("lists requested reviewers first, folding in an earlier verdict", () => {
    const roster = reviewerRoster(
      withPeople({
        reviewRequests: [
          { kind: "user", name: "Maria" },
          { kind: "team", name: "example/platform" },
        ],
        latestReviews: [
          { author: "maria", state: "APPROVED", at: "a" },
          { author: "sam", state: "CHANGES_REQUESTED", at: "b" },
          { author: detail.author, state: "COMMENTED", at: "c" },
        ],
      }),
    );
    expect(roster.map((r) => [r.name, r.team, r.state.label])).toEqual([
      ["Maria", false, "Review requested, previously approved"],
      ["example/platform", true, "Review requested"],
      ["sam", false, "Changes requested"],
    ]);
  });

  it("is empty for a PR from a server that doesn't report reviewers", () => {
    const { reviewRequests, latestReviews, ...rest } = detail;
    void reviewRequests;
    void latestReviews;
    expect(reviewerRoster(rest)).toEqual([]);
  });
});

describe("PrReviewers", () => {
  it("names each verdict in text, not only by colour", () => {
    render(<PrReviewers detail={detail} />);
    const list = screen.getByRole("list", { name: "Reviewers" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "maria: Review requested",
      "example/platform (team): Review requested",
      "reviewer: Changes requested",
      "ci-bot: Commented",
    ]);
    expect(items[2]!.getAttribute("title")).toBe("reviewer: Changes requested");
  });

  it("shows nothing when nobody is asked or has reviewed", () => {
    render(<PrReviewers detail={withPeople({ reviewRequests: [], latestReviews: [] })} />);
    expect(screen.getByTestId("pr-reviewers").textContent).toBe("");
  });
});

describe("PrPeople", () => {
  it("splits typed names on commas and spaces", () => {
    expect(splitNames("@maria, example/platform  sam,")).toEqual([
      "maria",
      "example/platform",
      "sam",
    ]);
  });

  it("requests a review from typed and suggested names, skipping who's already asked", async () => {
    const prRequestReview = vi.fn(async (_: ThreadId, reviewers: readonly string[]) => ({
      reviewers: [...reviewers],
    }));
    const prReviewerSuggestions = vi.fn(async () => ({ logins: ["maria", "sam", "samir"] }));
    renderWithApi(<PrPeople threadId={T} detail={detail} />, {
      prRequestReview,
      prReviewerSuggestions,
    });

    fireEvent.click(screen.getByRole("button", { name: "Request review…" }));
    const suggested = await screen.findByRole("list", { name: "Suggested reviewers" });
    expect(
      within(suggested)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["sam", "samir"]);

    fireEvent.change(screen.getByLabelText("Logins or teams to ask"), {
      target: { value: "priya, sami" },
    });
    fireEvent.click(within(suggested).getByRole("button", { name: "samir" }));
    expect((screen.getByLabelText("Logins or teams to ask") as HTMLInputElement).value).toBe(
      "priya, samir, ",
    );

    fireEvent.click(screen.getByRole("button", { name: "Request" }));
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "Asked priya, samir to review",
    );
    expect(prRequestReview).toHaveBeenCalledWith(T, ["priya", "samir"]);
    expect(screen.queryByLabelText("Logins or teams to ask")).toBeNull();
  });

  it("keeps the form open and says why when GitHub refuses", async () => {
    renderWithApi(<PrPeople threadId={T} detail={detail} />, {
      prRequestReview: vi.fn(async () => {
        throw new Error("could not request reviewer: ghost");
      }),
      prReviewerSuggestions: vi.fn(async () => ({ logins: [] })),
    });
    fireEvent.click(screen.getByRole("button", { name: "Request review…" }));
    fireEvent.change(screen.getByLabelText("Logins or teams to ask"), {
      target: { value: "ghost" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("could not request reviewer"),
    );
    expect(screen.getByLabelText("Logins or teams to ask")).toBeTruthy();
  });

  it("returns focus to Request review… when the form closes on Escape", async () => {
    renderWithApi(<PrPeople threadId={T} detail={detail} />, {
      prReviewerSuggestions: vi.fn(async () => ({ logins: [] })),
    });
    screen.getByRole("button", { name: "Request review…" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Request review…" }));
    fireEvent.keyDown(screen.getByLabelText("Logins or teams to ask"), { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Request review…" })),
    );
  });
});
