// @vitest-environment happy-dom
import type { PrReviewState } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReviewGlyph, reviewGlyphOf, reviewStatusOf } from "./review-glyph";

const state = (
  patch: Partial<PrReviewState> = {},
  threads: Partial<PrReviewState["threads"]> = {},
) =>
  ({
    bots: ["example-code-review[bot]"],
    reviewedHead: true,
    roundInFlight: false,
    ...patch,
    threads: { unresolved: 0, blockers: 0, suggestions: 0, outdatedUnresolved: 0, ...threads },
  }) satisfies PrReviewState;

afterEach(cleanup);

describe("reviewGlyphOf", () => {
  it("is absent without a bot review, or with nothing to say", () => {
    expect(reviewGlyphOf(undefined)).toBeUndefined();
    expect(reviewGlyphOf(state())).toBeUndefined();
  });

  it("shows a running round above everything else", () => {
    expect(
      reviewGlyphOf(state({ roundInFlight: true, verdictOnHead: "approved" }, { blockers: 2 })),
    ).toMatchObject({ kind: "inFlight" });
  });

  it("counts blockers, even with an approval on head", () => {
    expect(
      reviewGlyphOf(state({ verdictOnHead: "approved" }, { blockers: 2, unresolved: 3 })),
    ).toEqual({ kind: "blockers", label: "Review bot: 2 blockers", count: 2 });
  });

  it("is green when approved on head, despite open suggestions", () => {
    expect(
      reviewGlyphOf(state({ verdictOnHead: "approved" }, { suggestions: 1, unresolved: 1 })),
    ).toEqual({ kind: "approved", label: "Review bot: approved, 1 open finding" });
  });

  it("is red for changes requested on head with only untagged findings", () => {
    expect(
      reviewGlyphOf(state({ verdictOnHead: "changesRequested" }, { unresolved: 1 })),
    ).toMatchObject({ kind: "changesRequested" });
  });

  it("is amber for unresolved suggestions or findings without a verdict on head", () => {
    expect(reviewGlyphOf(state({}, { suggestions: 2, unresolved: 3 }))).toEqual({
      kind: "findings",
      label: "Review bot: 3 open findings",
      count: 3,
    });
  });

  it("labels people's open threads apart from the bot's, and shows them on their own", () => {
    expect(reviewGlyphOf(state({ verdictOnHead: "approved" }, { humanUnresolved: 2 }))).toEqual({
      kind: "approved",
      label: "Review bot: approved\nReviewers: 2 open threads",
    });
    expect(reviewGlyphOf(state({ bots: [] }, { humanUnresolved: 1 }))).toEqual({
      kind: "reviewerThreads",
      label: "Reviewers: 1 open thread",
      count: 1,
    });
  });
});

describe("reviewStatusOf", () => {
  it("puts the glyph's state in words", () => {
    expect(reviewStatusOf(state({ roundInFlight: true }))?.text).toBe("reviewing");
    expect(reviewStatusOf(state({}, { blockers: 2, unresolved: 2 }))?.text).toBe("2 blockers");
    expect(reviewStatusOf(state({ verdictOnHead: "approved" }))?.text).toBe("approved");
    expect(reviewStatusOf(state({ verdictOnHead: "changesRequested" }))?.text).toBe(
      "changes requested",
    );
    expect(reviewStatusOf(state({}, { unresolved: 1 }))?.text).toBe("1 finding");
    expect(reviewStatusOf(state({}, { humanUnresolved: 3 }))?.text).toBe("3 threads");
  });

  it("speaks for a bot with nothing open, where the glyph stays silent", () => {
    expect(reviewStatusOf(state())).toMatchObject({ kind: "quiet", text: "no findings" });
    expect(reviewStatusOf(state({ reviewedHead: false }))).toMatchObject({
      kind: "quiet",
      text: "awaiting review",
    });
  });

  it("is absent for a PR no configured bot has touched", () => {
    expect(reviewStatusOf(undefined)).toBeUndefined();
    expect(reviewStatusOf(state({ bots: [] }))).toBeUndefined();
    expect(reviewStatusOf(state({ bots: [] }, { humanUnresolved: 3 }))).toBeUndefined();
  });
});

describe("ReviewGlyph", () => {
  it("renders an accessible label and the count", () => {
    render(<ReviewGlyph review={state({}, { blockers: 1, unresolved: 1 })} />);
    const glyph = screen.getByRole("img", { name: "Review bot: 1 blocker" });
    expect(glyph.getAttribute("data-state")).toBe("blockers");
    expect(glyph.getAttribute("title")).toBe("Review bot: 1 blocker");
    expect(glyph.textContent).toBe("1");
  });

  it("renders nothing without a review", () => {
    const { container } = render(<ReviewGlyph review={undefined} />);
    expect(container.innerHTML).toBe("");
  });
});
