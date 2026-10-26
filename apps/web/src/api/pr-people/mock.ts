import type { PrDetailResult, ThreadId } from "@gram/contracts";

import { mockPrDetail } from "../mock-git";
import { MockPrPeople } from "../mock-pr-people";
import type { MockWorld } from "../mock-world";
import type { PrPeopleApi } from "./types";

/**
 * Reviewers and labels on the seeded PRs. The core builds it, because the PR detail it serves shows
 * them; `api` is what joins the `Api`.
 */
export function createPrPeopleMock(world: MockWorld) {
  const people = new MockPrPeople();
  /** Throws `ThreadNotFound` for an unknown thread, as the server does before asking GitHub. */
  const pr = (threadId: ThreadId) => {
    world.summary(threadId);
    return mockPrDetail(threadId);
  };
  const api: PrPeopleApi = {
    prRequestReview: async (threadId, reviewers) => {
      const detail = pr(threadId);
      await world.delay(20);
      return people.requestReview(threadId, detail, reviewers);
    },
    prReviewerSuggestions: async (threadId) => people.suggestions(threadId, pr(threadId)),
    prLabelsList: async (threadId) => {
      const detail = pr(threadId);
      await world.delay(20);
      return people.labelList(threadId, detail);
    },
    prLabelsAdd: async (threadId, labels) => {
      people.editLabels(threadId, pr(threadId), "add", labels);
    },
    prLabelsRemove: async (threadId, labels) => {
      people.editLabels(threadId, pr(threadId), "remove", labels);
    },
  };
  return {
    api,
    /** `detail` with the reviewers and labels the user has changed on it since. */
    detail: (threadId: ThreadId, detail: PrDetailResult) => people.detail(threadId, detail),
  };
}
