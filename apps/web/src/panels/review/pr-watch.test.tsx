// @vitest-environment happy-dom
import {
  initialBabysitState,
  type BabysitState,
  type BabysitStopReason,
  type BoundPr,
  type ThreadId,
} from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useThreadsStore } from "@/stores/threads";

import { renderWithApi } from "../test-utils";
import { STOP_REASON_TEXT } from "./babysit-model";
import { babysitRounds, PrWatch } from "./pr-watch";

const T = "t-flaky" as ThreadId;

const setThread = (babysit: BabysitState | undefined, boundPr?: BoundPr) =>
  act(() => {
    useThreadsStore.setState({ byId: { [T]: { thread: { id: T, babysit, boundPr } } as never } });
  });
const setBabysit = (babysit: BabysitState | undefined) => setThread(babysit);

const shimmering = () =>
  screen.getByTestId("babysit-status").querySelector(".gram-shimmer")?.getAttribute("data-active");

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
});

describe("PrWatch", () => {
  it("turns babysit on with the round budget, and off", async () => {
    setBabysit(undefined);
    const threadSetBabysit = vi.fn(async () => ({}) as never);
    renderWithApi(<PrWatch threadId={T} />, { threadSetBabysit });

    const toggle = screen.getByRole("switch", { name: "Babysit this PR" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("babysit-status")).toBeNull();
    const rounds = screen.getByRole<HTMLInputElement>("spinbutton", { name: "Max babysit rounds" });
    expect(rounds.value).toBe("6");
    fireEvent.change(rounds, { target: { value: "3" } });
    fireEvent.click(toggle);
    await waitFor(() => expect(threadSetBabysit).toHaveBeenCalledWith(T, true, { rounds: 3 }));

    setBabysit(initialBabysitState(0, { rounds: 3 }));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("spinbutton", { name: "Max babysit rounds" })).toBeNull();
    expect(screen.getByTestId("babysit-status").textContent).toBe("Watching · round 0 of 3");
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(threadSetBabysit).toHaveBeenCalledWith(T, false));
  });

  it("shimmers for a round on the PR it babysits, not on the branch's other PR", () => {
    const entry = (boundPr: BoundPr | undefined) => ({
      thread: { id: T, babysit: initialBabysitState(0), boundPr },
      git: {
        origin: "example/api",
        pr: {
          number: 412,
          url: "https://github.com/example/api/pull/412",
          review: { roundInFlight: true, threads: { unresolved: 0, blockers: 0 } },
        },
      },
    });
    act(() => useThreadsStore.setState({ byId: { [T]: entry(undefined) as never } }));
    renderWithApi(<PrWatch threadId={T} />, {});
    expect(shimmering()).toBe("true");

    const other: BoundPr = { repo: "example/api", number: 7, monitor: false };
    act(() => useThreadsStore.setState({ byId: { [T]: entry(other) as never } }));
    expect(shimmering()).toBe("false");
  });

  it("keeps the budget within 1–20, falling back to the default", () => {
    expect(babysitRounds("0")).toBe(1);
    expect(babysitRounds("99")).toBe(20);
    expect(babysitRounds("")).toBe(6);
  });

  it("watches reviews on its own, and locks that switch while babysitting", async () => {
    setThread(undefined, {
      repo: "example/api",
      number: 412,
      monitor: false,
      reviewMonitor: false,
    });
    const threadSetReviewMonitor = vi.fn(async () => ({}));
    renderWithApi(<PrWatch threadId={T} />, { threadSetReviewMonitor });

    const watch = screen.getByRole("switch", { name: "Watch reviews" });
    expect(watch.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(watch);
    await waitFor(() => expect(threadSetReviewMonitor).toHaveBeenCalledWith(T, true));

    setThread(initialBabysitState(0), {
      repo: "example/api",
      number: 412,
      monitor: false,
      reviewMonitor: true,
    });
    expect(watch.getAttribute("aria-checked")).toBe("true");
    expect(watch.hasAttribute("disabled")).toBe(true);
  });

  it("shows the api's error", async () => {
    setBabysit(undefined);
    const threadSetBabysit = vi.fn(async () => {
      throw new Error("This branch has no PR");
    });
    renderWithApi(<PrWatch threadId={T} />, { threadSetBabysit });
    fireEvent.click(screen.getByRole("switch", { name: "Babysit this PR" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This branch has no PR");
  });

  it("shows each phase in words", () => {
    setBabysit({ ...initialBabysitState(0, { rounds: 4 }), rounds: 2 });
    renderWithApi(<PrWatch threadId={T} />, {});
    const status = screen.getByTestId("babysit-status");
    expect(status.textContent).toBe("Watching · round 2 of 4");
    expect(status.getAttribute("data-phase")).toBe("watching");

    setBabysit({ ...initialBabysitState(0), phase: "done" });
    expect(screen.getByTestId("babysit-status").textContent).toBe("Done · ready to merge");
  });

  it("names every stop reason and shows the detail", () => {
    renderWithApi(<PrWatch threadId={T} />, {});
    const reasons = Object.keys(STOP_REASON_TEXT) as BabysitStopReason[];
    for (const stopReason of reasons) {
      setBabysit({ ...initialBabysitState(0), phase: "stopped", stopReason });
      expect(screen.getByTestId("babysit-status").textContent).toBe(
        `Stopped: ${STOP_REASON_TEXT[stopReason]}`,
      );
    }
    expect(STOP_REASON_TEXT.disagreement).toBe("the bot and agent disagree on one thread twice");

    setBabysit({
      ...initialBabysitState(0),
      phase: "stopped",
      stopReason: "checkFailedTwice",
      stopDetail: "build failed again on 1a2b3c4",
    });
    expect(screen.getByTestId("babysit-stop-detail").textContent).toBe(
      "build failed again on 1a2b3c4",
    );
  });

  it("wraps its text rather than cutting it off in a narrow panel", () => {
    setBabysit({ ...initialBabysitState(0), phase: "stopped", stopReason: "disagreement" });
    renderWithApi(<PrWatch threadId={T} />, {});
    const panel = screen.getByTestId("pr-watch");
    expect(screen.getByTestId("babysit-status").textContent).toBe(
      `Stopped: ${STOP_REASON_TEXT.disagreement}`,
    );
    expect(panel.querySelector(".truncate")).toBeNull();
  });

  it("says what watching does only while something is watched", () => {
    setThread(undefined, {
      repo: "example/api",
      number: 412,
      monitor: false,
      reviewMonitor: false,
    });
    renderWithApi(<PrWatch threadId={T} />, {});
    expect(screen.queryByTestId("pr-watch-hint")).toBeNull();

    setThread(undefined, { repo: "example/api", number: 412, monitor: false, reviewMonitor: true });
    expect(screen.getByTestId("pr-watch-hint").textContent).toBe(
      "After each bot round, the agent gets the open findings and failing checks.",
    );

    setThread(initialBabysitState(0), {
      repo: "example/api",
      number: 412,
      monitor: false,
      reviewMonitor: true,
    });
    expect(screen.queryByTestId("pr-watch-hint")).toBeNull();
  });
});
