// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JoinedMachine } from "./machines-api";
import { installCommand, machineState, MachinesPage } from "./machines-page";

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

const serve = (machines: ReadonlyArray<JoinedMachine>, extra: Record<string, unknown> = {}) => {
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
      return new Response(JSON.stringify({ machines: next, ...extra }), {
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

  it("says why a machine is offline on hover, and keeps an update to a real mismatch", async () => {
    serve(
      [
        machine({
          id: "m-a",
          name: "cachyos",
          offline: { kind: "clock", at: NOW, skewMs: 180_000 },
        }),
        machine({
          id: "m-b",
          name: "tower",
          offline: { kind: "mismatch", at: NOW, protocol: 1, release: "1.15.0" },
          release: "1.15.0",
        }),
      ],
      { release: "1.15.2", protocol: 2 },
    );
    renderPage();
    const [clock, mismatch] = await screen.findAllByTestId("machines-state");
    expect(clock!.textContent).toBe("offline");
    expect(clock!.getAttribute("aria-description")).toBe(
      "Clock is 3 min ahead.\nFix the time on cachyos.",
    );
    expect(mismatch!.textContent).toBe("Needs update (1.15.0 → 1.15.2)");
    // Only the machine that needs it offers Update.
    const rows = screen.getAllByTestId("machines-row");
    expect(within(rows[0]!).queryByTestId("machines-update")).toBeNull();
    expect(within(rows[1]!).getByTestId("machines-update")).toBeTruthy();
  });

  it("updates a machine whose host updates itself from its row, and shows how it goes", async () => {
    const online = machine({
      id: "m-a",
      name: "cachyos",
      onlineSince: Date.now() - 60 * 60_000,
      release: "1.16.0",
      selfUpdate: true,
    });
    const calls = serve(
      [online, machine({ id: "m-b", name: "tower", release: "1.17.0", onlineSince: Date.now() })],
      {
        release: "1.17.0",
        protocol: 2,
      },
    );
    renderPage();
    const button = await screen.findByTestId("machines-update");
    expect(button.getAttribute("aria-label")).toBe("Update cachyos to 1.17.0");
    // Only one machine is behind: no Update all.
    expect(screen.queryByTestId("machines-update-all")).toBeNull();
    fireEvent.click(button);
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/machines/update",
        body: JSON.stringify({ id: "m-a" }),
      }),
    );
    // Straight over its connection: no dialog, no command to run there.
    expect(screen.queryByTestId("machines-update-dialog")).toBeNull();
  });

  it("shows an update's progress, a busy machine waiting, and a rollback on the row", async () => {
    const base = { onlineSince: Date.now() - 60 * 60_000, release: "1.16.0", selfUpdate: true };
    serve(
      [
        machine({
          ...base,
          id: "m-a",
          name: "cachyos",
          update: { phase: "downloading", release: "1.17.0", received: 45, total: 100 },
        }),
        machine({
          ...base,
          id: "m-b",
          name: "tower",
          update: {
            phase: "waiting",
            release: "1.17.0",
            busy: { turns: 1, terminals: 2, clones: 0 },
          },
        }),
        machine({
          ...base,
          id: "m-c",
          name: "pi",
          update: {
            phase: "rolledBack",
            release: "1.17.0",
            message:
              "Gram 1.17.0 didn't dial in within 2 minutes, so the machine went back to 1.16.0.",
            at: Date.now(),
          },
        }),
      ],
      { release: "1.17.0", protocol: 2 },
    );
    renderPage();
    const lines = await screen.findAllByTestId("machines-update-state");
    expect(lines.map((line) => line.textContent)).toEqual([
      "Updating to 1.17.0: downloading, 45%",
      "Updates to 1.17.0 once tower is idle: 1 running turn and 2 busy terminals.",
      "Update to 1.17.0 didn't start, so pi went back to 1.16.0. Gram 1.17.0 didn't dial in within 2 minutes, so the machine went back to 1.16.0.",
    ]);
    const rows = screen.getAllByTestId("machines-row");
    // Under way: its Update waits. Waiting or rolled back: it can be asked again.
    expect(within(rows[0]!).getByTestId("machines-update")).toHaveProperty("disabled", true);
    expect(within(rows[1]!).getByTestId("machines-update")).toHaveProperty("disabled", false);
    expect(within(rows[2]!).getByTestId("machines-update")).toHaveProperty("disabled", false);
  });

  it("offers Update all when more than one machine is behind", async () => {
    const base = { onlineSince: Date.now(), release: "1.16.0", selfUpdate: true };
    const calls = serve(
      [
        machine({ ...base, id: "m-a", name: "cachyos" }),
        machine({ ...base, id: "m-b", name: "tower" }),
      ],
      { release: "1.17.0", protocol: 2 },
    );
    renderPage();
    fireEvent.click(await screen.findByTestId("machines-update-all"));
    await waitFor(() => expect(calls.map((call) => call.path)).toContain("/machines/update-all"));
  });

  it("shows the one command to update a machine that joined by the command", async () => {
    const calls = serve([machine({ offline: { kind: "mismatch", at: NOW, protocol: 1 } })], {
      release: "1.15.2",
      protocol: 2,
      updateCommand: "curl -fsSL https://studio.example-tailnet.ts.net/host/install | sh",
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("machines-update"));
    expect(screen.getByTestId("machines-update-command").textContent).toBe(
      "curl -fsSL https://studio.example-tailnet.ts.net/host/install | sh",
    );
    expect(calls.some((call) => call.path === "/machines/update")).toBe(false);
  });

  it("updates a machine Gram added over SSH by running that install again", async () => {
    const calls = serve(
      [
        machine({
          offline: { kind: "mismatch", at: NOW, protocol: 1 },
          sshTarget: "me@cachyos",
        }),
      ],
      {
        release: "1.15.2",
        protocol: 2,
        updateCommand: "curl -fsSL https://x.ts.net/host/install | sh",
      },
    );
    renderPage();
    fireEvent.click(await screen.findByTestId("machines-update"));
    expect(screen.getByTestId("machines-update-dialog").textContent).toContain("me@cachyos");
    fireEvent.click(screen.getByRole("button", { name: "Update over SSH" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/machines/update",
        body: JSON.stringify({ id: "m-0123456789abcdef01234567" }),
      }),
    );
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      "build box moved to 1.15.2. It dials in again in a moment.",
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

describe("installCommand", () => {
  it("joins with one command that carries the link, without its quotes", () => {
    expect(installCommand("https://studio.example-tailnet.ts.net/host/join#code=ab'cd")).toBe(
      "curl -fsSL https://studio.example-tailnet.ts.net/host/install | sh -s -- 'https://studio.example-tailnet.ts.net/host/join#code=abcd'",
    );
  });
});

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("adding a machine while access over Tailscale is off", () => {
  it("turns it on from the dialog, then shows the join command", async () => {
    let on = false;
    const calls: Array<string> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        calls.push(path);
        const remote = {
          mode: on ? "on" : "off",
          tailscale: { state: "ready", dnsName: "studio.example-tailnet.ts.net" },
          port: 8443,
          devices: [],
          ...(on ? { origin: "https://studio.example-tailnet.ts.net" } : {}),
        };
        if (path === "/remote/status") return reply(remote);
        if (path === "/remote/enable") {
          on = true;
          return reply({ ...remote, mode: "on", origin: "https://studio.example-tailnet.ts.net" });
        }
        if (path === "/machines/join-link")
          return on
            ? reply({
                url: `https://studio.example-tailnet.ts.net/host/join#code=${"a".repeat(64)}`,
                expiresAt: Date.now() + 15 * 60_000,
              })
            : reply({ message: "off" }, 409);
        return reply({ machines: [] });
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add a machine" }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn on access over Tailscale" }));
    const command = await screen.findByTestId("machines-command");
    expect(command.textContent).toContain("/host/install | sh -s --");
    expect(command.textContent).not.toContain("a".repeat(64));
    expect(calls).toContain("/remote/enable");
  });

  it("lists what Tailscale still needs when it isn't ready", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/remote/status"
          ? new Response(
              JSON.stringify({
                mode: "off",
                tailscale: { state: "missing" },
                port: 8443,
                devices: [],
              }),
            )
          : path === "/machines/join-link"
            ? new Response("off", { status: 409 })
            : new Response(JSON.stringify({ machines: [] })),
      ),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add a machine" }));
    expect(await screen.findByTestId("phone-access-tailscale")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on access over Tailscale" })).toBeNull();
  });
});

