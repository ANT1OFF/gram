// @vitest-environment happy-dom
import { NotImplemented, type PrReview, type ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MockReviews } from "@/api/mock-review";

import { renderWithApi } from "../test-utils";
import { ReviewTab } from "./review-tab";

const T = "t-flaky" as ThreadId;

function reviewApi() {
  const reviews = new MockReviews();
  return {
    prReview: vi.fn(async () => reviews.review(T)),
    prApplySuggestion: vi.fn(async (_: ThreadId, commentId: string) =>
      reviews.applySuggestion(T, commentId),
    ),
    prReplyThread: vi.fn(async (_: ThreadId, id: string, body: string) =>
      reviews.reply(T, id, body),
    ),
    prResolveThread: vi.fn(async (_: ThreadId, id: string) => reviews.resolve(T, id)),
    prRequestRereview: vi.fn(async () => ({ command: "/agent review" })),
    send: vi.fn(async () => ({ queued: true })),
  };
}

const withReview = (review: PrReview) => ({ prReview: vi.fn(async () => review) });

const card = (name: string) => screen.getByRole("article", { name });

afterEach(cleanup);

describe("ReviewTab", () => {
  it("shows the verdict banner with meta and counts", async () => {
    renderWithApi(<ReviewTab threadId={T} />, reviewApi());
    const banner = await screen.findByTestId("review-verdict");
    expect(banner.textContent).toContain("Changes requested");
    expect(banner.textContent).toContain("On head");
    expect(banner.textContent).toContain("openai/gpt-5.6-sol");
    expect(banner.textContent).toContain("scope: interdiff");
    expect(within(banner).getByTestId("review-counts").textContent).toBe(
      "2 blockers · 2 suggestions · 5 unresolved",
    );
    expect(within(banner).getByText(/two blockers remain/)).toBeTruthy();
  });

  it("shows a person's thread as a reviewer finding, counted apart from the bot's", async () => {
    const review = new MockReviews().review(T);
    const human = {
      id: "PRRT_person",
      path: "src/retry.ts",
      line: 3,
      isResolved: false,
      isOutdated: false,
      severity: "finding" as const,
      byBot: false,
      comments: [
        {
          id: "PRRC_person",
          author: "octocat",
          body: "Why three attempts?",
          createdAt: "2026-09-16T11:30:00Z",
          url: "https://github.com/example/api/pull/412#discussion_person",
        },
      ],
    };
    renderWithApi(
      <ReviewTab threadId={T} />,
      withReview({
        ...review,
        threads: [...review.threads, human],
        state: { ...review.state!, threads: { ...review.state!.threads, humanUnresolved: 1 } },
      }),
    );
    const banner = await screen.findByTestId("review-verdict");
    expect(within(banner).getByTestId("review-counts").textContent).toBe(
      "2 blockers · 2 suggestions · 5 unresolved · 1 reviewer thread",
    );
    const reviewer = card("Reviewer: src/retry.ts:3");
    expect(reviewer.dataset["byBot"]).toBe("false");
    expect(reviewer.textContent).toContain("octocat");
  });

  it("groups unresolved threads by file, blockers first, with outdated and resolved collapsed", async () => {
    renderWithApi(<ReviewTab threadId={T} />, reviewApi());
    const files = await screen.findAllByTestId("review-file");
    expect(files.map((f) => f.getAttribute("aria-label"))).toEqual([
      "src/retry.test.ts",
      "src/retry.ts",
    ]);
    expect(
      within(files[1]!)
        .getAllByTestId("review-thread")
        .map((t) => t.getAttribute("data-severity")),
    ).toEqual(["blocker", "finding"]);

    expect(screen.queryByRole("article", { name: "Suggestion: src/retry.test.ts" })).toBeNull();
    fireEvent.click(within(files[0]!).getByRole("button", { name: "Outdated (1)" }));
    const outdated = await screen.findByRole("article", { name: "Suggestion: src/retry.test.ts" });
    expect(within(outdated).getByText("Suggests deleting these lines")).toBeTruthy();
    expect(within(outdated).queryByRole("button", { name: "Apply suggestion" })).toBeNull();

    expect(screen.queryByText(/Jitter uses/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resolved (1)" }));
    expect(await screen.findByText(/Jitter uses/)).toBeTruthy();
  });

  it("applies a suggestion only where the first bot comment has one", async () => {
    const api = reviewApi();
    renderWithApi(<ReviewTab threadId={T} />, api);
    await screen.findByTestId("review-verdict");
    expect(
      within(card("Blocker: src/retry.ts:38-42")).queryByRole("button", {
        name: "Apply suggestion",
      }),
    ).toBeNull();

    const blocker = card("Blocker: src/retry.test.ts:13");
    fireEvent.click(within(blocker).getByRole("button", { name: "Apply suggestion" }));
    expect(
      await within(blocker).findByText("Applied to src/retry.test.ts:13-13 (not committed)"),
    ).toBeTruthy();
    expect(api.prApplySuggestion).toHaveBeenCalledWith(T, "PRRC_2");
  });

  it("asks the agent to address a finding with a structured message", async () => {
    const api = reviewApi();
    renderWithApi(<ReviewTab threadId={T} />, api);
    await screen.findByTestId("review-verdict");
    const blocker = card("Blocker: src/retry.ts:38-42");
    fireEvent.click(within(blocker).getByRole("button", { name: "Ask agent to address" }));
    expect(await within(blocker).findByText("Queued for the agent")).toBeTruthy();
    expect(api.send).toHaveBeenCalledWith(T, {
      text: expect.stringMatching(
        /^Address review finding on PR #412 — `src\/retry.ts:38-42` \[blocker\]:\n\n> `retry` swallows/,
      ),
    });
  });

  it("replies in a thread and shows the reply after refetching", async () => {
    const api = reviewApi();
    renderWithApi(<ReviewTab threadId={T} />, api);
    await screen.findByTestId("review-verdict");
    const finding = card("Finding: src/retry.ts:8");
    fireEvent.click(within(finding).getByRole("button", { name: "Reply…" }));
    fireEvent.change(within(finding).getByRole("textbox", { name: "Reply" }), {
      target: { value: "Renamed to baseDelayMs in 1a2b3c4." },
    });
    fireEvent.click(within(finding).getByRole("button", { name: "Send reply" }));

    await waitFor(() =>
      expect(api.prReplyThread).toHaveBeenCalledWith(
        T,
        "PRRT_backoff_name",
        "Renamed to baseDelayMs in 1a2b3c4.",
      ),
    );
    expect(await screen.findByText("Renamed to baseDelayMs in 1a2b3c4.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
  });

  it("resolves a thread, moving it to the resolved group", async () => {
    const api = reviewApi();
    renderWithApi(<ReviewTab threadId={T} />, api);
    await screen.findByTestId("review-verdict");
    fireEvent.click(
      within(card("Finding: src/retry.ts:8")).getByRole("button", { name: "Resolve" }),
    );
    expect(await screen.findByRole("button", { name: "Resolved (2)" })).toBeTruthy();
    expect(api.prResolveThread).toHaveBeenCalledWith(T, "PRRT_backoff_name");
    expect(screen.queryByRole("article", { name: "Finding: src/retry.ts:8" })).toBeNull();
  });

  it("addresses all blockers in one message and requests a re-review", async () => {
    const api = reviewApi();
    renderWithApi(<ReviewTab threadId={T} />, api);
    const banner = await screen.findByTestId("review-verdict");

    fireEvent.click(within(banner).getByRole("button", { name: "Address all blockers" }));
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
    const text = (api.send.mock.calls[0] as unknown as [ThreadId, { text: string }])[1].text;
    expect(text).toMatch(/^Address all 2 review blockers on PR #412:/);
    expect(text).toContain("`src/retry.ts:38-42`");
    expect(text).toContain("`src/retry.test.ts:13`");

    fireEvent.click(within(banner).getByRole("button", { name: "Request re-review" }));
    expect(await within(banner).findByText("Posted /agent review")).toBeTruthy();
    expect(api.prRequestRereview).toHaveBeenCalledWith(T);
  });

  it("shows an action's error on its card", async () => {
    const api = {
      ...reviewApi(),
      prResolveThread: vi.fn(async () => {
        throw new Error("gh: Resource not accessible by integration");
      }),
    };
    renderWithApi(<ReviewTab threadId={T} />, api);
    await screen.findByTestId("review-verdict");
    const finding = card("Finding: src/retry.ts:8");
    fireEvent.click(within(finding).getByRole("button", { name: "Resolve" }));
    expect((await within(finding).findByRole("alert")).textContent).toBe(
      "gh: Resource not accessible by integration",
    );
  });

  it("explains a missing GitHub CLI, a branch without a PR, and a PR without a bot review", async () => {
    const { unmount } = renderWithApi(
      <ReviewTab threadId={T} />,
      withReview({ available: false, threads: [] }),
    );
    expect(await screen.findByText("GitHub CLI not available or logged out")).toBeTruthy();
    unmount();

    const noPr = renderWithApi(
      <ReviewTab threadId={T} />,
      withReview({ available: true, threads: [] }),
    );
    expect(await screen.findByText("No PR for this branch")).toBeTruthy();
    noPr.unmount();

    renderWithApi(
      <ReviewTab threadId={T} />,
      withReview({
        available: true,
        pr: {
          number: 7,
          url: "https://github.com/example/api/pull/7",
          headRefOid: "abc",
          reviewDecision: "",
          mergeStateStatus: "CLEAN",
        },
        threads: [],
      }),
    );
    expect(await screen.findByText("No bot review on this PR yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request re-review" })).toBeTruthy();
  });

  it("shows a friendly state when the server hasn't implemented git.prReview", async () => {
    renderWithApi(<ReviewTab threadId={T} />, {
      prReview: vi.fn(async (): Promise<PrReview> => {
        throw new NotImplemented({ rpc: "git.prReview" });
      }),
    });
    expect(await screen.findByText("The review tab isn't available yet.")).toBeTruthy();
  });
});
