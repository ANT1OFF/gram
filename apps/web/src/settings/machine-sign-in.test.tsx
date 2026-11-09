// @vitest-environment happy-dom
import type { TerminalId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";

import type { JoinedMachine } from "./machines-api";
import { MachinesPage } from "./machines-page";

// The emulator isn't what is tested: a stand-in that ends the command when asked.
vi.mock("@/panels/terminal/terminal-view", () => ({
  TerminalView: ({
    terminalId,
    onExit,
  }: {
    terminalId: string;
    onExit?: (exit: object) => void;
  }) => (
    <button type="button" data-testid="fake-terminal" onClick={() => onExit?.({ code: 0 })}>
      {terminalId}
    </button>
  ),
}));

/** A synthetic machine: no host, tailnet or account behind it. */
const machine = (overrides: Partial<JoinedMachine> = {}): JoinedMachine => ({
  id: "m-synthetic",
  name: "build box",
  platform: "linux",
  fingerprint: "0123-4567-89AB-CDEF-0123",
  joinedAt: 1,
  confirmed: true,
  onlineSince: 2,
  claudeSignIn: "notSignedIn",
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("signing a joined machine in", () => {
  it("says a machine isn't signed in, and Sign in opens a shell there, then asks again", async () => {
    let signedIn = false;
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        paths.push(path);
        if (path === "/machines/check-sign-in") signedIn = true;
        return new Response(
          JSON.stringify({
            machines: [machine(signedIn ? { claudeSignIn: "signedIn" } : {})],
          }),
        );
      }),
    );
    const terminalOpen = vi.fn(async () => ({
      terminalId: "term-sign-in" as TerminalId,
      cwd: "~",
      shell: "/bin/zsh",
      script: "Sign in to Claude",
    }));
    const terminalClose = vi.fn(async () => {});
    renderWithApi(<MachinesPage />, { terminalOpen, terminalClose });

    expect((await screen.findByTestId("machines-sign-in-problem")).textContent).toBe(
      "Claude Code isn't signed in on build box. Run `claude /login` there.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude on build box" }));
    // Only the machine is named: the server fixes the command and its folder.
    await waitFor(() =>
      expect(terminalOpen).toHaveBeenCalledWith({ signIn: "m-synthetic", cols: 100, rows: 16 }),
    );
    fireEvent.click(await screen.findByTestId("fake-terminal"));
    await waitFor(() =>
      expect(screen.getByTestId("machine-sign-in-status").textContent).toBe(
        "Claude Code is signed in on build box.",
      ),
    );
    expect(paths).toContain("/machines/check-sign-in");
    expect(screen.queryByTestId("machines-sign-in-problem")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("machine-sign-in")).toBeNull();
  });

  it("offers no Sign in for a machine that is signed in, offline, or can't say", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              machines: [
                machine({ id: "a", claudeSignIn: "signedIn" }),
                machine({ id: "b", name: "old box", claudeSignIn: "unknown" }),
              ],
            }),
          ),
      ),
    );
    renderWithApi(<MachinesPage />, {});
    await screen.findByText("old box");
    expect(screen.queryByTestId("machines-sign-in")).toBeNull();
    expect(screen.queryByTestId("machines-sign-in-problem")).toBeNull();
  });

  it("asks the machine again when the Sign in terminal is closed", async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        paths.push(path);
        return new Response(JSON.stringify({ machines: [machine()] }));
      }),
    );
    const terminalOpen = vi.fn(async () => ({
      terminalId: "term-sign-in" as TerminalId,
      cwd: "~",
      shell: "/bin/zsh",
    }));
    const terminalClose = vi.fn(async () => {});
    renderWithApi(<MachinesPage />, { terminalOpen, terminalClose });
    fireEvent.click(await screen.findByTestId("machines-sign-in"));
    await screen.findByTestId("fake-terminal");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(paths).toContain("/machines/check-sign-in"));
    expect(terminalClose).toHaveBeenCalledWith("term-sign-in");
  });

  it("says Claude Code isn't installed there, with no Sign in, and lists what it found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              machines: [
                machine({
                  claudeSignIn: "unknown",
                  tools: [
                    { tool: "claude", found: false },
                    { tool: "git", found: true, version: "2.47.0" },
                  ],
                }),
              ],
            }),
          ),
      ),
    );
    renderWithApi(<MachinesPage />, {});
    expect((await screen.findByTestId("machines-sign-in-problem")).textContent).toBe(
      "Claude Code isn't installed on build box, or isn't on its login shell's PATH.",
    );
    expect(screen.getByTestId("machines-tools").textContent).toBe("Git 2.47.0");
    expect(screen.queryByTestId("machines-sign-in")).toBeNull();
  });
});
