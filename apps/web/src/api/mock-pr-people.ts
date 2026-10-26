import {
  InvalidState,
  type PrDetailResult,
  type PrLabel,
  type PrLabelList,
  type PrRequestReviewResult,
  type PrReviewerSuggestions,
  type PrReviewRequest,
  type ThreadId,
} from "@gram/contracts";

const noPr = (threadId: ThreadId) =>
  new InvalidState({ message: "This thread has no pull request", threadId });

const REPO_LABELS: PrLabel[] = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "flaky", color: "fbca04", description: "Fails intermittently" },
  { name: "needs review", color: "a2eeef", description: "" },
  { name: "tests", color: "0e8a16", description: "Test-only changes" },
  { name: "windows", color: "1d76db", description: "Windows-specific" },
];

/** Review requests and label edits made while the mock runs, layered over the seeded PR detail. */
export class MockPrPeople {
  readonly #requested = new Map<ThreadId, PrReviewRequest[]>();
  readonly #labels = new Map<ThreadId, PrLabel[]>();

  detail(threadId: ThreadId, result: PrDetailResult): PrDetailResult {
    if (!result.detail) return result;
    const added = this.#requested.get(threadId) ?? [];
    const labels = this.#labels.get(threadId);
    return {
      ...result,
      detail: {
        ...result.detail,
        reviewRequests: [...(result.detail.reviewRequests ?? []), ...added],
        ...(labels ? { labels } : {}),
      },
    };
  }

  requestReview(
    threadId: ThreadId,
    result: PrDetailResult,
    reviewers: readonly string[],
  ): PrRequestReviewResult {
    const detail = this.detail(threadId, result).detail;
    if (!detail) throw noPr(threadId);
    const names = [...new Set(reviewers.map((n) => n.trim().replace(/^@/, "")).filter(Boolean))];
    if (names.length === 0) throw new InvalidState({ message: "Name at least one reviewer" });
    const known = new Set((detail.reviewRequests ?? []).map((r) => r.name.toLowerCase()));
    const added = names
      .filter((name) => !known.has(name.toLowerCase()))
      .map((name): PrReviewRequest => ({ kind: name.includes("/") ? "team" : "user", name }));
    this.#requested.set(threadId, [...(this.#requested.get(threadId) ?? []), ...added]);
    return { reviewers: names };
  }

  suggestions(threadId: ThreadId, result: PrDetailResult): PrReviewerSuggestions {
    if (!result.detail) throw noPr(threadId);
    return { logins: ["reviewer", "maria", "sam", "priya", "oskar"] };
  }

  labelList(threadId: ThreadId, result: PrDetailResult): PrLabelList {
    if (!result.detail) throw noPr(threadId);
    return { labels: REPO_LABELS };
  }

  editLabels(
    threadId: ThreadId,
    result: PrDetailResult,
    change: "add" | "remove",
    names: readonly string[],
  ) {
    const detail = this.detail(threadId, result).detail;
    if (!detail) throw noPr(threadId);
    const current = detail.labels ?? [];
    if (change === "remove") {
      this.#labels.set(
        threadId,
        current.filter((label) => !names.includes(label.name)),
      );
      return;
    }
    const added = names.map((name) => {
      const label = REPO_LABELS.find((l) => l.name === name);
      if (!label) throw new InvalidState({ message: `'${name}' not found` });
      return label;
    });
    const kept = current.filter((label) => !names.includes(label.name));
    this.#labels.set(threadId, [...kept, ...added]);
  }
}
