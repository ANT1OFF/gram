// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { sanitizeReviewRequestsView, useLayoutStore } from "./layout";

afterEach(() =>
  useLayoutStore.setState({
    reviewRequestsCollapsed: false,
    reviewRequestsPlacement: "sidebar",
    panelTab: "diff",
    panelOpen: true,
  }),
);

describe("review requests collapse", () => {
  it("starts open and flips on toggle", () => {
    expect(useLayoutStore.getState().reviewRequestsCollapsed).toBe(false);

    useLayoutStore.getState().toggleReviewRequestsCollapsed();
    expect(useLayoutStore.getState().reviewRequestsCollapsed).toBe(true);

    useLayoutStore.getState().toggleReviewRequestsCollapsed();
    expect(useLayoutStore.getState().reviewRequestsCollapsed).toBe(false);
  });

  it("restores a stored flag and ignores anything that isn't a boolean", () => {
    expect(sanitizeReviewRequestsView({ reviewRequestsCollapsed: true })).toEqual({
      reviewRequestsCollapsed: true,
    });
    expect(sanitizeReviewRequestsView({ reviewRequestsCollapsed: "yes" })).toEqual({});
    expect(sanitizeReviewRequestsView({})).toEqual({});
    expect(sanitizeReviewRequestsView(undefined)).toEqual({});
  });

  it("restores grouping and the collapsed repositories, dropping what isn't a repo name", () => {
    expect(
      sanitizeReviewRequestsView({
        reviewRequestsGrouped: true,
        reviewRequestsCollapsedRepos: ["example/api", 7],
      }),
    ).toEqual({ reviewRequestsGrouped: true, reviewRequestsCollapsedRepos: ["example/api"] });
    expect(sanitizeReviewRequestsView({ reviewRequestsCollapsedRepos: "example/api" })).toEqual({});
  });

  it("groups by repository until told otherwise", () => {
    expect(useLayoutStore.getState().reviewRequestsGrouped).toBe(true);
  });

  it("opens the right panel on Reviews when the list moves there, and leaves that tab with it", () => {
    useLayoutStore.setState({ panelOpen: false });
    useLayoutStore.getState().setReviewRequestsPlacement("panel");
    expect(useLayoutStore.getState()).toMatchObject({ panelOpen: true, panelTab: "reviews" });

    useLayoutStore.getState().setReviewRequestsPlacement("hidden");
    expect(useLayoutStore.getState()).toMatchObject({
      reviewRequestsPlacement: "hidden",
      panelTab: "diff",
    });
  });

  it("drops a stored placement it doesn't know", () => {
    expect(sanitizeReviewRequestsView({ reviewRequestsPlacement: "panel" })).toEqual({
      reviewRequestsPlacement: "panel",
    });
    expect(sanitizeReviewRequestsView({ reviewRequestsPlacement: "footer" })).toEqual({});
  });

  it("collapses one repository's group at a time", () => {
    useLayoutStore.getState().toggleReviewRepoCollapsed("example/api");
    expect(useLayoutStore.getState().reviewRequestsCollapsedRepos).toEqual(["example/api"]);
    useLayoutStore.getState().toggleReviewRepoCollapsed("example/api");
    expect(useLayoutStore.getState().reviewRequestsCollapsedRepos).toEqual([]);
  });
});
