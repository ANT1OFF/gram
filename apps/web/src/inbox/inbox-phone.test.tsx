// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import type { Ask } from "@/orchestration/ask-model";
import type { NeedsYouItem } from "@/orchestration/needs-you-items";
import { useDerivedAsks } from "@/orchestration/needs-you-store";
import { renderWithApi } from "@/panels/test-utils";
import { useLayoutStore } from "@/stores/layout";

import { answersOnCard } from "./inbox-detail";
import { useInboxStore } from "./inbox-store";
import { InboxView } from "./inbox-view";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to: _to, params: _params, ...rest }: Record<string, unknown>) => (
    <a href="#" {...rest}>
      {children as ReactNode}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useRouterState: (options?: { select?: (state: { location: { pathname: string } }) => unknown }) =>
    options?.select?.({ location: { pathname: "/" } }),
  useLocation: (options?: { select?: (location: { pathname: string }) => unknown }) =>
    options?.select ? options.select({ pathname: "/" }) : { pathname: "/" },
}));

/** A window `phone` wide or not, as `usePhone` reads it. */
function stubWidth(phone: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("max-width") ? phone : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })),
  );
}

const THREAD = "t-plan" as ThreadId;

/** A plan to review: every option opens it, so a card says what it asks and opens its thread. */
const plan: NeedsYouItem = {
  key: "ask:plan",
  ids: ["plan"],
  kind: "plan",
  title: "Review the migration plan",
  where: "Migrate settings",
  workspace: "api",
  threadId: THREAD,
  owned: true,
  ask: { options: [{ label: "Review plan", action: { kind: "open" } }] } as unknown as Ask,
};

function seedList(items: readonly NeedsYouItem[]) {
  useDerivedAsks.setState({
    needsYou: {
      groups: [],
      sections: [{ key: "reviews", label: "Reviews", items }],
      items,
      later: [],
    },
  });
}

beforeEach(() => {
  sessionStorage.clear();
  seedList([plan]);
  useInboxStore.setState({ open: true, leftForThread: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useInboxStore.setState({ open: false });
});

describe("the Inbox on a phone", () => {
  it("is a full-screen sheet: its title, a Close, one column of cards and no key legend", async () => {
    stubWidth(true);
    renderWithApi(<InboxView />, createMockApi({ speed: 0, autoplay: false, persist: false }));
    const sheet = await screen.findByTestId("inbox");
    expect(within(sheet).getByTestId("sheet-header").textContent).toContain("Needs you");
    expect(within(sheet).getByTestId("inbox-close").getAttribute("aria-label")).toBe("Close Inbox");
    expect(within(sheet).queryByTestId("inbox-keys")).toBeNull();
    expect(within(sheet).queryByTestId("inbox-detail")).toBeNull();
    expect(within(sheet).getAllByTestId("inbox-card")).toHaveLength(1);
    expect(sheet.className).toContain("phone:inset-0");
  });

  it("opens a card's thread on a tap when it has nothing to answer in place", async () => {
    stubWidth(true);
    const openThread = vi.spyOn(useLayoutStore.getState(), "openThread");
    renderWithApi(<InboxView />, createMockApi({ speed: 0, autoplay: false, persist: false }));
    const card = await screen.findByTestId("inbox-card");
    expect(within(card).getByTestId("inbox-card-summary").textContent).toBe(
      "Review the migration plan",
    );
    fireEvent.click(within(card).getByTestId("inbox-card-summary"));
    await waitFor(() => expect(useInboxStore.getState().leftForThread).toBe(true));
    expect(openThread).toHaveBeenCalledWith(THREAD);
  });

  it("keeps the two panes and the key legend on a wider window", async () => {
    stubWidth(false);
    renderWithApi(<InboxView />, createMockApi({ speed: 0, autoplay: false, persist: false }));
    const sheet = await screen.findByTestId("inbox");
    expect(within(sheet).queryByTestId("sheet-header")).toBeNull();
    expect(within(sheet).getByTestId("inbox-keys")).toBeTruthy();
    expect(within(sheet).getByTestId("inbox-detail")).toBeTruthy();
    expect(within(sheet).queryByTestId("inbox-card")).toBeNull();
  });
});

describe("answersOnCard", () => {
  it("answers asks, waits, watches and failures in place, and opens a plan", () => {
    expect(answersOnCard(plan)).toBe(false);
    const approval = {
      ...plan,
      kind: "approval",
      ask: { options: [{ action: { kind: "allow" } }] } as unknown as Ask,
    } satisfies NeedsYouItem;
    expect(answersOnCard(approval)).toBe(true);
    expect(answersOnCard({ ...plan, ask: undefined, kind: "watch" })).toBe(true);
    expect(answersOnCard({ ...plan, ask: undefined, kind: "wait" })).toBe(false);
  });
});
