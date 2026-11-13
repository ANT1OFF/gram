// @vitest-environment happy-dom
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  type DesktopBridge,
  type HostedMoveCheck,
  type HostedMoveDone,
  type HostedMoveProgress,
} from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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

/** A desktop app signed in to one server, whose move answers as the test says. */
const install = (
  move: {
    check?: HostedMoveCheck;
    done?: () => Promise<HostedMoveDone>;
  } = {},
  { hosted = true, signedIn = true }: { hosted?: boolean; signedIn?: boolean } = {},
) => {
  const calls: string[] = [];
  let progress: ((progress: HostedMoveProgress) => void) | undefined;
  const bridge: Bridge = {
    state: async () => ({
      servers: [
        {
          origin: ORIGIN,
          name: "Example",
          signedIn,
          paused: false,
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
    move: {
      check: async (origin, workspace, workspaceId) => {
        calls.push(`check ${origin} ${workspace} ${workspaceId}`);
        return (
          move.check ?? {
            ok: true,
            repositories: [
              { name: "example-co/billing-api", reached: true },
              { name: "example-co/billing-fixtures", reached: false },
            ],
            autonomyCeiling: "supervised",
          }
        );
      },
      start: async (origin, workspace, workspaceId) => {
        calls.push(`start ${origin} ${workspace} ${workspaceId}`);
        return (
          move.done?.() ?? {
            ok: true,
            movedAt: Date.UTC(2026, 10, 13, 9, 48),
            url: `${ORIGIN}/w/w1/threads`,
            left: ["example-co/billing-fixtures"],
          }
        );
      },
      cancel: async () => {
        calls.push("cancel");
      },
      onProgress: (callback) => {
        progress = callback;
        return () => {
          progress = undefined;
        };
      },
    },
  };
  useServerSettings.setState({
    settings: applySettingsPatch(DEFAULT_SETTINGS, { experimental: { embedding: hosted } }),
  });
  (window as { gram?: Partial<DesktopBridge> }).gram = { platform: "darwin", hostedDevice: bridge };
  return { calls, tell: (next: HostedMoveProgress) => act(() => progress?.(next)) };
};

async function seedStore(api: MockApi) {
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    useThreadsStore.getState().applyEvent(event);
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
}

let api: MockApi;
let workspaceId: Awaited<ReturnType<MockApi["simulateOrchestration"]>>["workspaceId"];

beforeEach(async () => {
  api = createMockApi({ speed: 0, autoplay: false });
  workspaceId = (await api.simulateOrchestration()).workspaceId;
  await seedStore(api);
});

afterEach(() => {
  cleanup();
  useThreadDialogs.setState({ dialog: undefined, error: undefined });
  useServerSettings.setState({ settings: undefined });
  delete (window as { gram?: unknown }).gram;
});

const open = async () => {
  useThreadDialogs.getState().open({ kind: "moveWorkspace", workspaceId });
  renderWithApi(<ThreadDialogs />, api);
  return screen.findByTestId("move-workspace-dialog");
};

describe("MoveWorkspaceDialog", () => {
  it("says what goes, what stays and what the server says, then moves and says where it runs", async () => {
    let finish: ((done: HostedMoveDone) => void) | undefined;
    const { calls, tell } = install({
      done: () => new Promise((resolve) => (finish = resolve)),
    });
    const dialog = await open();

    expect(dialog.textContent).toContain("to a server");
    expect(screen.getByTestId("move-workspace-to").textContent).toContain(
      "Platform · gram.example.com",
    );
    expect(screen.getByTestId("move-workspace-goes").textContent).toContain("Memory");
    expect(dialog.textContent).toContain("Stays on this Mac");
    expect(screen.getByTestId("move-workspace-stays").textContent).toContain("Sign-ins and keys");
    // The server's word on its repositories and its autonomy arrives with the check.
    const repositories = await screen.findByText("example-co/billing-fixtures");
    expect(repositories.textContent).toContain("The workspace moves without it.");
    expect(dialog.textContent).toContain("Kept here afterwards, never deleted.");
    expect(calls).toEqual([`check ${ORIGIN} w1 ${workspaceId}`]);

    const start = screen.getByTestId("move-workspace-start") as HTMLButtonElement;
    expect(start.textContent).toBe("Move to Platform");
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);

    // Under way: three steps, how much is sent, and a way out until the server has it all.
    const steps = await screen.findByTestId("move-workspace-steps");
    expect(steps.querySelector('[data-step="stopping"]')?.getAttribute("data-state")).toBe("now");
    await tell({ stage: "sending", sentBytes: 31 * 1024 * 1024, totalBytes: 50 * 1024 * 1024 });
    expect(steps.querySelector('[data-step="sending"]')?.getAttribute("data-state")).toBe("now");
    expect(screen.getByTestId("move-workspace-dialog").textContent).toContain("31 MB of 50 MB");
    expect((screen.getByTestId("move-workspace-cancel") as HTMLButtonElement).disabled).toBe(false);
    await tell({ stage: "settingUp" });
    expect((screen.getByTestId("move-workspace-cancel") as HTMLButtonElement).disabled).toBe(true);

    await act(async () =>
      finish?.({
        ok: true,
        movedAt: Date.UTC(2026, 10, 13, 9, 48),
        url: `${ORIGIN}/w/w1/threads`,
        left: ["example-co/billing-fixtures"],
      }),
    );
    const moved = await screen.findByTestId("move-workspace-after");
    expect(screen.getByTestId("move-workspace-dialog").textContent).toContain(
      "now runs in Platform",
    );
    expect(screen.getByTestId("move-workspace-dialog").textContent).toContain(
      "was told what didn't come: example-co/billing-fixtures",
    );
    expect(moved.textContent).toContain("Nothing was deleted.");
    expect(screen.getByTestId("move-workspace-open")).toBeTruthy();
    expect(calls.at(-1)).toBe(`start ${ORIGIN} w1 ${workspaceId}`);
  });

  it("goes back to the review when a move is cancelled or fails, with why", async () => {
    let finish: ((done: HostedMoveDone) => void) | undefined;
    const { calls } = install({ done: () => new Promise((resolve) => (finish = resolve)) });
    await open();
    const start = screen.getByTestId("move-workspace-start") as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    fireEvent.click(await screen.findByTestId("move-workspace-cancel"));
    expect(calls).toContain("cancel");
    await act(async () => finish?.({ ok: false, cancelled: true, why: "Cancelled." }));
    expect(await screen.findByTestId("move-workspace-start")).toBeTruthy();
    expect(screen.queryByTestId("move-workspace-error")).toBeNull();

    fireEvent.click(screen.getByTestId("move-workspace-start"));
    await screen.findByTestId("move-workspace-steps");
    await act(async () => finish?.({ ok: false, why: "The server refused the workspace." }));
    expect((await screen.findByTestId("move-workspace-error")).textContent).toBe(
      "The server refused the workspace. Nothing was moved.",
    );
  });

  it("does not offer the move the server refuses", async () => {
    install({ check: { ok: false, why: "Example Co has turned moving workspaces off." } });
    await open();
    expect((await screen.findByTestId("move-workspace-refused")).textContent).toBe(
      "Example Co has turned moving workspaces off.",
    );
    expect((screen.getByTestId("move-workspace-start") as HTMLButtonElement).disabled).toBe(true);
  });

  it("is nothing without the hosted features, or without a sign-in", async () => {
    install({}, { hosted: false });
    useThreadDialogs.getState().open({ kind: "moveWorkspace", workspaceId });
    const first = renderWithApi(<ThreadDialogs />, api);
    await act(async () => {});
    expect(screen.queryByTestId("move-workspace-dialog")).toBeNull();
    first.unmount();

    install({}, { signedIn: false });
    renderWithApi(<ThreadDialogs />, api);
    await act(async () => {});
    expect(screen.queryByTestId("move-workspace-dialog")).toBeNull();
  });
});
