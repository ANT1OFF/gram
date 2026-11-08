// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JoinedMachine } from "./machines-api";
import { machineState, MachinesPage } from "./machines-page";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-15T10:00:00Z");
const machine = (overrides: Partial<JoinedMachine> = {}): JoinedMachine => ({
  id: "m-0123456789abcdef01234567",
  name: "build box",
  platform: "linux",
  fingerprint: "0123-4567-89AB-CDEF-0123",
  joinedAt: NOW - 3 * DAY,
  confirmed: true,
  ...overrides,
});

const serve = (machines: ReadonlyArray<JoinedMachine>) => {
  const calls: Array<{ path: string; body?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      const next =
        path === "/machines/confirm"
          ? machines.map((m) => ({ ...m, confirmed: true }))
          : path === "/machines/remove"
            ? []
            : machines;
      return new Response(JSON.stringify({ machines: next }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
};

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MachinesPage />
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("machines page", () => {
  it("says whether a joined machine waits for you, is online, or is offline", () => {
    expect(machineState(machine({ confirmed: false }), NOW)).toBe(
      "Joined 12 Jun · waiting for you to confirm it",
    );
    expect(machineState(machine(), NOW)).toBe("Joined 12 Jun · offline");
    expect(machineState(machine({ onlineSince: NOW - 10_000 }), NOW)).toBe(
      "Joined 12 Jun · online",
    );
    expect(machineState(machine({ onlineSince: NOW - 2 * 3_600_000 }), NOW)).toBe(
      "Joined 12 Jun · online for 2 hours",
    );
  });

  it("confirms a machine only after showing its fingerprint", async () => {
    const calls = serve([machine({ confirmed: false })]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    expect(screen.getByTestId("machines-fingerprint").textContent).toBe("0123-4567-89AB-CDEF-0123");
    fireEvent.click(screen.getByRole("button", { name: "They match" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/machines/confirm",
        body: JSON.stringify({ id: "m-0123456789abcdef01234567" }),
      }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull());
  });

  it("removes a machine after asking", async () => {
    const calls = serve([machine({ onlineSince: NOW })]);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    fireEvent.click(
      within(screen.getByTestId("machines-remove")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(calls.map((call) => call.path)).toContain("/machines/remove"));
    expect(await screen.findByText(/No other machines yet/)).toBeTruthy();
  });
});
