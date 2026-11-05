// @vitest-environment happy-dom
import type { PendingRequest, RequestId, ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { installKeyboard } from "@/keyboard/registry";
import { useThreadsStore } from "@/stores/threads";

import { useApprovalReceipts } from "./approval-receipt";
import { ApprovalSlotsProvider } from "./approval-slots";
import { AwaitingToolsProvider } from "./awaiting-tools";
import type { AnyToolPart } from "./parts";
import { RequestCards } from "./request-cards";
import { ToolCard } from "./tool-cards";
import { ToolGroup } from "./tool-group";

// The approval card drawn under the tool row that waits on it. Moving it there changes where it
// is drawn and nothing it sends: every answer below goes out exactly as it does from the card above
// the composer.

const T = "t-inline" as ThreadId;

type Approval = Extract<PendingRequest, { kind: "approval" }>;

const ask = (id: string, call: string, command: string): Approval => ({
  kind: "approval",
  id: id as RequestId,
  toolUseId: call,
  toolName: "Bash",
  displayName: "Bash",
  input: { command },
  suggestions: [
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "git push:*" }],
      behavior: "allow",
      destination: "localSettings",
    },
  ],
});

const PUSH = ask("r-push", "call-push", "git push origin fix/flaky-retry");
const TAG = ask("r-tag", "call-tag", "git tag v1.2.0");

const part = (request: Approval): AnyToolPart =>
  ({
    type: "tool-Bash",
    toolCallId: request.toolUseId,
    state: "input-available",
    input: request.input,
  }) as unknown as AnyToolPart;

const none = new Map();
const rowProps = {
  subagents: none,
  subagentUsage: none,
  streamingIds: new Set<string>(),
  renderSubagent: () => null,
};

const pending = (requests: readonly PendingRequest[]) =>
  useThreadsStore.setState({
    byId: {
      [T]: { status: requests.length > 0 ? "needsApproval" : "running", pendingRequests: requests },
    } as never,
  });