describe("adding a machine over SSH", () => {
  const on = {
    mode: "on",
    tailscale: { state: "ready", dnsName: "studio.example-tailnet.ts.net" },
    port: 8443,
    devices: [],
    origin: "https://studio.example-tailnet.ts.net",
  };
  const serveSsh = (
    join: () => Response | Promise<Response>,
    list: () => ReadonlyArray<JoinedMachine> = () => [],
  ) => {
    const calls: Array<{ path: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        calls.push({ path, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
        if (path === "/remote/status") return reply(on);
        if (path === "/machines/join-link")
          return reply({
            url: `https://studio.example-tailnet.ts.net/host/join#code=${"a".repeat(64)}`,
            expiresAt: Date.now() + 15 * 60_000,
          });
        if (path === "/machines/ssh-hosts") return reply({ hosts: ["build-box"] });
        if (path === "/machines/ssh-join") return join();
        return reply({ machines: list() });
      }),
    );
    return calls;
  };

  it("installs on the host and keeps its answer while the new machine appears", async () => {
    let joining = false;
    let finish: ((response: Response) => void) | undefined;
    const calls = serveSsh(
      () => {
        joining = true;
        return new Promise<Response>((resolve) => (finish = resolve));
      },
      // The machine joins before the install ends, and the dialog's poll sees it.
      () => (joining ? [machine({ confirmed: false })] : []),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add a machine" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "SSH host" }), {
      target: { value: " build-box " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add over SSH" }));
    expect(await screen.findByText(/Installing on build-box over SSH/)).toBeTruthy();
    const listed = () => calls.filter((call) => call.path === "/machines/list").length;
    const before = listed();
    await waitFor(() => expect(listed()).toBeGreaterThan(before), { timeout: 4_000 });
    expect(screen.queryByTestId("machines-joined-new")).toBeNull();
    finish?.(reply({ machines: [machine()], joined: machine().id, output: "Fingerprint: X" }));
    expect(await screen.findByText("build-box joined, and its fingerprint matched.")).toBeTruthy();
    expect(calls).toContainEqual({
      path: "/machines/ssh-join",
      body: JSON.stringify({ target: "build-box" }),
    });
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("makes no join link while an install over SSH is running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/remote/status"
          ? reply(on)
          : path === "/machines/join-link"
            ? reply({ reason: "ssh-running", message: "busy" }, 409)
            : reply({ machines: [] }),
      ),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add a machine" }));
    expect(await screen.findByText(/Gram is adding a machine over SSH/)).toBeTruthy();
    expect(screen.queryByTestId("phone-access-tailscale")).toBeNull();
  });

  it("shows why it failed, with what the session printed", async () => {
    serveSsh(() =>
      reply(
        { message: "Couldn't connect to build-box over SSH.", output: "Permission denied" },
        502,
      ),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Add a machine" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "SSH host" }), {
      target: { value: "build-box" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add over SSH" }));
    const failure = await screen.findByText("Couldn't connect to build-box over SSH.");
    const alert = failure.closest("[role=alert]");
    expect(alert).not.toBeNull();
    expect(within(alert as HTMLElement).getByText("Permission denied")).toBeTruthy();
  });
});
