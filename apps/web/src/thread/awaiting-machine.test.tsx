// @vitest-environment happy-dom
import type { ProjectId, QueueItemId, Thread, ThreadId, ThreadSummary } from "@gram/contracts";
import { AWAITED_HOST_ID } from "@gram/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_SHELL, useEmbedShell } from "@/embed/store";
import { formatClockTime } from "@/lib/time";
import { useThreadsStore } from "@/stores/threads";

import { AwaitingMachine, AwaitingMachineChip, resetAskedAgain } from "./awaiting-machine";
import { MachineChip } from "./machine-chip";

const T = "t-wait" as ThreadId;
const NOW = Date.parse("2026-11-14T14:02:42Z");
const STARTED = NOW - 42_000;

const waiting = (awaitingMachine: NonNullable<Thread["awaitingMachine"]>): ThreadSummary => ({
  status: "cold",
  pendingRequests: [],
  queue: [
    { id: "q1" as QueueItemId, input: { text: "Draft the release notes for 2.4." } },
    { id: "q2" as QueueItemId, input: { text: "Keep it under 300 words." } },
  ],
  thread: {
    id: T,
    projectId: "p" as ProjectId,
    title: "Release notes",
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: `/.threads/${T}`, hostId: AWAITED_HOST_ID },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: STARTED,
    lastActivityAt: STARTED,
    awaitingMachine,
  },
});

const seed = (summary: ThreadSummary) => {
  useThreadsStore.getState().applyEvent({ type: "threads.snapshot", threads: [summary] });
  return summary.thread;
};

const failedAt = NOW - 1_000;
const starting = () => seed(waiting({ since: STARTED }));
const failed = (message = "The machine couldn't be started: no capacity in this region.") =>
  seed(waiting({ since: STARTED, failed: { at: failedAt, message } }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetAskedAgain();
  useEmbedShell.setState(EMPTY_SHELL);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useEmbedShell.setState(EMPTY_SHELL);
});

