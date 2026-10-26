// @vitest-environment happy-dom
import { InvalidState, type ConnectorList, type ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useThreadsStore } from "@/stores/threads";

import { groupConnectors } from "./connectors-model";
import { claudeHostedElsewhere, ConnectorsPanel } from "./connectors-panel";
import { START_AFTER_MS, startHold } from "./connectors-start";
import { Remount, renderWithApi } from "./test-utils";

const T = "t-flaky" as ThreadId;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useThreadsStore.setState({ byId: {} });
});

/** Puts the thread in the store as one of `agent`'s, which is what names the agent in the panel. */
const threadOn = (agent: "claude" | "codex" | "codex") =>
  useThreadsStore.setState({
    byId: {
      [T]: { status: "idle", thread: { id: T, model: { agent, model: "default" } } },
    } as never,
  });

const CLAUDE_HINT = "Claude Code signs in from its own menu: run claude, open /mcp and sign in.";

const LIVE: ConnectorList = {
  live: true,
  connectors: [
    { name: "github", status: "connected", scope: "user" },
    { name: "linear", status: "needs-auth", scope: "claudeai", signInUnavailable: CLAUDE_HINT },
    { name: "sentry", status: "failed", scope: "project", error: "connect ECONNREFUSED" },
    { name: "notion", status: "disabled" },
  ],
};

const row = (name: string) =>
  screen.getAllByTestId("connector").find((r) => r.getAttribute("aria-label") === name)!;

