// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type ThreadSummary, type WorkspaceState } from "@gram/contracts";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, screen } from "@testing-library/react";
import { createElement, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Api } from "@/api/types";
import { renderInRouter } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";

import {
  LANDING_WAIT_MS,
  resetLaunchForTests,
  useForgoLandingAway,
  useLandOnOrchestrator,
} from "./home";

/** What the server lists; `undefined` while it hasn't answered, and its calls wait. */
let listed: readonly WorkspaceState[] | undefined;
let unanswered: (() => void)[] = [];
const api: Partial<Api> = {
  listWorkspaces: () =>
    new Promise((resolve) => {
      const give = () => resolve(listed!);
      if (listed === undefined) unanswered.push(give);
      else give();
    }),
};
/** The page's query client, to tell it the workspaces changed, as a server event does. */
let client: QueryClient;

const workspace = (id: string, orchestratorThreadId?: string) =>
  ({
    workspace: {
      id,
      name: id,
      ...(orchestratorThreadId === undefined ? {} : { orchestratorThreadId }),
    },
  }) as unknown as WorkspaceState;

const summary = (id: string, lastActivityAt: number) =>
  ({ thread: { id, lastActivityAt } }) as unknown as ThreadSummary;

beforeEach(() => {
  vi.useFakeTimers();
  listed = undefined;
  unanswered = [];
  resetLaunchForTests("/");
  localStorage.clear();
  useThreadsStore.setState({ ready: true, byId: { "t-a": summary("t-a", 1) } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useThreadsStore.setState({ ready: false, byId: {} });
  useServerSettings.setState({ settings: undefined });
});

/** The home page, saying what the hook told it: hold itself back, or show. */
function Landing() {
  const queryClient = useQueryClient();
  useEffect(() => {
    client = queryClient;
  }, [queryClient]);
  return createElement("output", {
    "data-testid": "landing",
    "data-holds": String(useLandOnOrchestrator()),
  });
}

/** Whether the page holds itself back. */
const holds = () => screen.getByTestId("landing").dataset["holds"] === "true";

/** The home page, holding the hook, with the server's answer so far heard; `rerender()` renders
 * it again. */
const landing = async () => {
  const shown = await renderInRouter(createElement(Landing), { api });
  await settle();
  return { ...shown, rerender: () => shown.rerender(createElement(Landing)) };
};

/** The server lists `workspaces` from now on, and the page hears that they changed. */
const serve = async (workspaces: readonly WorkspaceState[]) => {
  listed = workspaces;
  for (const give of unanswered.splice(0)) give();
  await act(() => client.invalidateQueries({ queryKey: ["workspaces"] }));
  await settle();
};

/** A page that only settles the launch when it isn't the home page. */
function ForgoLandingAway() {
  useForgoLandingAway();
  return null;
}

/** Lets a navigation the hook asked for get under way. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

type Shown = Awaited<ReturnType<typeof landing>>;

/** Where the router is, and whether it got there by replacing the home page in the history. */
const at = ({ router }: Shown) => ({
  pathname: router.state.location.pathname,
  entries: router.history.length,
});

/** The router went, in place of the home page, to `threadId`. */
const landedOn = async (shown: Shown, threadId: string) =>
  vi.waitFor(() => expect(at(shown)).toEqual({ pathname: `/t/${threadId}`, entries: 1 }));

/** The router is still on the home page. */
const stayedHome = async (shown: Shown) => {
  await settle();
  expect(at(shown)).toEqual({ pathname: "/", entries: 1 });
};

describe("useLandOnOrchestrator", () => {
  it("holds the home page until the workspaces are known, then lands on the orchestrator", async () => {
    const shown = await landing();
    expect(holds()).toBe(true);
    await stayedHome(shown);

    await serve([workspace("w-a", "t-a")]);
    // On its way there, the home page stays empty.
    expect(holds()).toBe(true);
    await landedOn(shown, "t-a");
  });

  it("shows the home page with no workspace, and stays put when one turns up later", async () => {
    listed = [];
    const shown = await landing();
    expect(holds()).toBe(false);

    await serve([workspace("w-a", "t-a")]);
    expect(holds()).toBe(false);
    await stayedHome(shown);
  });

  it("gives up after a while when the server doesn't answer, and never lands after", async () => {
    const shown = await landing();
    expect(holds()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(LANDING_WAIT_MS);
    });
    expect(holds()).toBe(false);

    await serve([workspace("w-a", "t-a")]);
    expect(holds()).toBe(false);
    await stayedHome(shown);
  });

  it("doesn't land once the user went elsewhere before the workspaces came", async () => {
    await renderInRouter(createElement(ForgoLandingAway), { path: "/settings/general" });
    listed = [workspace("w-a", "t-a")];
    const shown = await landing();
    expect(holds()).toBe(false);
    await stayedHome(shown);
  });

  it("opens the thread shown last with Open at launch at Last thread, once the threads are known", async () => {
    useServerSettings.setState({
      settings: { ...DEFAULT_SETTINGS, layout: { openAtLaunch: "thread" } },
    });
    localStorage.setItem("gram.lastThread", "t-b");
    useThreadsStore.setState({ ready: false, byId: {} });
    listed = [workspace("w-a", "t-a")];
    const shown = await landing();
    const { rerender } = shown;
    expect(holds()).toBe(true);
    await stayedHome(shown);

    useThreadsStore.setState({
      ready: true,
      byId: { "t-a": summary("t-a", 9), "t-b": summary("t-b", 1) },
    });
    rerender();
    await landedOn(shown, "t-b");
  });

  it("falls back to the orchestrator when the last thread is gone", async () => {
    useServerSettings.setState({
      settings: { ...DEFAULT_SETTINGS, layout: { openAtLaunch: "thread" } },
    });
    localStorage.setItem("gram.lastThread", "t-gone");
    listed = [workspace("w-a", "t-a")];
    await landedOn(await landing(), "t-a");
  });

  it("keeps opening the orchestrator at Last orchestrator, whatever thread was shown last", async () => {
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    localStorage.setItem("gram.lastThread", "t-b");
    useThreadsStore.setState({
      ready: true,
      byId: { "t-a": summary("t-a", 1), "t-b": summary("t-b", 9) },
    });
    listed = [workspace("w-a", "t-a")];
    await landedOn(await landing(), "t-a");
  });

  it("doesn't land a launch that opened anywhere but home", async () => {
    resetLaunchForTests("/t/t-b");
    listed = [workspace("w-a", "t-a")];
    const shown = await landing();
    expect(holds()).toBe(false);
    await stayedHome(shown);
  });
});
