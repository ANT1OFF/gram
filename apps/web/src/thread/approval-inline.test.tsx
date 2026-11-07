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

/** Where the browser draws each element: on screen unless the test says otherwise. */
let onScreen = (_element: Element) => true;

/**
 * An observer that reports late, as a real one does, a frame or more after a card moves: its
 * report lands only on `flushObservers`. Keys must never go by such a report.
 */
const observers = new Set<{ check: () => void }>();
const flushObservers = () =>
  act(() => {
    for (const observer of observers) observer.check();
  });
class LateIntersectionObserver {
  readonly #elements = new Set<Element>();
  readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }
  observe(element: Element) {
    this.#elements.add(element);
    observers.add(this);
  }
  check() {
    const entries = [...this.#elements].map(
      (target) => ({ target, isIntersecting: onScreen(target) }) as IntersectionObserverEntry,
    );
    if (entries.length > 0) this.callback(entries, this as unknown as IntersectionObserver);
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

const rect = (top: number) =>
  ({
    x: 0,
    y: top,
    top,
    left: 0,
    width: 600,
    height: 120,
    bottom: top + 120,
    right: 600,
    toJSON: () => ({}),
  }) as DOMRect;

let uninstall: () => void;
beforeEach(() => {
  uninstall = installKeyboard();
  onScreen = () => true;
  vi.stubGlobal("IntersectionObserver", LateIntersectionObserver);
  // On screen is in the window; off screen is far above it, scrolled away.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return onScreen(this) ? rect(100) : rect(-5000);
  });
});
afterEach(() => {
  cleanup();
  uninstall();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  observers.clear();
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
  threadId = T,
}: {
  api: Api;
  requests: readonly PendingRequest[];
  rows: ReactNode;
  focused?: boolean;
  threadId?: ThreadId;
}) {
  return (
    <ApiProvider api={api}>
      <ApprovalSlotsProvider threadId={threadId}>
        <div data-testid="transcript">
          <AwaitingToolsProvider threadId={threadId}>{rows}</AwaitingToolsProvider>
        </div>
        <div data-testid="above-composer">
          <RequestCards threadId={threadId} requests={requests} focused={focused} />
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

/** The view as a thread view draws it, with its composer under it. */
const Pane = (props: Parameters<typeof View>[0]) => (
  <div data-thread-view={props.threadId ?? T}>
    <View {...props} />
    <textarea aria-label="Message" />
  </div>
);
const rowsOf = (...requests: Approval[]) => (
  <>
    {requests.map((request) => (
      <ToolCard key={request.id} part={part(request)} {...rowProps} />
    ))}
  </>
);

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
      name: "1",
      answer: () => fireEvent.keyDown(window, { key: "1", code: "Digit1" }),
      sent: [[T, PUSH.id, { kind: "approval", decision: "allow", scope: "once" }]],
    },
    {
      name: "3",
      answer: () => fireEvent.keyDown(window, { key: "3", code: "Digit3" }),
      sent: [[T, PUSH.id, { kind: "approval", decision: "deny", scope: "once" }]],
    },
    {
      name: "2 twice, as two presses",
      answer: () => {
        fireEvent.keyDown(window, { key: "2", code: "Digit2" });
        fireEvent.keyUp(window, { key: "2", code: "Digit2" });
        fireEvent.keyDown(window, { key: "2", code: "Digit2" });
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
    fireEvent.keyDown(window, { key: "1", code: "Digit1" });
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
    fireEvent.keyDown(window, { key: "3", code: "Digit3" });
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
    fireEvent.keyDown(window, { key: "1", code: "Digit1" });
    fireEvent.keyDown(window, { key: "3", code: "Digit3" });
    expect(respond).not.toHaveBeenCalled();
    // Scrolled into view, it answers again.
    onScreen = () => true;
    flushObservers();
    fireEvent.keyDown(window, { key: "1", code: "Digit1" });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
  });

  it("answers no key once its card leaves the screen, before any observer says so", async () => {
    pending([PUSH]);
    const { api, respond } = fakeApi();
    render(
      <View api={api} requests={[PUSH]} rows={<ToolCard part={part(PUSH)} {...rowProps} />} />,
    );
    // On screen, and the observer has said so.
    flushObservers();
    // Scrolled away: the observer's report of it hasn't landed yet.
    onScreen = () => false;
    fireEvent.keyDown(window, { key: "1", code: "Digit1" });
    fireEvent.keyDown(window, { key: "3", code: "Digit3" });
    fireEvent.keyDown(window, { key: "2", code: "Digit2" });
    expect(respond).not.toHaveBeenCalled();
    expect(screen.queryByTestId("approval-always-rule")).toBeNull();
    // Back on screen, it answers at once, report or not.
    onScreen = () => true;
    fireEvent.keyDown(window, { key: "3", code: "Digit3" });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith(T, PUSH.id, {
      kind: "approval",
      decision: "deny",
      scope: "once",
    });
  });

  it("gives the keys to no card paged out of sight above the composer, whatever was reported", async () => {
    pending([PUSH, TAG]);
    const { api, respond } = fakeApi();
    render(<View api={api} requests={[PUSH, TAG]} rows={null} />);
    flushObservers();
    // Paged to the second card; the first is hidden, and only the shown one answers.
    fireEvent.click(screen.getByRole("button", { name: "Next approval" }));
    fireEvent.keyDown(window, { key: "3", code: "Digit3" });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith(T, TAG.id, {
      kind: "approval",
      decision: "deny",
      scope: "once",
    });
  });

  it("waits above the composer, visible and answerable, when a collapsed parent Task holds its row", async () => {
    const child = ask("r-child", "call-child", "git push origin sub/branch");
    pending([child]);
    const { api, respond } = fakeApi();
    const task = {
      type: "tool-Task",
      toolCallId: "call-task",
      state: "input-available",
      input: { description: "Push from a subagent", prompt: "Push it", subagent_type: "general" },
    } as unknown as AnyToolPart;
    const subagent = { id: "m-sub", role: "assistant", parts: [] } as never;
    const rows = (
      <ToolCard
        part={task}
        {...rowProps}
        subagents={new Map([["call-task", [subagent]]])}
        renderSubagent={() => <ToolCard part={part(child)} {...rowProps} />}
      />
    );
    render(<View api={api} requests={[child]} rows={rows} />);
    // Open, the Task shows its subagent's call, and the card is under that call's row.
    const slot = screen.getByTestId("approval-slot");
    expect(slot.getAttribute("data-tool-call-id")).toBe("call-child");
    expect(slot.contains(card())).toBe(true);
    // Collapsed, the row is inert and clipped: the card must not stay with it.
    const taskRow = screen
      .getAllByTestId("tool-card")
      .find((row) => row.getAttribute("data-tool") === "Task")!;
    fireEvent.click(taskRow.querySelector("button[aria-expanded]")!);
    expect(taskRow.querySelector("[inert]")).not.toBeNull();
    expect(screen.queryByTestId("approval-slot")).toBeNull();
    const fallback = screen.getByTestId("approval-fallback");
    expect(fallback.contains(card())).toBe(true);
    expect(card().closest("[hidden], [inert]")).toBeNull();
    // And it answers there.
    fireEvent.keyDown(window, { key: "1", code: "Digit1" });
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith(T, child.id, {
      kind: "approval",
      decision: "allow",
      scope: "once",
    });
  });

  it("keeps the focus on the control that had it when the card moves under its row", () => {
    pending([PUSH]);
    const { api } = fakeApi();
    const { rerender } = render(<View api={api} requests={[PUSH]} rows={null} />);
    const deny = screen.getByTestId("approval-deny");
    deny.focus();
    expect(document.activeElement).toBe(deny);
    rerender(
      <View api={api} requests={[PUSH]} rows={<ToolCard part={part(PUSH)} {...rowProps} />} />,
    );
    expect(screen.getByTestId("approval-slot").contains(deny)).toBe(true);
    expect(document.activeElement).toBe(deny);
  });

  describe("when the card that had focus goes", () => {
    it("hands focus to the next approval on screen, not to the page", async () => {
      pending([PUSH, TAG]);
      const { api } = fakeApi();
      const { rerender } = render(
        <Pane api={api} requests={[PUSH, TAG]} rows={rowsOf(PUSH, TAG)} />,
      );
      screen.getAllByTestId("approval-allow")[0]!.focus();
      // Answered: its card goes, its row stays.
      act(() => pending([TAG]));
      rerender(<Pane api={api} requests={[TAG]} rows={rowsOf(PUSH, TAG)} />);
      await waitFor(() => expect(document.activeElement).toBe(card()));
      expect(card().textContent).toContain("git tag v1.2.0");
    });

    it("hands focus to the composer once no approval is left, as when the turn ends", async () => {
      pending([PUSH]);
      const { api } = fakeApi();
      const { rerender } = render(<Pane api={api} requests={[PUSH]} rows={rowsOf(PUSH)} />);
      screen.getByTestId("approval-deny").focus();
      act(() => pending([]));
      rerender(<Pane api={api} requests={[]} rows={rowsOf(PUSH)} />);
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Message")));
    });

    it("hands focus on only within its own thread view, never into the one beside it", async () => {
      const BESIDE = "t-beside" as ThreadId;
      const asked = ask("r-beside", "call-beside", "git push origin beside");
      useThreadsStore.setState({
        byId: {
          [T]: { status: "needsApproval", pendingRequests: [PUSH] },
          [BESIDE]: { status: "needsApproval", pendingRequests: [asked] },
        } as never,
      });
      const { api } = fakeApi();
      // The chat, and a worker's thread beside it, each with an approval on screen.
      const views = (beside: readonly PendingRequest[]) => (
        <>
          <Pane api={api} requests={[PUSH]} rows={rowsOf(PUSH)} focused={false} />
          <Pane api={api} requests={beside} rows={rowsOf(asked)} threadId={BESIDE} />
        </>
      );
      const { rerender, container } = render(views([asked]));
      const besideView = container.querySelector<HTMLElement>(`[data-thread-view="${BESIDE}"]`)!;
      besideView.querySelector<HTMLElement>('[data-testid="approval-deny"]')!.focus();
      act(() =>
        useThreadsStore.setState({
          byId: {
            [T]: { status: "needsApproval", pendingRequests: [PUSH] },
            [BESIDE]: { status: "running", pendingRequests: [] },
          } as never,
        }),
      );
      rerender(views([]));
      // Its own composer, beside; not the chat's approval, though that is on screen.
      await waitFor(() =>
        expect(document.activeElement).toBe(
          besideView.querySelector('textarea[aria-label="Message"]'),
        ),
      );
    });

    it("leaves focus the user moved elsewhere where it is", async () => {
      pending([PUSH]);
      const { api } = fakeApi();
      const { rerender } = render(<Pane api={api} requests={[PUSH]} rows={rowsOf(PUSH)} />);
      screen.getByTestId("approval-deny").focus();
      const elsewhere = document.createElement("button");
      document.body.append(elsewhere);
      elsewhere.focus();
      act(() => pending([]));
      rerender(<Pane api={api} requests={[]} rows={rowsOf(PUSH)} />);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });

    it("keeps focus on its control when its row folds away and it waits above the composer", async () => {
      pending([PUSH]);
      const { api } = fakeApi();
      const { rerender } = render(<Pane api={api} requests={[PUSH]} rows={rowsOf(PUSH)} />);
      const deny = screen.getByTestId("approval-deny");
      deny.focus();
      rerender(<Pane api={api} requests={[PUSH]} rows={null} />);
      expect(screen.getByTestId("approval-fallback").contains(deny)).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(deny));
    });
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
    fireEvent.keyDown(window, { key: "1", code: "Digit1" });
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
