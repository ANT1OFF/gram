// @vitest-environment happy-dom
import type { MessageOrigin, ThreadId, ThreadSummary } from "@gram/contracts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useEmbedShell } from "@/embed/store";
import { renderInRouter } from "@/panels/test-utils";
import { useRevealStore } from "@/stores/reveal";
import { useThreadsStore } from "@/stores/threads";

import { MessageOriginLabel, ThreadMessage } from "./message-origin";

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ ready: false, byId: {} });
  useEmbedShell.setState({ threadsPage: {} });
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

/** The label's title and tags (role, place, mode), whatever words join them. */
const parts = (row: HTMLElement) =>
  [...row.querySelectorAll<HTMLElement>("[data-origin-part]")].map((part) =>
    part.textContent?.replace(/^·\s*/, ""),
  );

describe("MessageOriginLabel", () => {
  it("is one link to the sending thread, under its current title", async () => {
    withSender({ title: "Auth middleware split" });
    await renderInRouter(<MessageOriginLabel origin={origin} />);
    const row = screen.getByTestId("message-origin");
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toBe("/t/t-planner");
    expect(parts(row)).toEqual(["Auth middleware split", "queued"]);
  });

  it("names the embedding app's place the sender opens in, and links there", async () => {
    withSender({ title: "Why the retry test is flaky" });
    useEmbedShell.setState({
      threadsPage: { places: [{ name: "Chat", path: "/chat/$threadId", ids: [SENDER] }] },
    });
    await renderInRouter(<MessageOriginLabel origin={origin} />);
    const row = screen.getByTestId("message-origin");
    expect(row.getAttribute("href")).toBe("/chat/t-planner");
    expect(parts(row)).toEqual(["Why the retry test is flaky", "Chat", "queued"]);
  });

  it("names an orchestrator, a worker and a steer", async () => {
    withSender({ title: "Orchestrator" });
    await renderInRouter(
      <MessageOriginLabel origin={{ ...origin, role: "orchestrator", mode: "steer" }} />,
    );
    expect(parts(screen.getByTestId("message-origin"))).toEqual([
      "Orchestrator",
      "orchestrator",
      "steer",
    ]);
    cleanup();

    withSender({ title: "Fix login", spawnedBy: { threadId: "o" as ThreadId, feature: "login" } });
    await renderInRouter(<MessageOriginLabel origin={{ ...origin, mode: "queue" }} />);
    expect(parts(screen.getByTestId("message-origin"))).toEqual(["Fix login", "worker", "queued"]);
  });

  it("keeps the title it was sent under, muted and unlinked, once the sender is gone", async () => {
    useThreadsStore.setState({ ready: true, byId: {} });
    await renderInRouter(<MessageOriginLabel origin={origin} />);
    const row = screen.getByTestId("message-origin");
    expect(row.tagName).toBe("P");
    expect(row.textContent).toContain("Split the auth middleware");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the sender's agent as its avatar, and a gone worker still as a worker", async () => {
    withSender({ title: "Fix login" });
    await renderInRouter(<MessageOriginLabel origin={origin} />);
    expect(screen.getByTestId("message-origin-avatar").querySelector("svg")).not.toBeNull();
    cleanup();

    useThreadsStore.setState({ ready: true, byId: {} });
    await renderInRouter(<MessageOriginLabel origin={{ ...origin, feature: "login" }} />);
    expect(parts(screen.getByTestId("message-origin"))).toEqual([
      "Split the auth middleware",
      "worker",
      "queued",
    ]);
  });
});

describe("ThreadMessage from the orchestrator", () => {
  const brief = "Add retry to the queue worker.\nKeep the public API as it is.";
  const fromOrchestrator = (messageId: string) =>
    renderInRouter(
      <ThreadMessage
        origin={{ ...origin, role: "orchestrator", mode: "steer" }}
        messageId={messageId}
        text={brief}
      >
        {brief}
      </ThreadMessage>,
    );

  it("folds to one line that names it and starts its words, and opens on a click", async () => {
    withSender({ title: "Orchestrator · Gram" });
    await fromOrchestrator("m-brief");
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

  it("says which thread asked for the worker, as the place it opens in, beside the folded line", async () => {
    withSender({ title: "Orchestrator · Gram" });
    useEmbedShell.setState({
      threadsPage: { places: [{ name: "Chat", path: "/chat/$threadId", ids: ["t-chat"] }] },
    });
    await renderInRouter(
      <ThreadMessage
        origin={{
          ...origin,
          role: "orchestrator",
          askedBy: { threadId: "t-chat" as ThreadId, title: "Why exports fail" },
        }}
        messageId="m-asked"
        text={brief}
      >
        {brief}
      </ThreadMessage>,
    );
    const asked = screen.getByTestId("message-asked-by");
    expect(asked.getAttribute("href")).toBe("/chat/t-chat");
    expect(asked.textContent).toBe("sent from Chat");
    // Outside the toggle, so following it doesn't open the brief.
    expect(screen.getByTestId("orchestrator-message-toggle").contains(asked)).toBe(false);
  });

  it("stays open across a remount, as rows do on scroll, and folds again on a second click", async () => {
    withSender({ title: "Orchestrator · Gram" });
    await fromOrchestrator("m-kept");
    fireEvent.click(screen.getByTestId("orchestrator-message-toggle"));
    cleanup();
    await fromOrchestrator("m-kept");
    const toggle = screen.getByTestId("orchestrator-message-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens for a search that lands in it", async () => {
    withSender({ title: "Orchestrator · Gram" });
    useRevealStore.getState().reveal("t-worker" as ThreadId, "m-found");
    await fromOrchestrator("m-found");
    expect(screen.getByTestId("orchestrator-message-toggle").getAttribute("aria-expanded")).toBe(
      "true",
    );
    useRevealStore.setState({ request: undefined });
  });

  it("leaves another thread's message as it was: its sender's line and its words", async () => {
    withSender({ title: "Fix login", spawnedBy: { threadId: "t-orch", feature: "login" } });
    await renderInRouter(
      <ThreadMessage origin={origin} messageId="m-worker" text="Done.">
        Done.
      </ThreadMessage>,
    );
    expect(screen.queryByTestId("orchestrator-message-toggle")).toBeNull();
    expect(screen.getByTestId("message-origin")).toBeTruthy();
    expect(screen.getByTestId("message-thread").textContent).toContain("Done.");
  });
});