describe("ConnectorsPanel", () => {
  it("lists each connector's state, scope and error, and the agent's own way in when it has no sign-in", async () => {
    renderWithApi(<ConnectorsPanel threadId={T} />, { listConnectors: vi.fn(async () => LIVE) });

    expect(await screen.findAllByTestId("connector")).toHaveLength(4);
    expect(within(row("github")).getByText("Connected")).toBeTruthy();
    expect(within(row("github")).getByText("user")).toBeTruthy();
    expect(within(row("linear")).getByText("Not signed in")).toBeTruthy();
    // Said once for the group, not on each of what may be dozens of rows.
    expect(screen.getAllByText(CLAUDE_HINT)).toHaveLength(1);
    expect(within(row("linear")).getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(within(row("linear")).getByText("claude.ai")).toBeTruthy();
    expect(within(row("linear")).queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(within(row("sentry")).getByText("connect ECONNREFUSED")).toBeTruthy();
    // A Claude thread already has the user's claude.ai connectors, so there's nothing to explain.
    expect(screen.queryByText(claudeHostedElsewhere("Codex"))).toBeNull();
    expect(within(row("notion")).getByRole("button", { name: "Enable" })).toBeTruthy();
    expect(
      (within(row("notion")).getByRole("button", { name: "Reconnect" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows a connector's tools, why it can't sign in, and why a gateway thread has none", async () => {
    threadOn("claude");
    const AGAIN = "Sign in to Claude again: Run `claude /login`.";
    const list: ConnectorList = {
      live: true,
      connectors: [
        {
          name: "claude.ai Atlassian",
          status: "connected",
          scope: "claudeai",
          url: "https://mcp.atlassian.com/v1/mcp",
          tools: [
            { name: "search", readOnly: true },
            { name: "delete_page", destructive: true },
          ],
          claudeAi: { id: "a", orgManaged: true },
        },
        {
          name: "claude.ai Teams",
          status: "failed",
          scope: "claudeai",
          claudeAi: { claudeSignInRejected: true },
          signInUnavailable: AGAIN,
        },
        {
          name: "claude.ai Gmail",
          status: "needs-auth",
          scope: "claudeai",
          claudeAi: { blocked: "Not allowed for your seat" },
        },
      ],
      claudeAiUnavailable: "claude.ai connectors need your Claude sign-in.",
    };
    const listConfiguredConnectors = vi.fn(async () => ({
      agents: [
        {
          target: "codex" as const,
          signIn: "reported" as const,
          servers: [
            {
              name: "atlassian",
              transport: "http" as const,
              url: "https://other.example/mcp",
              scope: "user",
              carriesValues: false,
            },
          ],
        },
      ],
    }));
    renderWithApi(<ConnectorsPanel threadId={T} />, {
      listConnectors: vi.fn(async () => list),
      listConfiguredConnectors,
    });

    await screen.findAllByTestId("connector");
    const atlassian = within(row("claude.ai Atlassian"));
    fireEvent.click(atlassian.getByRole("button", { name: "2 tools of claude.ai Atlassian" }));
    const tools = atlassian.getByRole("list", { name: "Tools of claude.ai Atlassian" });
    expect(within(tools).getAllByRole("listitem")).toHaveLength(2);
    expect(within(tools).getByRole("img", { name: /^Read-only/ })).toBeTruthy();
    expect(within(tools).getByRole("img", { name: /^Destructive/ })).toBeTruthy();
    expect(
      atlassian.getByRole("img", { name: "Your organisation manages its sign-in" }),
    ).toBeTruthy();

    // Away from EXAMPLE's platform, the form warns the other agent's sign-in may be refused.
    fireEvent.click(
      atlassian.getByRole("button", { name: "Use claude.ai Atlassian with another agent" }),
    );
    fireEvent.click(atlassian.getByRole("button", { name: "Use with Codex" }));
    const form = await screen.findByRole("form", { name: "Add MCP server" });
    // Read afresh, which connects nothing, and Codex's own `atlassian` keeps its name.
    expect(listConfiguredConnectors).toHaveBeenCalledWith({ fresh: true });
    expect((within(form).getByRole("textbox", { name: "URL" }) as HTMLInputElement).value).toBe(
      "https://mcp.atlassian.com/v1/mcp",
    );
    expect(
      (within(form).getByRole("textbox", { name: "Server name" }) as HTMLInputElement).value,
    ).toBe("atlassian-2");
    expect(screen.getByText(/accept only claude.ai's sign-in/)).toBeTruthy();

    // Claude's own sign-in was turned down: the fix is to sign in to Claude, not the connector.
    expect(row("claude.ai Teams").textContent).toContain(
      "Sign in to Claude again: Run claude /login.",
    );
    expect(within(row("claude.ai Teams")).getByText("claude /login").tagName).toBe("CODE");
    expect(within(row("claude.ai Teams")).queryByRole("button", { name: "Sign in" })).toBeNull();
    const gmail = within(row("claude.ai Gmail"));
    expect(
      gmail.getByRole("img", { name: "Blocked by policy: Not allowed for your seat" }),
    ).toBeTruthy();
    expect(gmail.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.getByTestId("claude-ai-unavailable").textContent).toBe(
      "claude.ai connectors need your Claude sign-in.",
    );
  });

  it("says how each server stands, and keeps checking until it knows", async () => {
    const loading: ConnectorList = {
      live: true,
      connectors: [
        { name: "gram", status: "connected", builtIn: true },
        { name: "kong", status: "connected", scope: "user" },
        { name: "sonar", status: "pending", unconfirmed: true },
        {
          name: "sentinel",
          status: "disabled",
          notGiven: true,
          toggleUnavailable: "An orchestrator gets only the servers listed for orchestrators.",
        },
      ],
    };
    const loaded: ConnectorList = {
      live: true,
      connectors: loading.connectors.map((c) =>
        c.name === "sonar" ? { name: "sonar", status: "connected" } : c,
      ),
    };
    const listConnectors = vi.fn(async () =>
      listConnectors.mock.calls.length > 1 ? loaded : loading,
    );
    renderWithApi(<ConnectorsPanel threadId={T} />, { listConnectors });

    await screen.findAllByTestId("connector");
    // Still loading its servers is "Checking…", never missing, and never the last word.
    expect(within(row("sonar")).getByText("Checking…")).toBeTruthy();
    expect(within(row("sonar")).queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(within(row("kong")).getByText("Connected")).toBeTruthy();
    expect(within(row("sentinel")).getByText("Not given to this thread")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Not signed in" })).toBeNull();
    await waitFor(() => expect(within(row("sonar")).getByText("Connected")).toBeTruthy(), {
      timeout: 8_000,
    });
    // The panel looks again every 3 s while a server is checked; the default 5 s is too tight.
  }, 10_000);

  it("reconnects and toggles through the api, then refetches", async () => {
    const listConnectors = vi.fn(async () => LIVE);
    const reconnectConnector = vi.fn(async () => {});
    const setConnectorEnabled = vi.fn(async () => ({ session: "applied" as const }));
    renderWithApi(<ConnectorsPanel threadId={T} />, {
      listConnectors,
      reconnectConnector,
      setConnectorEnabled,
    });
    await screen.findAllByTestId("connector");

    fireEvent.click(within(row("sentry")).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(listConnectors).toHaveBeenCalledTimes(2));
    expect(reconnectConnector).toHaveBeenCalledWith(T, "sentry");

    fireEvent.click(within(row("github")).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(setConnectorEnabled).toHaveBeenCalledWith(T, "github", false));
    fireEvent.click(within(row("notion")).getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(setConnectorEnabled).toHaveBeenCalledWith(T, "notion", true));

    fireEvent.click(screen.getByRole("button", { name: "Refresh connectors" }));
    await waitFor(() => expect(listConnectors.mock.calls.length).toBeGreaterThanOrEqual(5));
  });

  it("says when a toggle reaches other threads, on the row and after toggling", async () => {
    const note = "Applies to every Codex thread in this folder.";
    const setConnectorEnabled = vi.fn(async () => ({ session: "applied" as const }));
    renderWithApi(<ConnectorsPanel threadId={T} />, {
      listConnectors: vi.fn(async (): Promise<ConnectorList> => ({
        live: true,
        connectors: [{ name: "docs", status: "connected", toggleNote: note }],
      })),
      setConnectorEnabled,
    });

    const docs = within(await waitFor(() => row("docs")));
    expect(docs.getByText(note)).toBeTruthy();
    const disable = docs.getByRole("button", { name: "Disable" });
    expect(disable.getAttribute("aria-describedby")).toBe(docs.getByText(note).id);

    fireEvent.click(disable);
    expect((await screen.findByRole("status")).textContent).toBe(`Disabled docs. ${note}`);
    expect(setConnectorEnabled).toHaveBeenCalledWith(T, "docs", false);
  });

  it("marks the built-in server and disables controls the agent lacks, with the reason", async () => {
    const setConnectorEnabled = vi.fn(async () => ({ session: "reopening" as const }));
    renderWithApi(<ConnectorsPanel threadId={T} />, {
      listConnectors: vi.fn(async (): Promise<ConnectorList> => ({
        live: true,
        connectors: [
          {
            name: "gram",
            status: "connected",
            builtIn: true,
            toggleUnavailable: "Gram's app tools stay on for every thread.",
          },
          {
            name: "docs",
            status: "connected",
            reconnectUnavailable: "Codex reconnects its servers when the thread restarts.",
          },
        ],
      })),
      setConnectorEnabled,
    });

    const builtIn = within(await waitFor(() => row("gram")));
    expect(builtIn.getByText("built-in")).toBeTruthy();
    const disable = builtIn.getByRole("button", { name: "Disable" }) as HTMLButtonElement;
    expect(disable.disabled).toBe(true);
    expect(builtIn.getByText("Gram's app tools stay on for every thread.")).toBeTruthy();
    expect(disable.getAttribute("aria-describedby")).toBeTruthy();

    const docs = within(row("docs"));
    expect((docs.getByRole("button", { name: "Reconnect" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(docs.getByText("Codex reconnects its servers when the thread restarts.")).toBeTruthy();

    fireEvent.click(docs.getByRole("button", { name: "Disable" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "Disabled docs. The session reopens once it's idle to apply it.",
    );
    expect(setConnectorEnabled).toHaveBeenCalledWith(T, "docs", false);
  });

  it("starts a cold thread's session once, showing its config meanwhile, then lists it live", async () => {
    const cold = (extra: object = {}) =>
      useThreadsStore.setState({
        byId: {
          [T]: {
            status: "cold",
            thread: {
              id: T,
              model: { agent: "claude", model: "default" },
              checkout: { kind: "main", path: "/work/repo" },
              parked: false,
              ...extra,
            },
          },
        } as never,
      });
    const statusOf = (status: string) =>
      useThreadsStore.setState((s) => ({ byId: { [T]: { ...s.byId[T]!, status } } }) as never);
    cold();
    const listConnectors = vi.fn(async (): Promise<ConnectorList> =>
      useThreadsStore.getState().byId[T]?.status === "idle"
        ? LIVE
        : { live: false, reason: "noSession" },
    );
    let opened: (() => void) | undefined;
    const startSession = vi.fn(async () => {
      statusOf("starting");
      opened = () => statusOf("idle");
      return "starting" as const;
    });
    const listConfiguredConnectors = vi.fn(async () => ({
      agents: [
        {
          target: "claude" as const,
          signIn: "liveOnly" as const,
          claudeAiFrom: "lastSeen" as const,
          servers: [
            {
              name: "linear",
              transport: "other" as const,
              scope: "claudeai",
              carriesValues: false,
              signedIn: true,
              seenAt: new Date(Date.now() - 5.5 * 60_000).toISOString(),
            },
            { name: "github", transport: "http" as const, scope: "user", carriesValues: false },
          ],
        },
      ],
    }));
    const api = { listConnectors, startSession, listConfiguredConnectors };
    renderWithApi(
      <Remount>
        <ConnectorsPanel threadId={T} />
      </Remount>,
      api,
    );

    expect(await screen.findByText("Starting the session…")).toBeTruthy();
    const snapshot = await screen.findByTestId("connectors-snapshot");
    // Only the thread's own folder is read, and nothing is asked to connect.
    expect(listConfiguredConnectors).toHaveBeenCalledWith({ cwd: "/work/repo" });
    const linear = within(snapshot).getByRole("listitem", { name: "linear" });
    expect(linear.textContent).toContain("Signed in · as of 5m ago");
    expect(within(snapshot).getByRole("listitem", { name: "github" }).textContent).toContain(
      "Configured",
    );
    await waitFor(() => expect(startSession).toHaveBeenCalledWith(T));
    fireEvent.click(screen.getByRole("button", { name: "Refresh connectors" }));
    await waitFor(() =>
      expect(listConfiguredConnectors).toHaveBeenLastCalledWith({ cwd: "/work/repo", fresh: true }),
    );
    opened!();
    expect(await screen.findAllByTestId("connector")).toHaveLength(4);
    expect(screen.queryByTestId("connectors-snapshot")).toBeNull();

    // Evicted while idle, then the tab opened again: the button, not another start.
    statusOf("cold");
    fireEvent.click(screen.getByRole("button", { name: "Remount" }));
    expect(await screen.findByText("The session stopped after it sat idle.")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, START_AFTER_MS + 100));
    expect(startSession).toHaveBeenCalledTimes(1);

    startSession.mockImplementationOnce(async () => {
      throw new InvalidState({ message: "This thread's folder no longer exists: /work/repo" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    expect(
      await screen.findByText("This thread's folder no longer exists: /work/repo"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByTestId("connectors-snapshot")).toBeTruthy();

    // The call answers before the agent is up: one that can't start says why, from the thread.
    startSession.mockImplementationOnce(async () => {
      useThreadsStore.setState(
        (s) =>
          ({
            byId: {
              [T]: {
                ...s.byId[T]!,
                status: "error",
                thread: { ...s.byId[T]!.thread, lastError: { text: "claude: command not found" } },
              },
            },
          }) as never,
      );
      return "starting" as const;
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("claude: command not found")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    cleanup();

    // An archived thread never starts from here.
    cold({ parked: true });
    renderWithApi(<ConnectorsPanel threadId={T} />, { ...api, startSession: vi.fn() });
    expect(
      await screen.findByText("Unarchive the thread to see its connectors live."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start session" })).toBeNull();
  });

  it("holds a start for a paused workspace or a dropped connection, and never for an archived thread or a dream", () => {
    const facts = {
      parked: false,
      dream: false,
      queued: false,
      workspacePaused: false,
      connected: true,
      startedBefore: false,
    } as const;
    expect(startHold(facts)).toBeUndefined();
    expect(startHold({ ...facts, parked: true })?.button).toBe(false);
    expect(startHold({ ...facts, dream: true })?.button).toBe(false);
    expect(startHold({ ...facts, workspacePaused: true })).toEqual({
      reason: "Its workspace is paused, so the session doesn't start on its own.",
      button: true,
    });
    // Not known yet is no answer to start on, and one that couldn't be read holds it as a pause.
    expect(startHold({ ...facts, workspacePaused: undefined })?.button).toBe(false);
    expect(startHold({ ...facts, workspacePaused: "unknown" })?.button).toBe(true);
    // The opening session would send what waits: never this tab's to start.
    expect(startHold({ ...facts, queued: true })?.button).toBe(false);
    expect(startHold({ ...facts, connected: false })?.button).toBe(true);
    expect(startHold({ ...facts, startedBefore: true })?.button).toBe(true);
  });

  it("shows a failed action", async () => {
    renderWithApi(<ConnectorsPanel threadId={T} />, {
      listConnectors: vi.fn(async () => LIVE),
      reconnectConnector: vi.fn(async () => {
        throw new InvalidState({ message: "Start the thread to change its connectors." });
      }),
    });
    await screen.findAllByTestId("connector");
    fireEvent.click(within(row("sentry")).getByRole("button", { name: "Reconnect" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Start the thread to change its connectors.",
    );
  });

  it("signs in through the thread's own agent: opens its page, waits, then says it's in", async () => {
    threadOn("codex");
    let signedIn = false;
    const listConnectors = vi.fn(async (): Promise<ConnectorList> => ({
      live: true,
      connectors: [
        { name: "example", status: signedIn ? "connected" : "needs-auth", scope: "user" },
      ],
    }));
    const authenticateConnector = vi.fn(async () => ({
      kind: "open" as const,
      authorizationUrl: "https://idp.example/authorize?server=example",
    }));
    const openExternal = vi.fn(async () => {});
    renderWithApi(<ConnectorsPanel threadId={T} />, {
      listConnectors,
      authenticateConnector,
      openExternal,
    });

    await screen.findAllByTestId("connector");
    expect(screen.getByText(claudeHostedElsewhere("Codex"))).toBeTruthy();
    fireEvent.click(within(row("example")).getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith("https://idp.example/authorize?server=example"),
    );
    expect(authenticateConnector).toHaveBeenCalledWith(T, "example");
    expect(await within(row("example")).findByText("Waiting for sign-in…")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Finish signing in to example in your browser. Codex keeps the sign-in; Gram never sees it.",
    );
    fireEvent.click(within(row("example")).getByRole("button", { name: "Open page again" }));
    expect(openExternal).toHaveBeenCalledTimes(2);

    signedIn = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh connectors" }));
    // The row moves out of the not-signed-in group, so it is a new element.
    await waitFor(() => expect(within(row("example")).getByText("Connected")).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Signed in to example."),
    );
  });

  it("shelves a catalogue of servers nobody signed in to, and finds one by name", async () => {
    threadOn("codex");
    const shelf = Array.from({ length: 9 }, (_, i) => ({
      name: `platform-${i}`,
      status: "needs-auth" as const,
    }));
    renderWithApi(<ConnectorsPanel threadId={T} />, {
      listConnectors: vi.fn(async (): Promise<ConnectorList> => ({
        live: true,
        connectors: [{ name: "github", status: "connected" }, ...shelf],
      })),
    });

    const fold = await screen.findByRole("button", { name: /Not signed in · 9/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("list", { name: "Connectors" }).children).toHaveLength(1);
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter connectors" }), {
      target: { value: "FORM-7" },
    });
    expect(screen.getAllByTestId("connector").map((r) => r.getAttribute("aria-label"))).toEqual([
      "platform-7",
    ]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "nope" } });
    expect(screen.getByText("No connector matches “nope”.")).toBeTruthy();

    expect(groupConnectors([{ name: "a", status: "needs-auth" }], "")).toEqual({
      inUse: [],
      signedOut: [{ name: "a", status: "needs-auth" }],
    });
  });
});
