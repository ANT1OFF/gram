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

  it("shows Machine first, and a pick runs the chat in its home there", async () => {
    serveMachines([ONLINE, SIGNED_OUT]);
    renderWithApi(<NewThreadDraft />, createMockApi({ speed: 0, autoplay: false }));
    const where = await screen.findByTestId("new-where");
    await within(where).findByTestId("where-machine");
    // The machine is the first stop: the Folder chip lists its folders.
    expect(
      within(where)
        .getByTestId("where-machine")
        .compareDocumentPosition(within(where).getByTestId("where-folder")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await pick(/build box/);
    expect(screen.getByTestId("where-folder").getAttribute("aria-label")).toBe(
      "Folder on build box",
    );
    expect(screen.getByTestId("where-folder").textContent).toContain("~");
    // Checked by the machine's host: its home, as it is, with no checkout to choose.
    const note = await screen.findByTestId("machine-folder-note");
    expect(note.textContent).toBe(
      "Runs on build box in /home/dev, as it is: no worktree, diff or pull request outside a repository.",
    );
    expect(screen.queryByRole("radio", { name: "Current checkout" })).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start chat" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
  });

  it("types or browses a folder there, through its host, and refuses a credential folder", async () => {
    serveMachines([ONLINE]);
    const user = userEvent.setup();
    renderWithApi(<NewThreadDraft />, createMockApi({ speed: 0, autoplay: false }));
    await pick(/build box/);
    await user.click(screen.getByTestId("new-more-options"));
    const field = await screen.findByRole("combobox", { name: "Folder on build box" });
    await user.clear(field);
    await user.type(field, "~/code/dotfiles");
    expect((await screen.findByTestId("machine-folder-note")).textContent).toBe(
      "Runs on build box in /home/dev/code/dotfiles, as it is, on its branch main.",
    );

    await user.clear(field);
    await user.type(field, "~/.ssh");
    expect((await screen.findAllByTestId("folder-problem"))[0]?.textContent).toBe(
      "Gram doesn't run a chat in /home/dev/.ssh: it holds keys or credentials.",
    );
    expect(screen.getByRole("button", { name: "Start chat" }).hasAttribute("disabled")).toBe(true);

    // The browser lists the machine's folders, never its credential folders or Gram Host's own.
    await user.clear(field);
    await user.type(field, "~");
    await user.click(screen.getByRole("button", { name: "Browse" }));
    const browser = await screen.findByTestId("folder-browser");
    const folders = await within(browser).findByRole("listbox", { name: "Folders" });
    await waitFor(() => expect(within(folders).getAllByRole("option").length).toBeGreaterThan(0));
    const names = within(folders)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(names).toEqual(["code", "Downloads", "scratch"]);
  });

  it("still makes a new worktree there from a repository of this Mac", async () => {
    serveMachines([ONLINE]);
    const api = createMockApi({ speed: 0, autoplay: false });
    await api.createThread({
      projectRoot: "~/Documents/code/infra",
      checkout: { kind: "current" },
    });
    const user = userEvent.setup();
    renderWithApi(<NewThreadDraft />, api);
    await pick(/build box/);
    await user.click(screen.getByTestId("where-folder"));
    const menu = await screen.findByTestId("where-folder-menu");
    expect(within(menu).getByText("New worktree on build box, from")).toBeTruthy();
    await user.click(within(menu).getByRole("button", { name: /infra/ }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "New worktree" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(screen.getByRole("radio", { name: "Current checkout" }).hasAttribute("disabled")).toBe(
      true,
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
