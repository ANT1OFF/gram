// @vitest-environment happy-dom
import { DEFAULT_SETTINGS } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { NewThreadDraft } from "@/composer/new-thread-draft";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import type { JoinedMachine } from "@/settings/machines-api";

import { MachinePicker } from "./machine-picker";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

/** Synthetic machines only: no host, tailnet or account behind any of them. */
const machine = (overrides: Partial<JoinedMachine>): JoinedMachine => ({
  id: "m-0123456789abcdef01234567",
  name: "build box",
  platform: "linux",
  fingerprint: "0123-4567-89AB-CDEF-0123",
  joinedAt: 1,
  confirmed: true,
  onlineSince: 2,
  claudeSignIn: "signedIn",
  ...overrides,
});
const ONLINE = machine({});
const { onlineSince: _online, claudeSignIn: _signIn, ...OFFLINE_BASE } = machine({});
const OFFLINE: JoinedMachine = { ...OFFLINE_BASE, id: "m-offline", name: "old box" };
const SIGNED_OUT = machine({ id: "m-signed-out", name: "new box", claudeSignIn: "notSignedIn" });

const serveMachines = (machines: readonly JoinedMachine[]) => {
  const fetch = vi.fn(async (path: string) =>
    path === "/machines/list" || path === "/machines/check-sign-in"
      ? new Response(JSON.stringify({ machines }), {
          headers: { "content-type": "application/json" },
        })
      : new Response("", { status: 404 }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useServerSettings.setState({ settings: undefined });
});

describe("MachinePicker", () => {
  it("lists confirmed machines, saying which are offline or not signed in", async () => {
    renderWithApi(
      <MachinePicker
        machines={[ONLINE, OFFLINE, SIGNED_OUT]}
        value={undefined}
        onChange={() => {}}
      />,
      {},
    );
    const picker = screen.getByRole("combobox", { name: "Machine: this machine" });
    fireEvent.click(picker);
    const list = await screen.findByRole("listbox");
    expect(within(list).getByRole("option", { name: /build box/ }).textContent).toBe("build box");
    expect(within(list).getByRole("option", { name: /old box/ }).textContent).toContain("offline");
    // Why, and the fix, on hover: as Settings → Machines says it.
    expect(
      within(list)
        .getByRole("option", { name: /old box/ })
        .getAttribute("aria-description"),
    ).toBe("It hasn't dialled in since Gram started.\nCheck gram-host status on old box.");
    expect(within(list).getByRole("option", { name: /new box/ }).textContent).toContain(
      "not signed in",
    );
  });

  it("marks a picked machine that can't take the thread, and stays out with none joined", () => {
    const { rerender } = renderWithApi(
      <MachinePicker machines={[SIGNED_OUT]} value="m-signed-out" onChange={() => {}} />,
      {},
    );
    expect(screen.getByRole("combobox", { name: "Machine: new box, not signed in" })).toBeTruthy();
    expect(screen.getByTestId("where-machine-problem")).toBeTruthy();
    rerender(<MachinePicker machines={[]} value={undefined} onChange={() => {}} />);
    expect(screen.queryByTestId("where-machine")).toBeNull();
  });
});

const pick = async (name: RegExp) => {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId("where-machine"));
  await user.click(await screen.findByRole("option", { name }));
};

describe("New thread on a joined machine", () => {
  beforeEach(() => useServerSettings.setState({ settings: DEFAULT_SETTINGS }));

  it("shows Machine beside the folder, and a pick makes the checkout a new worktree", async () => {
    serveMachines([ONLINE, SIGNED_OUT]);
    renderWithApi(<NewThreadDraft />, createMockApi({ speed: 0, autoplay: false }));
    const where = await screen.findByTestId("new-where");
    await within(where).findByTestId("where-machine");

    fireEvent.click(await screen.findByRole("radio", { name: "Current checkout" }));
    await pick(/build box/);
    const current = screen.getByRole("radio", { name: "Current checkout" });
    expect(current.hasAttribute("disabled")).toBe(true);
    expect(current.getAttribute("title")).toBe(
      "A thread on build box runs in a new worktree there.",
    );
    expect(screen.getByRole("radio", { name: "New worktree" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.getByTestId("machine-note").textContent).toContain("runs on build box");
  });

  it("says before it starts that a machine isn't signed in, with Sign in there", async () => {
    serveMachines([ONLINE, SIGNED_OUT]);
    renderWithApi(<NewThreadDraft />, createMockApi({ speed: 0, autoplay: false }));
    await pick(/new box/);
    const note = await screen.findByTestId("machine-note");
    expect(note.textContent).toContain(
      "Claude Code isn't signed in on new box. Run `claude /login` there.",
    );
    expect(within(note).getByRole("button", { name: "Sign in to Claude on new box" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start chat" }).hasAttribute("disabled")).toBe(
        true,
      ),
    );
  });
});
