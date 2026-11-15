// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isComing, parseStatus } from "@/api/on-demand";
import { EMPTY_SHELL, useEmbedShell } from "@/embed/store";

import { useOnDemandPicks } from "./on-demand-picks";
import { RunsOnChip } from "./runs-on-chip";
import { StartMachineCard } from "./start-machine-card";

// The spinner's animation isn't what is tested.
vi.mock("@/motion", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  Spinner: () => <span aria-hidden />,
}));

type Call = { url: string; method: string; body?: string };

const serve = (statuses: unknown[]) => {
  const calls: Call[] = [];
  let index = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      if (url.endsWith("/machines/on-demand/status")) {
        const status = statuses[Math.min(index, statuses.length - 1)];
        index += 1;
        return status === 404 ? new Response("", { status: 404 }) : Response.json(status);
      }
      return Response.json(
        { progress: { hostKey: "k", phase: "starting", at: 1 } },
        { status: 202 },
      );
    }),
  );
  return calls;
};

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StartMachineCard repositories={["acme/web"]} />
    </QueryClientProvider>,
  );

const showWithChip = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RunsOnChip />
      <StartMachineCard repositories={["acme/web"]} />
    </QueryClientProvider>,
  );

const KIND = {
  id: "isolation",
  label: "Kind",
  default: "vm",
  fallback: "container",
  options: [
    { id: "container", label: "Container", detail: "Starts in seconds", available: true },
    { id: "vm", label: "Virtual machine", short: "VM", available: true },
  ],
};

