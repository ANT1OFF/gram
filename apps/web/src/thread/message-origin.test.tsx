// @vitest-environment happy-dom
import type { MessageOrigin, ThreadId, ThreadSummary } from "@gram/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useRevealStore } from "@/stores/reveal";
import { useThreadsStore } from "@/stores/threads";

import { MessageOriginLabel, ThreadMessage } from "./message-origin";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: {
    children?: ReactNode;
    to: string;
    params: { threadId: string };
  }) => (
    <a href={to.replace("$threadId", params.threadId)} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ ready: false, byId: {} });
});

const SENDER = "t-planner" as ThreadId;
const origin: MessageOrigin = { threadId: SENDER, title: "Split the auth middleware", depth: 1 };

const withSender = (thread: Record<string, unknown>) =>
  useThreadsStore.setState({
    ready: true,
    byId: {
      [SENDER]: {
        thread: { id: SENDER, model: { agent: "claude", model: "opus" }, ...thread },
        status: "idle",
      } as ThreadSummary,
    },
  });

describe("MessageOriginLabel", () => {
  it("is one link to the sending thread, under its current title", () => {
    withSender({ title: "Auth middleware split" });
    render(<MessageOriginLabel origin={origin} />);
    const row = screen.getByTestId("message-origin");
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toBe("/t/t-planner");
    expect(row.textContent).toBe("Received from Auth middleware split· queued");
  });

  it("names an orchestrator, a worker and a steer", () => {
    withSender({ title: "Orchestrator" });
    render(<MessageOriginLabel origin={{ ...origin, role: "orchestrator", mode: "steer" }} />);
    expect(screen.getByTestId("message-origin").textContent).toBe(
      "Received from Orchestrator· orchestrator· steer",
    );
    cleanup();

    withSender({ title: "Fix login", spawnedBy: { threadId: "o" as ThreadId, feature: "login" } });
    render(<MessageOriginLabel origin={{ ...origin, mode: "queue" }} />);
    expect(screen.getByTestId("message-origin").textContent).toBe(
      "Received from Fix login· worker· queued",
    );
  });

  it("keeps the title it was sent under, muted and unlinked, once the sender is gone", () => {
    useThreadsStore.setState({ ready: true, byId: {} });
    render(<MessageOriginLabel origin={origin} />);
    const row = screen.getByTestId("message-origin");
    expect(row.tagName).toBe("P");
    expect(row.textContent).toContain("Split the auth middleware");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the sender's agent as its avatar, and a gone worker still as a worker", () => {
    withSender({ title: "Fix login" });
    render(<MessageOriginLabel origin={origin} />);
    expect(screen.getByTestId("message-origin-avatar").querySelector("svg")).not.toBeNull();
    cleanup();

    useThreadsStore.setState({ ready: true, byId: {} });
    render(<MessageOriginLabel origin={{ ...origin, feature: "login" }} />);
    expect(screen.getByTestId("message-origin").textContent).toBe(
      "Received from Split the auth middleware· worker· queued",
    );
  });
});

describe("ThreadMessage from the orchestrator", () => {
  const brief = "Add retry to the queue worker.\nKeep the public API as it is.";
  const fromOrchestrator = (messageId: string) =>
    render(
      <ThreadMessage
        origin={{ ...origin, role: "orchestrator", mode: "steer" }}
        messageId={messageId}
        text={brief}
      >
        {brief}
      </ThreadMessage>,
    );

  it("folds to one line that names it and starts its words, and opens on a click", () => {
    withSender({ title: "Orchestrator · Gram" });
    fromOrchestrator("m-brief");
    const toggle = screen.getByTestId("orchestrator-message-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe(
      "Message from orchestrator· steerAdd retry to the queue worker.",
    );
    expect(screen.getByTestId("message-thread").textContent).not.toContain("public API");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // Open, the whole of it, and the line no longer repeats its start.
    expect(screen.getByTestId("message-thread").textContent).toContain(
      "Keep the public API as it is.",
    );
    expect(toggle.textContent).toBe("Message from orchestrator· steer");
  });

  it("stays open across a remount, as rows do on scroll, and folds again on a second click", () => {
    withSender({ title: "Orchestrator · Gram" });
    fromOrchestrator("m-kept");
    fireEvent.click(screen.getByTestId("orchestrator-message-toggle"));
    cleanup();
    fromOrchestrator("m-kept");
    const toggle = screen.getByTestId("orchestrator-message-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens for a search that lands in it", () => {
    withSender({ title: "Orchestrator · Gram" });
    useRevealStore.getState().reveal("t-worker" as ThreadId, "m-found");
    fromOrchestrator("m-found");
    expect(screen.getByTestId("orchestrator-message-toggle").getAttribute("aria-expanded")).toBe(
      "true",
    );
    useRevealStore.setState({ request: undefined });
  });

  it("leaves another thread's message as it was: its sender's line and its words", () => {
    withSender({ title: "Fix login", spawnedBy: { threadId: "t-orch", feature: "login" } });
    render(
      <ThreadMessage origin={origin} messageId="m-worker" text="Done.">
        Done.
      </ThreadMessage>,
    );
    expect(screen.queryByTestId("orchestrator-message-toggle")).toBeNull();
    expect(screen.getByTestId("message-origin")).toBeTruthy();
    expect(screen.getByTestId("message-thread").textContent).toContain("Done.");
  });
});
