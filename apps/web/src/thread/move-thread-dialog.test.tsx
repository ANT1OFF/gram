// @vitest-environment happy-dom
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  type DesktopBridge,
  type HostedThreadMoved,
  type ThreadId,
} from "@gram/contracts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import { threadWorking } from "@/orchestration/tree-model";
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
const BUNDLE = { format: 1, exportedAt: 1_700_000_000_000, notes: ["Its terminal stays here."] };

/** The desktop app signed in to one server that takes threads; its send answers as told. */
const install = (sent: HostedThreadMoved) => {
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
    moveThread: async (origin, workspace, bundle) => {
      calls.push(`send ${origin} ${workspace} ${JSON.stringify(bundle)}`);
      return sent;
    },
  };
  useServerSettings.setState({
    settings: applySettingsPatch(DEFAULT_SETTINGS, { experimental: { embedding: true } }),
  });
  (window as { gram?: Partial<DesktopBridge> }).gram = { platform: "darwin", hostedDevice: bridge };
  // The local server's own calls, in order.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push(`${String(url)} ${String(init.body)}`);
      return new Response(JSON.stringify(String(url).endsWith("/threads/export") ? BUNDLE : {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
};

let api: MockApi;
let threadId: ThreadId;

beforeEach(async () => {
  api = createMockApi({ speed: 0, autoplay: false });
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    useThreadsStore.getState().applyEvent(event);
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
  const { byId, statusDetail } = useThreadsStore.getState();
  const plain = Object.values(byId).find(
    (each) =>
      each !== undefined &&
      each.thread.workspaceId === undefined &&
      each.thread.role === undefined &&
      !threadWorking(each, statusDetail[each.thread.id]),
  );
  if (plain === undefined) throw new Error("the mock has no thread at rest");
  threadId = plain.thread.id;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useThreadDialogs.setState({ dialog: undefined, error: undefined });
  useServerSettings.setState({ settings: undefined });
  delete (window as { gram?: unknown }).gram;
});

const moveIt = async () => {
  useThreadDialogs.getState().open({ kind: "moveThread", threadId });
  renderWithApi(<ThreadDialogs />, api);
  await screen.findByTestId("move-thread-dialog");
  fireEvent.click(await screen.findByTestId("move-thread-start"));
};

describe("MoveThreadDialog", () => {
  it("exports, sends the bundle as it is, and only then leaves a read-only copy here", async () => {
    const calls = install({
      ok: true,
      threadId,
      notes: ["Its edits are back."],
      url: `${ORIGIN}/t`,
    });
    await moveIt();
    const after = await screen.findByTestId("move-thread-after");
    expect(calls.map((call) => call.split(" ")[0])).toEqual([
      "/threads/export",
      "send",
      "/threads/settle",
    ]);
    expect(calls[1]).toBe(`send ${ORIGIN} w1 ${JSON.stringify(BUNDLE)}`);
    expect(JSON.parse(calls[2]!.slice("/threads/settle ".length))).toEqual({
      threadId,
      exportedAt: BUNDLE.exportedAt,
      to: "Platform on gram.example.com",
      url: `${ORIGIN}/t`,
    });
    expect(after.textContent).toContain("This copy is read-only");
    expect(after.textContent).toContain("Its edits are back.");
    expect(after.textContent).toContain("Its terminal stays here.");
  });

  it("changes nothing here when the server refuses it, and says so in its words", async () => {
    const calls = install({ ok: false, why: "Start your sandbox first." });
    await moveIt();
    const refused = await screen.findByTestId("move-thread-error");
    expect(refused.textContent).toContain("Start your sandbox first.");
    expect(refused.textContent).toContain("Nothing changed here");
    expect(calls.some((call) => call.startsWith("/threads/settle"))).toBe(false);
    expect(screen.getByTestId("move-thread-start").textContent).toBe("Try again");
  });
});