/** What the browser says of each observed element: on screen unless the test says otherwise. */
let onScreen = (_element: Element) => true;
const observers = new Set<{ check: () => void }>();
class FakeIntersectionObserver {
  readonly #elements = new Set<Element>();
  readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(element: Element) {
    this.#elements.add(element);
    observers.add(this);
    this.check();
  }
  check() {
    const entries = [...this.#elements].map(
      (target) => ({ target, isIntersecting: onScreen(target) }) as IntersectionObserverEntry,
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
  unobserve(element: Element) {
    this.#elements.delete(element);
  }
  disconnect() {
    this.#elements.clear();
    observers.delete(this);
  }
  takeRecords() {
    return [];
  }
}

let uninstall: () => void;
beforeEach(() => {
  uninstall = installKeyboard();
  onScreen = () => true;
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});
afterEach(() => {
  cleanup();
  uninstall();
  vi.unstubAllGlobals();
  useThreadsStore.setState({ byId: {} as never });
  useApprovalReceipts.setState({ byThread: {} });
});

const fakeApi = () => {
  const respond = vi.fn(async () => {});
  return { api: { respond } as unknown as Api, respond };
};

/** A thread view's transcript rows and its request cards, as `ThreadView` lays them out. */
function View({
  api,
  requests,
  rows,
  focused = true,
}: {
  api: Api;
  requests: readonly PendingRequest[];
  rows: ReactNode;
  focused?: boolean;
}) {
  return (
    <ApiProvider api={api}>
      <ApprovalSlotsProvider threadId={T}>
        <div data-testid="transcript">
          <AwaitingToolsProvider threadId={T}>{rows}</AwaitingToolsProvider>
        </div>
        <div data-testid="above-composer">
          <RequestCards threadId={T} requests={requests} focused={focused} />
        </div>
      </ApprovalSlotsProvider>
    </ApiProvider>
  );
}

const card = () => screen.getByTestId("approval-card");

/** The text of the cards that show above the composer: the queue shows one at a time. */
const shown = () =>
  screen
    .getAllByTestId("approval-place")
    .filter((place) => !place.hidden)
    .map((place) => place.textContent);

describe("an approval drawn under its tool row", () => {
  it("sits right under the waiting row, in the transcript, with no link down to it", () => {
    pending([PUSH]);
    const { api } = fakeApi();
    render(
      <View api={api} requests={[PUSH]} rows={<ToolCard part={part(PUSH)} {...rowProps} />} />,
    );
    const row = screen.getByTestId("tool-card");
    const slot = screen.getByTestId("approval-slot");
    // The slot is the row's next sibling, and the card is in it.
    expect(row.nextElementSibling).toBe(slot);
    expect(slot.contains(card())).toBe(true);
    expect(screen.getByTestId("transcript").contains(card())).toBe(true);
    expect(screen.getByTestId("above-composer").contains(card())).toBe(false);
    // The row still says it waits, as words, not as a link to a card somewhere else.
    expect(row.textContent).toContain("Waiting for your approval");
    expect(screen.queryByTestId("approval-link")).toBeNull();
  });

  // Each way of answering, pressed on the card above the composer (no thread view: the paged queue
  // as it was) and on the card under its row. The requests sent must be the same, call for call.
  const ANSWERS: readonly {
    name: string;
    answer: () => void;
    sent: readonly unknown[];
  }[] = [
    {
      name: "Allow once, clicked",
      answer: () => fireEvent.click(screen.getByTestId("approval-allow")),
      sent: [[T, PUSH.id, { kind: "approval", decision: "allow", scope: "once" }]],
    },
    {
      name: "Deny, clicked",
      answer: () => fireEvent.click(screen.getByTestId("approval-deny")),
      sent: [[T, PUSH.id, { kind: "approval", decision: "deny", scope: "once" }]],
    },
    {
      name: "Always allow this rule…, previewed then confirmed",
      answer: () => {
        fireEvent.click(screen.getByTestId("approval-always"));
        // The first press only shows the rule and where it is kept.
        expect(screen.getByTestId("approval-always-rule").textContent).toContain(
          "Bash(git push:*)",
        );
        fireEvent.click(screen.getByTestId("approval-always"));
      },
      sent: [[T, PUSH.id, { kind: "approval", decision: "allow", scope: "always" }]],
    },
    {
      name: "Always allow this rule…, previewed then backed out of, then denied",
      answer: () => {
        fireEvent.click(screen.getByTestId("approval-always"));
        fireEvent.click(screen.getByTestId("approval-always-back"));
        fireEvent.click(screen.getByTestId("approval-deny"));
      },
      sent: [[T, PUSH.id, { kind: "approval", decision: "deny", scope: "once" }]],
    },
    {
      name: "Enter",
      answer: () => fireEvent.keyDown(window, { key: "Enter", code: "Enter" }),
      sent: [[T, PUSH.id, { kind: "approval", decision: "allow", scope: "once" }]],
    },
    {
      name: "Escape",
      answer: () => fireEvent.keyDown(window, { key: "Escape", code: "Escape" }),
      sent: [[T, PUSH.id, { kind: "approval", decision: "deny", scope: "once" }]],
    },
    {
      name: "⌥Enter twice, as two presses",
      answer: () => {
        fireEvent.keyDown(window, { key: "Enter", code: "Enter", altKey: true });
        fireEvent.keyUp(window, { key: "Enter", code: "Enter", altKey: true });
        fireEvent.keyDown(window, { key: "Enter", code: "Enter", altKey: true });
      },
      sent: [[T, PUSH.id, { kind: "approval", decision: "allow", scope: "always" }]],
    },
  ];

  for (const { name, answer, sent } of ANSWERS) {
    it(`sends what the card above the composer sends: ${name}`, async () => {
      pending([PUSH]);
      const above = fakeApi();
      const { unmount } = render(
        <ApiProvider api={above.api}>
          <RequestCards threadId={T} requests={[PUSH]} focused />
        </ApiProvider>,
      );
      answer();
      await waitFor(() => expect(above.respond).toHaveBeenCalledTimes(sent.length));
      unmount();

      const inline = fakeApi();
      render(
        <View
          api={inline.api}
          requests={[PUSH]}
          rows={<ToolCard part={part(PUSH)} {...rowProps} />}
        />,
      );
      expect(screen.getByTestId("approval-slot").contains(card())).toBe(true);
      answer();
      await waitFor(() => expect(inline.respond).toHaveBeenCalledTimes(sent.length));
      expect(inline.respond.mock.calls).toEqual(above.respond.mock.calls);
      expect(inline.respond.mock.calls).toEqual(sent);
    });
  }

  it("puts each of several approvals under its own row, and keys answer one card only", async () => {
    pending([PUSH, TAG]);
    const { api, respond } = fakeApi();
    render(
      <View
        api={api}
        requests={[PUSH, TAG]}
        rows={
          <>
            <ToolCard part={part(PUSH)} {...rowProps} />
            <ToolCard part={part(TAG)} {...rowProps} />
          </>
        }
      />,
    );
    const [first, second] = screen.getAllByTestId("approval-slot");
    expect(first!.textContent).toContain("git push origin fix/flaky-retry");
    expect(second!.textContent).toContain("git tag v1.2.0");
    // No pager: each card is in sight under its row.
    expect(screen.queryByRole("navigation", { name: "Approval navigation" })).toBeNull();
    // Only the card the keys answer shows their hints.
    expect(first!.querySelectorAll("kbd").length).toBeGreaterThan(0);
    expect(second!.querySelectorAll("kbd").length).toBe(0);
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith(T, PUSH.id, {
      kind: "approval",
      decision: "allow",
      scope: "once",
    });
  });

  it("moves the keys to the card being worked on when focus goes into it", async () => {
    pending([PUSH, TAG]);
    const { api, respond } = fakeApi();
    render(
      <View
        api={api}
        requests={[PUSH, TAG]}
        rows={
          <>
            <ToolCard part={part(PUSH)} {...rowProps} />
            <ToolCard part={part(TAG)} {...rowProps} />
          </>
        }
      />,
    );
    const [, second] = screen.getAllByTestId("approval-slot");
    fireEvent.focus(second!.querySelector('[data-testid="approval-details"], button')!);
    await waitFor(() => expect(second!.querySelectorAll("kbd").length).toBeGreaterThan(0));
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith(T, TAG.id, {
      kind: "approval",
      decision: "deny",
      scope: "once",
    });
  });

  it("answers no key while its card is off screen, in a row drawn below the fold", async () => {
    onScreen = () => false;
    pending([PUSH]);
    const { api, respond } = fakeApi();
    render(
      <View api={api} requests={[PUSH]} rows={<ToolCard part={part(PUSH)} {...rowProps} />} />,
    );
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(respond).not.toHaveBeenCalled();
    // Scrolled into view, it answers again.
    onScreen = () => true;
    act(() => {
      for (const observer of observers) observer.check();
    });
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  });

  it("ignores the keys in an unfocused pane, as above the composer", () => {
    pending([PUSH]);
    const { api, respond } = fakeApi();
    render(
      <View
        api={api}
        requests={[PUSH]}
        focused={false}
        rows={<ToolCard part={part(PUSH)} {...rowProps} />}
      />,
    );
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    expect(respond).not.toHaveBeenCalled();
  });

  it("waits above the composer while its row isn't drawn, then moves under it unchanged", () => {
    pending([PUSH]);
    const { api, respond } = fakeApi();
    const { rerender } = render(<View api={api} requests={[PUSH]} rows={null} />);
    expect(screen.getByTestId("approval-fallback").contains(card())).toBe(true);
    // The preview opened above the composer stays open once the row is drawn and holds the card.
    fireEvent.click(screen.getByTestId("approval-always"));
    rerender(
      <View api={api} requests={[PUSH]} rows={<ToolCard part={part(PUSH)} {...rowProps} />} />,
    );
    expect(screen.getByTestId("approval-slot").contains(card())).toBe(true);
    expect(screen.getByTestId("approval-always-rule")).toBeTruthy();
    // And back, when the row scrolls out of the transcript's window.
    rerender(<View api={api} requests={[PUSH]} rows={null} />);
    expect(screen.getByTestId("approval-fallback").contains(card())).toBe(true);
    expect(screen.getByTestId("approval-always-rule")).toBeTruthy();
    expect(respond).not.toHaveBeenCalled();
  });

  it("pages the cards that wait above the composer, as before", () => {
    pending([PUSH, TAG]);
    const { api } = fakeApi();
    render(<View api={api} requests={[PUSH, TAG]} rows={null} />);
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain("git push");
    fireEvent.click(screen.getByRole("button", { name: "Next approval" }));
    expect(shown()).toHaveLength(1);
    expect(shown()[0]).toContain("git tag");
  });

  it("shows one receipt, under the row whose approval it answered", async () => {
    pending([PUSH]);
    const { api } = fakeApi();
    const rows = <ToolCard part={part(PUSH)} {...rowProps} />;
    const { rerender } = render(<View api={api} requests={[PUSH]} rows={rows} />);
    fireEvent.click(screen.getByTestId("approval-allow"));
    await waitFor(() => expect(useApprovalReceipts.getState().byThread[T]).toBeDefined());
    act(() => pending([]));
    rerender(<View api={api} requests={[]} rows={rows} />);
    const receipts = screen.getAllByTestId("approval-receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.textContent).toContain("Allowed once");
    expect(screen.getByTestId("approval-slot").contains(receipts[0]!)).toBe(true);
    expect(screen.queryByTestId("approval-card")).toBeNull();
  });

  it("sits under a closed run's line while the run hides its row", () => {
    pending([PUSH]);
    const { api } = fakeApi();
    const read = {
      type: "tool-Read",
      toolCallId: "call-read",
      state: "output-available",
      input: { file_path: "/repo/README.md" },
      output: "",
    } as unknown as AnyToolPart;
    render(
      <View
        api={api}
        requests={[PUSH]}
        rows={<ToolGroup run={[read, part(PUSH)]} {...rowProps} />}
      />,
    );
    const group = screen.getByTestId("tool-group");
    // Waiting, the run opens and the card is under the call's own row.
    expect(group.getAttribute("data-open")).toBe("true");
    let slots = screen.getAllByTestId("approval-slot");
    expect(slots).toHaveLength(1);
    expect(slots[0]!.previousElementSibling?.getAttribute("data-tool-call-id")).toBe("call-push");
    expect(slots[0]!.contains(card())).toBe(true);
    // Closed by the user, the run's line holds it.
    fireEvent.click(group.querySelector("button[aria-expanded]")!);
    expect(group.getAttribute("data-open")).toBe("false");
    slots = screen.getAllByTestId("approval-slot");
    expect(slots).toHaveLength(1);
    expect(slots[0]!.parentElement).toBe(group);
    expect(slots[0]!.contains(card())).toBe(true);
    expect(group.textContent).not.toContain("Show approval");
  });
});
