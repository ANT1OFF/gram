// @vitest-environment happy-dom
import type { MessageOrigin, ThreadId, ThreadSummary } from "@gram/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useThreadsStore } from "@/stores/threads";

import { MessageOriginLabel } from "./message-origin";

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
