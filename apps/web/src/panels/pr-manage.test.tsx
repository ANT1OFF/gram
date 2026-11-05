// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { mockPrDetail } from "@/api/mock-git";
import { useThreadsStore } from "@/stores/threads";

import { PrManage, watchingWords } from "./pr-manage";
import { renderWithApi } from "./test-utils";

const T = "t-flaky" as ThreadId;
const detail = mockPrDetail(T).detail!;
const noop = () => {};

/** The panel's summary asking for a review, which opens the folded reviewers. */
function Revealing() {
  const [reveal, setReveal] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setReveal((n) => n + 1)}>
        Ask for a review
      </button>
      <PrManage
        threadId={T}
        detail={detail}
        blocked
        bindFormOpen={false}
        onBindFormClose={noop}
        reveal={reveal}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
});

describe("watchingWords", () => {
  it("says what the agent watches in a few words", () => {
    expect(watchingWords({ babysit: false, reviews: false, ci: false })).toBe("not watching");
    expect(watchingWords({ babysit: false, reviews: true, ci: true })).toBe(
      "watching reviews and CI",
    );
    expect(watchingWords({ babysit: false, reviews: false, ci: true })).toBe("watching CI");
    expect(watchingWords({ babysit: true, reviews: true, ci: false })).toBe("watching the PR");
  });
});

const toggle = () => screen.getByTestId("pr-manage-toggle");

describe("PrManage", () => {
  it("starts folded while the merge is blocked, naming what's inside, and unfolds on a click", () => {
    renderWithApi(
      <PrManage threadId={T} detail={detail} blocked bindFormOpen={false} onBindFormClose={noop} />,
      {},
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("pr-manage-facts").textContent).toBe(
      "· 4 reviewers · 2 labels · not watching",
    );
    expect(screen.queryByTestId("pr-watch")).toBeNull();
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("pr-watch")).toBeTruthy();
    expect(screen.getByTestId("pr-reviewers")).toBeTruthy();
    expect(screen.queryByTestId("pr-manage-facts")).toBeNull();
  });

  it("starts open when nothing blocks, while babysitting, for the bind form and on reveal", () => {
    renderWithApi(
      <PrManage
        threadId={T}
        detail={detail}
        blocked={false}
        bindFormOpen={false}
        onBindFormClose={noop}
      />,
      {},
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    cleanup();

    useThreadsStore.setState({
      byId: {
        [T]: { thread: { babysit: { phase: "watching", rounds: 1, budget: { rounds: 6 } } } },
      } as never,
    });
    renderWithApi(
      <PrManage threadId={T} detail={detail} blocked bindFormOpen={false} onBindFormClose={noop} />,
      {},
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    cleanup();
    useThreadsStore.setState({ byId: {} });

    renderWithApi(
      <PrManage threadId={T} detail={detail} blocked bindFormOpen onBindFormClose={noop} />,
      {},
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    cleanup();

    renderWithApi(<Revealing />, {});
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Ask for a review" }));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });
});
