import type { OwnPr, ReviewRequest } from "@gram/contracts";

import { seedOwnPrs, seedReviewRequests, seedTeamReviewRequests } from "../mock-review-requests";
import type { MockWorld } from "../mock-world";
import type { ReviewRequestsApi } from "./types";

/**
 * The review requests and own PRs the mock's poll finds, the seed's until a control adds more. The core builds
 * it, so its `seed*` and `simulate*` controls can reach these; `api` is what joins the `Api`.
 */
export function createReviewRequestsMock(world: MockWorld) {
  let requests: readonly ReviewRequest[] = seedReviewRequests();
  let own: readonly OwnPr[] = seedOwnPrs();
  const api: ReviewRequestsApi = {
    listReviewRequests: async () => {
      await world.delay(10);
      const settings = await world.settings();
      if (settings.notifications.reviewRequests === false) return { requests: [] };
      const team = settings.notifications.reviewRequestsDirectOnly === false;
      return {
        requests: [...requests, ...(team ? seedTeamReviewRequests() : [])],
        checkedAt: Date.now(),
      };
    },
    refreshReviewRequests: async () => {},
    listOpenPrs: async () => {
      await world.delay(10);
      return { prs: own, checkedAt: Date.now() };
    },
  };
  return {
    api,
    /** Explicit offline list snapshot, without synthesizing notifications. */
    replace(lists: { requests: readonly ReviewRequest[]; prs: readonly OwnPr[] }) {
      requests = lists.requests;
      own = lists.prs;
      world.emit({ type: "reviewRequests.changed" });
      world.emit({ type: "openPrs.changed" });
    },
    /** Adds requests after the ones there are, as a seed does. */
    append(more: readonly ReviewRequest[]) {
      requests = [...requests, ...more];
    },
    /** GitHub starts requesting the user's review on `request`, as the poll finds it. */
    simulate(request: ReviewRequest) {
      requests = [request, ...requests.filter((r) => r.url !== request.url)];
      world.emit({
        type: "notify",
        kind: "needsInput",
        title: `Review requested: ${request.repo}#${request.number} ${request.title}`,
        ...(request.author === "" ? {} : { body: `From ${request.author}` }),
      });
      world.emit({ type: "reviewRequests.changed" });
    },
    /** The user opens `pr`, or GitHub's view of it changes, as the poll finds it. Never notifies. */
    simulateOwn(pr: OwnPr) {
      own = [pr, ...own.filter((p) => p.url !== pr.url)];
      world.emit({ type: "openPrs.changed" });
    },
  };
}