describe("a waiting thread's conversation", () => {
  it("keeps the first message as the person's own, not sent yet, and says a machine is starting", () => {
    render(<AwaitingMachine thread={starting()} />);
    expect(screen.getByTestId("machine-wait").getAttribute("data-state")).toBe("starting");
    expect(screen.getByTestId("machine-wait-message").textContent).toContain(
      "Draft the release notes for 2.4.",
    );
    expect(screen.getByTestId("machine-wait-held").textContent).toBe(
      `${formatClockTime(STARTED)} · sent when the machine has started`,
    );
    const line = screen.getByTestId("machine-wait-starting");
    expect(line.getAttribute("role")).toBe("status");
    expect(line.textContent).toBe("Starting this thread's machine · usually under a minute0:42");
    // The message after the first stays in the queue, not in the conversation.
    expect(screen.getByTestId("machine-wait").textContent).not.toContain("Keep it under");
    expect(screen.queryByTestId("machine-wait-failed")).toBeNull();
  });

  it("says a second try is one, counted from when it began", () => {
    const thread = seed(waiting({ since: NOW - 7_000 }));
    render(<AwaitingMachine thread={thread} />);
    const line = screen.getByTestId("machine-wait-starting");
    expect(line.getAttribute("data-again")).toBe("true");
    expect(line.textContent).toBe("Starting a machine again · the first didn't start0:07");
  });

  it("shows how the wait stands with nothing in the queue", () => {
    const summary = waiting({ since: STARTED });
    render(<AwaitingMachine thread={seed({ ...summary, queue: [] })} />);
    expect(screen.queryByTestId("machine-wait-message")).toBeNull();
    expect(screen.getByTestId("machine-wait-starting")).toBeTruthy();
  });

  it("says the failure in the platform's sentence, and that what was sent is kept", () => {
    useEmbedShell.setState({ machines: { startAgain: vi.fn() } });
    render(<AwaitingMachine thread={failed()} />);
    const card = screen.getByTestId("machine-wait-failed");
    expect(card.getAttribute("role")).toBe("alert");
    expect(screen.getByTestId("machine-wait-sentence").textContent).toBe(
      "The machine couldn't be started: no capacity in this region.",
    );
    expect(card.textContent).toContain(
      "What you sent is kept, and goes once a machine has started.",
    );
    expect(screen.getByTestId("machine-wait-held").textContent).toBe(
      `${formatClockTime(STARTED)} · not sent yet, and kept`,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByTestId("machine-wait-starting")).toBeNull();
  });

  it("says Gram's own sentence once, when the wait ran out by itself", () => {
    render(
      <AwaitingMachine
        thread={failed(
          "No machine started for this thread. What you sent is kept, and goes once one has.",
        )}
      />,
    );
    expect(screen.getByTestId("machine-wait-sentence").textContent).toBe(
      "No machine started for this thread.",
    );
  });

  it("has no Try again where nobody can be asked, and says what still works", () => {
    render(<AwaitingMachine thread={failed()} />);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByTestId("machine-wait-failed").textContent).toContain(
      "What you sent is kept. To try again, start the thread again.",
    );
  });

  it("asks the embedding app for another machine, then reads as starting again", async () => {
    let asked!: () => void;
    const startAgain = vi.fn(() => new Promise<void>((resolve) => (asked = resolve)));
    useEmbedShell.setState({ machines: { startAgain } });
    render(<AwaitingMachine thread={failed()} />);
    const button = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(button);
    await waitFor(() => expect(startAgain).toHaveBeenCalledWith({ threadId: T }));
    // Asked once however often it is pressed while the answer is on its way.
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(startAgain).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 3_000);
    await act(async () => asked());
    const line = await screen.findByTestId("machine-wait-starting");
    expect(line.textContent).toBe("Starting a machine again · the first didn't start0:00");
    expect(screen.queryByTestId("machine-wait-failed")).toBeNull();
    expect(screen.getByTestId("machine-wait-held").textContent).toContain(
      "sent when the machine has started",
    );
  });

  it("shows the next failure when the new try fails too", async () => {
    useEmbedShell.setState({ machines: { startAgain: vi.fn(async () => {}) } });
    const { rerender } = render(<AwaitingMachine thread={failed()} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("machine-wait-starting");
    const next = seed(
      waiting({ since: STARTED, failed: { at: NOW + 60_000, message: "Still no capacity." } }),
    );
    rerender(<AwaitingMachine thread={next} />);
    expect(screen.getByTestId("machine-wait-sentence").textContent).toBe("Still no capacity.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("keeps the failure and says why when the ask is refused", async () => {
    const startAgain = vi.fn(async () => {
      throw new Error("You have reached your limit of machines.");
    });
    useEmbedShell.setState({ machines: { startAgain } });
    render(<AwaitingMachine thread={failed()} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByTestId("machine-wait-retry-failed")).textContent).toBe(
      "Couldn't ask for another machine. You have reached your limit of machines.",
    );
    expect(screen.getByTestId("machine-wait-failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" }).hasAttribute("disabled")).toBe(false);
  });

  it("treats a handler that throws at once as a refusal", async () => {
    useEmbedShell.setState({
      machines: {
        startAgain: () => {
          throw new Error("Not signed in.");
        },
      },
    });
    render(<AwaitingMachine thread={failed()} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByTestId("machine-wait-retry-failed")).textContent).toContain(
      "Not signed in.",
    );
  });
});

describe("a waiting thread's header chip", () => {
  it("says the machine is starting in the machine's place, never one no longer joined", () => {
    render(<MachineChip thread={starting()} />);
    const chip = screen.getByTestId("pane-machine");
    expect(chip.getAttribute("data-machine-state")).toBe("starting");
    expect(chip.textContent).toBe("machine starting");
    expect(chip.getAttribute("aria-label")).toBe("This thread's machine is starting");
    expect(screen.queryByTestId("pane-machine-folder")).toBeNull();
    expect(document.body.textContent).not.toContain("no longer joined");
  });

  it("says no machine came", () => {
    render(<AwaitingMachineChip thread={failed()} />);
    const chip = screen.getByTestId("pane-machine");
    expect(chip.getAttribute("data-machine-state")).toBe("no machine");
    expect(chip.textContent).toBe("no machine");
    expect(chip.getAttribute("aria-label")).toBe("No machine started for this thread");
  });
});
