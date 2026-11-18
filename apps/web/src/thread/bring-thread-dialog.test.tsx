// @vitest-environment happy-dom
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  type DesktopBridge,
  type HostedThreadFetched,
  type HostedThreadSettled,
  type ThreadId,
} from "@gram/contracts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useThreadsStore } from "@/stores/threads";
import { ThreadDialogs } from "@/thread/thread-dialogs";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) =>
    select({ pathname: "/" }),
}));

type Bridge = NonNullable<DesktopBridge["hostedDevice"]>;
const ORIGIN = "https://gram.example.com";
const ok = async () => ({ ok: true as const });
const BUNDLE = { format: 1, exportedAt: 1_700_000_000_000 };

/** Signed in to the server the thread went to; its export and settle answer as told. */
const install = (fetched: HostedThreadFetched, ...settles: HostedThreadSettled[]) => {
  const calls: string[] = [];
  const bridge: Bridge = {
    state: async () => ({
      servers: [
        {
          origin: ORIGIN,
          name: "Example",
          signedIn: true,
          paused: false,
          takesThreads: true,
          givesThreads: true,
          workspaces: [
            {
              id: "w1",
              name: "Platform",
              organisation: "Example Co",
              policy: "on",
              lending: "off",
              readOnly: false,
              folders: [],
              connected: false,
            },
          ],
        },
      ],
    }),
    signIn: ok,
    signOut: async () => {},
    refresh: ok,
    lend: ok,
    resume: ok,
    stop: async () => {},
    liftPause: ok,
    startAfresh: ok,
    activity: async () => null,
    onChange: () => () => {},
    moveThread: async () => ({ ok: false, why: "unused" }),
    fetchThread: async (origin, workspace, id) => {
      calls.push(`fetch ${origin} ${workspace} ${id}`);
      return fetched;
    },
    settleThread: async (origin, workspace, id, exportedAt) => {
      calls.push(`settle ${origin} ${workspace} ${id} ${exportedAt}`);
      return settles.length > 1 ? settles.shift()! : settles[0]!;
    },
  };
  useServerSettings.setState({
    settings: applySettingsPatch(DEFAULT_SETTINGS, { experimental: { embedding: true } }),
  });
  (window as { gram?: Partial<DesktopBridge> }).gram = { platform: "darwin", hostedDevice: bridge };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push(`${String(url)} ${String(init.body)}`);
      return new Response(JSON.stringify({ notes: ["Your own notes are on aside/cart."] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
};

let api: MockApi;
let threadId: ThreadId;
let root: string;

beforeEach(async () => {
  api = createMockApi({ speed: 0, autoplay: false });
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    useThreadsStore.getState().applyEvent(event);
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
  const projects = await api.listProjects();
  const { byId } = useThreadsStore.getState();
  const plain = Object.values(byId).find(
    (each) =>
      each !== undefined &&
      each.thread.workspaceId === undefined &&
      projects.some((project) => project.id === each.thread.projectId),
  );
  if (plain === undefined) throw new Error("the mock has no thread in a project");
  threadId = plain.thread.id;
  root = projects.find((project) => project.id === plain.thread.projectId)!.root;
  // It moved to Platform from here.
  useThreadsStore.setState({
    byId: {
      ...byId,
      [threadId]: {
        ...plain,
        thread: {
          ...plain.thread,
          parked: true,
          transferredTo: {
            name: "Platform on gram.example.com",
            at: 1_699_000_000_000,
            server: { origin: ORIGIN, workspaceId: "w1" },
          },
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useThreadDialogs.setState({ dialog: undefined, error: undefined });
  useServerSettings.setState({ settings: undefined });
  delete (window as { gram?: unknown }).gram;
});

const bringIt = async () => {
  useThreadDialogs.getState().open({ kind: "bringThread", threadId });
  renderWithApi(<ThreadDialogs />, api);
  await screen.findByTestId("bring-thread-dialog");
  const start = await screen.findByTestId("bring-thread-start");
  await vi.waitFor(() => expect(start.hasAttribute("disabled")).toBe(false));
  fireEvent.click(start);
};

describe("BringThreadDialog", () => {
  it("asks the server, puts it back here, and only then settles the copy there", async () => {
    const calls = install({ ok: true, bundle: BUNDLE }, { ok: true });
    await bringIt();
    const after = await screen.findByTestId("bring-thread-after");
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["fetch", "/threads/import", "settle"]);
    expect(calls[0]).toBe(`fetch ${ORIGIN} w1 ${threadId}`);
    expect(JSON.parse(calls[1]!.slice("/threads/import ".length))).toEqual({
      bundle: BUNDLE,
      root,
      from: "Platform on gram.example.com",
    });
    expect(calls[2]).toBe(`settle ${ORIGIN} w1 ${threadId} ${BUNDLE.exportedAt}`);
    expect(after.textContent).toContain("aside/cart");
  });

  it("shows the server's refusal and puts nothing back", async () => {
    const calls = install({ ok: false, why: "Example Co keeps its threads." }, { ok: true });
    await bringIt();
    const error = await screen.findByTestId("bring-thread-error");
    expect(error.textContent).toContain("Example Co keeps its threads.");
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["fetch"]);
  });

  it("says a copy there that didn't settle, and settles it again without bringing it twice", async () => {
    const calls = install(
      { ok: true, bundle: BUNDLE },
      { ok: false, why: "The server didn't answer.", unknown: true },
      { ok: true },
    );
    await bringIt();
    const after = await screen.findByTestId("bring-thread-after");
    expect(after.textContent).toContain("still open");
    fireEvent.click(screen.getByTestId("bring-thread-settle"));
    await vi.waitFor(() => expect(screen.queryByTestId("bring-thread-settle")).toBeNull());
    expect(calls.map((call) => call.split(" ")[0])).toEqual([
      "fetch",
      "/threads/import",
      "settle",
      "settle",
    ]);
  });
});