beforeEach(() => {
  useEmbedShell.setState({
    ...EMPTY_SHELL,
    hosted: true,
    machines: { noun: "sandbox", facts: ["Stops after 30 minutes without work"] },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useEmbedShell.setState(EMPTY_SHELL);
});

describe("the status of a person's own machine", () => {
  it("reads what the server says, and nothing else", () => {
    expect(parseStatus({ available: true })).toEqual({ available: true });
    expect(parseStatus({ available: false })).toBeUndefined();
    expect(
      parseStatus({
        available: true,
        machine: { id: "m-1", name: "sbx", online: true },
        progress: { hostKey: "k", phase: "joining", at: 5, step: 7 },
      }),
    ).toEqual({
      available: true,
      machine: { id: "m-1", name: "sbx", online: true },
      progress: { hostKey: "k", phase: "joining", at: 5 },
    });
    expect(isComing({ available: true, progress: { hostKey: "k", phase: "booting", at: 1 } })).toBe(
      true,
    );
    expect(isComing({ available: true, progress: { hostKey: "k", phase: "failed", at: 1 } })).toBe(
      false,
    );
  });
});

describe("the start card", () => {
  it("offers to start one in the deployment's words, and asks for it with the chosen repositories", async () => {
    const calls = serve([{ available: true }]);
    show();
    expect(await screen.findByText("Start a sandbox to run this")).toBeTruthy();
    expect(screen.getByText("Stops after 30 minutes without work")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Start a sandbox/ }));
    fireEvent.change(screen.getByPlaceholderText("owner/name"), { target: { value: "acme/api" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "acme/web" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")).toMatchObject({
      url: expect.stringContaining("/machines/on-demand/start"),
      body: JSON.stringify({ repositories: ["acme/api"] }),
    });
  });

  it("starts at once, choosing nothing, where a machine reaches all of the person's repositories", async () => {
    useEmbedShell.setState({ machines: { noun: "sandbox", repositories: "theirs" } });
    const calls = serve([{ available: true }]);
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Start a sandbox/ }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(screen.queryByPlaceholderText("owner/name")).toBeNull();
    expect(calls.find((call) => call.method === "POST")).toMatchObject({
      url: expect.stringContaining("/machines/on-demand/start"),
      body: JSON.stringify({ repositories: [] }),
    });
  });

  it("offers the deployment's choices on Runs on, locks what the person may not pick, and starts with theirs", async () => {
    useEmbedShell.setState({ machines: { noun: "sandbox", repositories: "theirs" } });
    useOnDemandPicks.setState({ picks: {}, keep: true });
    const calls = serve([
      {
        available: true,
        choices: {
          note: "Your team allows up to Large.",
          choices: [
            {
              id: "size",
              label: "Size",
              default: "small",
              options: [
                { id: "small", label: "Small", detail: "1 CPU · 2 GB", available: true },
                { id: "large", label: "Large", detail: "4 CPU · 8 GB", available: true },
                { id: "xlarge", label: "Extra large", available: false, note: "Above the limit" },
              ],
            },
          ],
        },
      },
    ]);
    showWithChip();
    fireEvent.click(await screen.findByTestId("runs-on"));
    expect(await screen.findByText("Your team allows up to Large.")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Extra large" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Large" }));
    expect(screen.getByTestId("on-demand-choices").textContent).toContain("Large");
    fireEvent.click(screen.getByRole("button", { name: /Start a sandbox/ }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    // This deployment keeps no picks: none is asked to be kept.
    expect(calls.find((call) => call.method === "POST")?.body).toBe(
      JSON.stringify({ repositories: [], choices: { size: "large" } }),
    );
  });

  it("says which picks are the person's own, and goes back to the default", async () => {
    useOnDemandPicks.setState({ picks: {}, keep: true });
    serve([{ available: true, choices: { keeps: true, choices: [KIND] } }]);
    showWithChip();
    expect((await screen.findByTestId("runs-on")).textContent).toContain("VM");
    fireEvent.click(screen.getByTestId("runs-on"));
    expect(await screen.findByText("Yours")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use default" }));
    expect(screen.getByText("Default")).toBeTruthy();
    expect(useOnDemandPicks.getState().picks).toEqual({ isolation: "container" });
  });

  it("starts a running machine again with a change, keeping it as the person's own", async () => {
    useOnDemandPicks.setState({ picks: {}, keep: true });
    const calls = serve([
      {
        available: true,
        machine: { id: "m", name: "s", online: true },
        choices: {
          keeps: true,
          choices: [{ ...KIND, default: "container", current: "container" }],
        },
      },
    ]);
    showWithChip();
    fireEvent.click(await screen.findByTestId("runs-on"));
    // Nothing changed: no start again offered.
    expect(screen.queryByRole("button", { name: /Start again/ })).toBeNull();
    fireEvent.click(await screen.findByRole("radio", { name: "Virtual machine" }));
    fireEvent.click(screen.getByRole("button", { name: /Start again with these/ }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")?.body).toBe(
      JSON.stringify({ repositories: [], choices: { isolation: "vm" }, keep: true, restart: true }),
    );
    expect(useOnDemandPicks.getState().picks).toEqual({});
  });

  it("shows the start step by step, and nothing once the machine is up", async () => {
    serve([{ available: true, progress: { hostKey: "k", phase: "joining", at: 1 } }]);
    show();
    expect(await screen.findByText("Starting your sandbox")).toBeTruthy();
    expect(screen.getByText("Booting")).toBeTruthy();
    expect(screen.getByText("Joining this workspace")).toBeTruthy();
  });

  it("shows nothing where the server starts no machines, or theirs is online", async () => {
    const calls = serve([404]);
    const { container } = show();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(container.textContent).toBe("");
    cleanup();
    const online = serve([{ available: true, machine: { id: "m", name: "s", online: true } }]);
    const shown = show();
    await waitFor(() => expect(online).toHaveLength(1));
    expect(shown.container.textContent).toBe("");
  });

  it("asks nothing of a server it isn't mounted in front of", async () => {
    useEmbedShell.setState(EMPTY_SHELL);
    const calls = serve([{ available: true }]);
    const { container } = show();
    await new Promise((done) => setTimeout(done, 20));
    expect(calls).toEqual([]);
    expect(container.textContent).toBe("");
  });
});
