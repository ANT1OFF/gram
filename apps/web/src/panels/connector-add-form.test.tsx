// @vitest-environment happy-dom
import { InvalidState, type ConnectorList, type ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useThreadsStore } from "@/stores/threads";

import { ConnectorsPanel } from "./connectors-panel";
import { renderWithApi } from "./test-utils";

const T = "t-flaky" as ThreadId;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useThreadsStore.setState({ byId: {} });
});

const LIVE: ConnectorList = {
  live: true,
  connectors: [
    { name: "github", status: "connected", scope: "user" },
    { name: "linear", status: "needs-auth", scope: "claudeai" },
  ],
};

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });

const openForm = async () => {
  await screen.findAllByTestId("connector");
  fireEvent.click(screen.getByRole("button", { name: "Add server…" }));
  return screen.getByRole("form", { name: "Add MCP server" });
};

describe("AddConnectorForm", () => {
  it("adds an http server with headers in the chosen scope, then refreshes", async () => {
    const listConnectors = vi.fn(async () => LIVE);
    const addConnector = vi.fn(async () => ({ name: "sentry", session: "reopening" as const }));
    renderWithApi(<ConnectorsPanel threadId={T} />, { listConnectors, addConnector });
    const form = await openForm();

    type("Server name", "sentry");
    type("URL", "https://mcp.sentry.dev/mcp");
    type("Headers", "Authorization: Bearer sekrit-token");
    fireEvent.click(within(form).getByRole("radio", { name: "Project" }));
    expect(screen.getByTestId("scope-hint").textContent).toContain(".mcp.json");
    fireEvent.click(within(form).getByRole("button", { name: "Add server" }));

    await waitFor(() =>
      expect(addConnector).toHaveBeenCalledWith({
        threadId: T,
        scope: "project",
        name: "sentry",
        config: {
          type: "http",
          url: "https://mcp.sentry.dev/mcp",
          headers: { Authorization: "Bearer sekrit-token" },
        },
        targets: ["claude"],
      }),
    );
    expect((await screen.findByRole("status")).textContent).toBe(
      "Added sentry to Claude Code. The session reopens once it's idle to connect it.",
    );
    expect(screen.queryByRole("form", { name: "Add MCP server" })).toBeNull();
    expect(document.body.textContent).not.toContain("sekrit-token");
    await waitFor(() => expect(listConnectors).toHaveBeenCalledTimes(2));
  });

  it("adds to the thread's own agent by default, or to the agents ticked, each where it can", async () => {
    useThreadsStore.setState({
      byId: {
        [T]: { status: "idle", thread: { id: T, model: { agent: "codex", model: "default" } } },
      } as never,
    });
    const addConnector = vi.fn(async () => ({ name: "fs", session: "noSession" as const }));
    renderWithApi(<ConnectorsPanel threadId={T} />, {
      listConnectors: vi.fn(async () => LIVE),
      addConnector,
    });
    const form = await openForm();
    fireEvent.click(within(form).getByRole("radio", { name: "Command" }));
    type("Server name", "fs");
    type("Command", "npx");
    type("Arguments", "-y\n@modelcontextprotocol/server-filesystem");
    type("Environment", "ROOT=/tmp");
    expect(within(form).getByRole("checkbox", { name: "Codex" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    // "Local" is Claude Code's; Codex has one config, and the form says so.
    expect(screen.getByTestId("scope-hint").textContent).toBe(
      "Codex: its config.toml, for you in every project (Codex has no narrower scope).",
    );
    fireEvent.click(within(form).getByRole("button", { name: "Add server" }));
    await waitFor(() =>
      expect(addConnector).toHaveBeenLastCalledWith({
        threadId: T,
        scope: "local",
        name: "fs",
        config: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          env: { ROOT: "/tmp" },
        },
        targets: ["codex"],
      }),
    );
    expect((await screen.findByRole("status")).textContent).toBe(
      "Added fs. It connects when the thread starts.",
    );

    const again = await openForm();
    fireEvent.click(within(again).getByRole("radio", { name: "Paste JSON" }));
    type("Server JSON", '{"mcpServers":{"docs":{"type":"sse","url":"https://docs.example/sse"}}}');
    fireEvent.click(within(again).getByRole("radio", { name: "Project" }));
    fireEvent.click(within(again).getByRole("checkbox", { name: "Claude Code" }));
    expect(within(again).getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByTestId("scope-hint").textContent).toContain(
      "Each agent keeps its own sign-in, so you sign in once in each.",
    );
    fireEvent.click(within(again).getByRole("button", { name: "Add server" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Codex connects over streamable HTTP only. Pick HTTP, or leave Codex out.",
    );
    expect(addConnector).toHaveBeenCalledTimes(1);

    fireEvent.click(within(again).getByRole("checkbox", { name: "Codex" }));
    expect(screen.getByTestId("scope-hint").textContent).toContain(
      "Claude Code: everyone in the repo, via .mcp.json you can commit.",
    );
    fireEvent.click(within(again).getByRole("button", { name: "Add server" }));
    await waitFor(() =>
      expect(addConnector).toHaveBeenLastCalledWith({
        threadId: T,
        scope: "project",
        name: "docs",
        config: { type: "sse", url: "https://docs.example/sse" },
        targets: ["claude"],
      }),
    );
    expect((await screen.findByRole("status")).textContent).toBe(
      "Added fs to Claude Code. This thread's agent wasn't one of them, so it won't appear here.",
    );
  });

  it("explains a bad field before calling the server, and shows a server refusal", async () => {
    const addConnector = vi.fn(async () => {
      throw new InvalidState({ message: "Couldn't add sentry: MCP server sentry already exists" });
    });
    renderWithApi(<ConnectorsPanel threadId={T} />, {
      listConnectors: vi.fn(async () => LIVE),
      addConnector,
    });
    const form = await openForm();
    type("Server name", "my server");
    fireEvent.click(within(form).getByRole("button", { name: "Add server" }));
    expect(within(form).getByRole("alert").textContent).toBe(
      "Name the server with letters, digits, dashes or underscores.",
    );
    expect(addConnector).not.toHaveBeenCalled();

    type("Server name", "sentry");
    type("URL", "https://mcp.sentry.dev/mcp");
    fireEvent.click(within(form).getByRole("button", { name: "Add server" }));
    expect((await within(form).findByRole("alert")).textContent).toBe(
      "Couldn't add sentry: MCP server sentry already exists",
    );
  });

  it("removes a server the CLI owns, but not a claude.ai connector", async () => {
    const removeConnector = vi.fn(async () => ({ name: "github", session: "reopening" as const }));
    renderWithApi(<ConnectorsPanel threadId={T} />, {
      listConnectors: vi.fn(async () => LIVE),
      removeConnector,
    });
    const rows = await screen.findAllByTestId("connector");
    const github = rows.find((r) => r.getAttribute("aria-label") === "github")!;
    const linear = rows.find((r) => r.getAttribute("aria-label") === "linear")!;
    expect(within(linear).queryByRole("button", { name: "Remove" })).toBeNull();

    fireEvent.click(within(github).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(removeConnector).toHaveBeenCalledWith({ threadId: T, name: "github", scope: "user" }),
    );
    expect((await screen.findByRole("status")).textContent).toBe(
      "Removed github. The session reopens once it's idle.",
    );
  });
});
