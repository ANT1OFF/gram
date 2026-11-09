// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JoinedMachine, TokenRun } from "./machines-api";
import { TOKEN_CONSENT } from "./machines-api";
import { TokenDialog, tokenTargets } from "./machine-token-dialog";

const NOW = Date.parse("2026-11-09T10:00:00Z");
const machine = (overrides: Partial<JoinedMachine>): JoinedMachine => ({
  id: "m-0123456789abcdef01234567",
  name: "build box",
  platform: "linux",
  fingerprint: "0123-4567-89AB-CDEF-0123",
  joinedAt: NOW,
  confirmed: true,
  onlineSince: NOW,
  ...overrides,
});
const BOX = machine({});
const SPARE = machine({ id: "m-89abcdef0123456789abcdef", name: "spare" });
const { onlineSince: _online, ...offline } = machine({
  id: "m-fedcba9876543210fedcba98",
  name: "laptop",
});
const OFFLINE: JoinedMachine = offline;

/** Answers the token routes; `runs` are the states the status poll reads in turn. */
const serve = (runs: ReadonlyArray<TokenRun>) => {
  const calls: Array<{ path: string; body: unknown }> = [];
  let polled = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const body =
        path === "/machines/claude-token/start"
          ? { captureId: "run-1" }
          : path === "/machines/claude-token/status"
            ? runs[Math.min(polled++, runs.length - 1)]
            : {};
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the setup-token consent dialog", () => {
  it("offers only machines that are confirmed and online", () => {
    expect(tokenTargets([BOX, OFFLINE, machine({ id: "x", confirmed: false })])).toEqual([BOX]);
  });

  it("starts nothing until the person agrees, and sends only to the machines ticked", async () => {
    const calls = serve([
      { state: "waiting", asksForCode: false },
      { state: "done", results: [{ id: BOX.id, ok: true }] },
    ]);
    render(<TokenDialog machine={BOX} machines={[BOX, SPARE, OFFLINE]} onClose={() => {}} />);
    expect(screen.getByText(/Revoke it at claude\.ai/)).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox") as Array<HTMLInputElement>;
    // Only the machine it was opened from is ticked; an offline one isn't offered.
    expect(boxes.map((box) => box.checked)).toEqual([true, false]);
    expect(screen.queryByText("laptop")).toBeNull();
    expect(calls).toEqual([]);

    fireEvent.click(screen.getByTestId("machines-token-start"));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toEqual({
      path: "/machines/claude-token/start",
      body: { ids: [BOX.id], consent: TOKEN_CONSENT },
    });
    await waitFor(() => expect(screen.getByTestId("machines-token-results")).toBeTruthy(), {
      timeout: 4000,
    });
    expect(screen.getByText(/Signed in with the token/)).toBeTruthy();
  });

  it("can't start with no machine ticked, and cancels a waiting run when closed", async () => {
    const calls = serve([{ state: "waiting", asksForCode: true }]);
    const closed = vi.fn();
    render(<TokenDialog machine={BOX} machines={[BOX]} onClose={closed} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByTestId("machines-token-start") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("machines-token-start"));
    await waitFor(() => expect(screen.getByLabelText("Code from the sign-in page")).toBeTruthy(), {
      timeout: 4000,
    });
    fireEvent.change(screen.getByLabelText("Code from the sign-in page"), {
      target: { value: "synthetic-code" },
    });
    fireEvent.click(screen.getByText("Send code"));
    await waitFor(() =>
      expect(calls.some((call) => call.path === "/machines/claude-token/code")).toBe(true),
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(closed).toHaveBeenCalled();
    await waitFor(() =>
      expect(calls.some((call) => call.path === "/machines/claude-token/cancel")).toBe(true),
    );
  });
});
