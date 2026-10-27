// @vitest-environment happy-dom
import { type AgentConfiguredServers, type ConfiguredServer } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  catalogueRows,
  connectorMatrix,
  copyTo,
  elsewhereDraft,
  elsewhereName,
  ELSEWHERE_SIGN_IN_HINT,
  freshServersOf,
  isRemovable,
  withSignIns,
} from "@/panels/connectors-model";
import { renderWithApi } from "@/panels/test-utils";

import { REFRESH_POLL_MS, nextConfiguredRead } from "./connectors-refresh";
import { ConnectorsSettings } from "./connectors-section";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const remote = (name: string, extra: Partial<ConfiguredServer> = {}): ConfiguredServer => ({
  name,
  transport: "http",
  url: `https://organization.example.invalid/${name}`,
  scope: "user",
  carriesValues: false,
  ...extra,
});

const AGENTS: ReadonlyArray<AgentConfiguredServers> = [
  {
    target: "claude",
    signIn: "liveOnly",
    servers: [
      remote("github"),
      { name: "linear", transport: "other", scope: "claudeai", carriesValues: false },
      {
        name: "files",
        transport: "stdio",
        command: "npx",
        args: ["-y", "fs"],
        scope: "local",
        carriesValues: true,
      },
    ],
  },
  {
    target: "codex",
    signIn: "onRequest",
    servers: [
      remote("github", { signedIn: true }),
      remote("example", { signedIn: false }),
      remote("keyed", { carriesValues: true }),
      remote("team", { scope: "project", signedIn: false }),
    ],
  },
];

describe("connectorMatrix and friends", () => {
  it("makes one row per name, and shelves what nobody is signed in to", () => {
    const matrix = connectorMatrix(AGENTS, "");
    expect(matrix.inUse.map((row) => row.name)).toEqual(["files", "github", "keyed", "linear"]);
    expect(matrix.signedOut.map((row) => row.name)).toEqual(["example", "team"]);
    expect(matrix.total).toBe(6);
    const github = matrix.inUse.find((row) => row.name === "github")!;
    expect(Object.keys(github.cells)).toEqual(["claude", "codex"]);
    expect(github.address).toBe("https://organization.example.invalid/github");
    expect(matrix.inUse[0]!.address).toBe("npx -y fs");

    const filtered = connectorMatrix(AGENTS, " EXA ");
    expect([...filtered.inUse, ...filtered.signedOut].map((row) => row.name)).toEqual(["example"]);
    expect(filtered.total).toBe(6);

    // One agent signed in is enough to take a server off the shelf.
    const asked = withSignIns(AGENTS, [
      {
        target: "codex",
        signIn: "onRequest",
        servers: [remote("example", { signedIn: true }), remote("team", { signedIn: false })],
      },
    ]);
    expect(connectorMatrix(asked, "").signedOut.map((row) => row.name)).toEqual(["team"]);
  });

  it("matches a platform server to each agent's copy by address, and offers it where it's missing", () => {
    const servers = [
      {
        id: "example",
        title: "Example",
        description: "The canary",
        url: "https://organization.example.invalid/example",
        signInUnsupported: ["codex" as const],
      },
      { id: "teams", title: "Teams", url: "https://organization.example.invalid/teams" },
    ];
    const [example, teams] = catalogueRows(servers, AGENTS, "");
    // Codex has it at that address; Codex has it too, though its app refuses Codex's sign-in.
    expect(Object.keys(example!.row.cells)).toEqual(["codex"]);
    expect(example!.missing).toEqual(["claude"]);
    expect(teams!.missing).toEqual(["claude", "codex"]);
    expect(catalogueRows(servers, AGENTS, "CANARY").map((entry) => entry.server.id)).toEqual([
      "example",
    ]);

    // A name another server holds isn't overwritten, and Codex's copy must be at the exact URL.
    const [taken] = catalogueRows(
      [{ id: "github", title: "GitHub", url: "https://mcp.example.invalid/github" }],
      AGENTS,
      "",
    );
    expect(Object.keys(taken!.blocked)).toEqual(["claude", "codex"]);
    expect(taken!.blocked.codex).toContain("already has a server called github");
    expect(taken!.missing).toEqual([]);
    const [slashed] = catalogueRows(
      [{ id: "example", title: "Example", url: "https://organization.example.invalid/example" }],
      [
        {
          target: "codex",
          signIn: "onRequest",
          servers: [remote("ex", { url: "https://organization.example.invalid/example/" })],
        },
      ],
      "",
    );
    expect(slashed!.row.cells.codex).toBeUndefined();
    expect(slashed!.blocked.codex).toContain(
      "only at https://organization.example.invalid/example",
    );
  });

  it("copies a plain remote server as it stands, and sends the rest through the form", () => {
    const rows = [...connectorMatrix(AGENTS, "").inUse, ...connectorMatrix(AGENTS, "").signedOut];
    const row = (name: string) => rows.find((r) => r.name === name)!;

    expect(copyTo(row("example"), "claude", false)).toEqual({
      kind: "direct",
      scope: "user",
      config: { type: "http", url: "https://organization.example.invalid/example" },
    });
    // The project's own servers keep their scope, but only when a project is picked.
    expect(copyTo(row("team"), "claude", true)).toMatchObject({ kind: "direct", scope: "project" });
    expect(copyTo(row("team"), "claude", false)).toMatchObject({ kind: "direct", scope: "user" });

    // Values never reach the UI, so a server that has some can't be copied blind.
    expect(copyTo(row("keyed"), "codex", false)).toMatchObject({
      kind: "form",
      draft: {
        name: "keyed",
        transport: "http",
        url: "https://organization.example.invalid/keyed",
      },
    });
    // So does one whose address arrived masked: the copy would be a broken URL.
    const masked = connectorMatrix(
      [
        {
          target: "claude",
          signIn: "liveOnly",
          servers: [
            remote("tokened", { url: "https://x.example/mcp?token=••••", carriesValues: true }),
          ],
        },
      ],
      "",
    ).inUse[0]!;
    expect(copyTo(masked, "codex", false)).toMatchObject({
      kind: "form",
      draft: { url: "https://x.example/mcp" },
    });
    expect(copyTo(row("files"), "codex", true)).toMatchObject({
      kind: "form",
      draft: { name: "files", transport: "stdio", command: "npx", args: "-y\nfs" },
    });
    const hosted = copyTo(row("linear"), "codex", false);
    expect(hosted).toMatchObject({ kind: "form", draft: { name: "linear" } });
    expect(hosted.kind === "form" && hosted.note).toContain("claude.ai");

    // A claude.ai connector with its upstream address goes to the form with it filled in.
    const [withUrl] = connectorMatrix(
      [
        {
          target: "claude",
          signIn: "liveOnly",
          servers: [
            {
              name: "claude.ai Internal KB",
              transport: "other",
              url: "https://mcp.example.invalid/internal-kb",
              scope: "claudeai",
              carriesValues: false,
            },
          ],
        },
      ],
      "",
    ).inUse;
    expect(copyTo(withUrl!, "codex", false)).toEqual({
      kind: "form",
      draft: {
        name: "internal-kb",
        transport: "http",
        url: "https://mcp.example.invalid/internal-kb",
      },
      note:
        "The agent signs in to the server itself; your Claude sign-in isn't shared. " +
        ELSEWHERE_SIGN_IN_HINT,
    });

    expect(isRemovable("claude", row("files").cells.claude!)).toBe(true);
    expect(isRemovable("claude", row("linear").cells.claude!)).toBe(false);
    expect(isRemovable("codex", remote("team", { scope: "project" }))).toBe(false);
  });

  it("names a claude.ai connector for another agent, and says when its sign-in may be refused", () => {
    expect(elsewhereName("claude.ai Internal KB", "https://mcp.example.invalid/internal-kb/")).toBe(
      "internal-kb",
    );
    expect(elsewhereName("claude.ai Microsoft 365 (2)", "https://m365.example/mcp")).toBe(
      "microsoft-365",
    );
    expect(elsewhereName("claude.ai ✨", "https://x.example/mcp")).toBe("connector");
    const gmail = elsewhereDraft("claude.ai Gmail", "https://gmail.example/mcp?key=••••");
    expect(gmail).toMatchObject({
      kind: "form",
      draft: { name: "gmail", transport: "http", url: "https://gmail.example/mcp" },
    });
    expect(gmail.kind === "form" && gmail.note).toContain("query values stay masked");
    expect(gmail.kind === "form" && gmail.note).toContain("accept only claude.ai's sign-in");

    // The agents' writers replace a server of the same name, so a taken one is never filled in,
    // and the server already there at that address is that server, whatever it's called.
    const taken = [remote("gmail", { url: "https://other.example/mcp" }), remote("gmail-2")];
    expect(elsewhereDraft("claude.ai Gmail", "https://gmail.example/mcp", taken)).toMatchObject({
      kind: "form",
      draft: { name: "gmail-3" },
    });
    expect(
      elsewhereDraft("claude.ai Gmail", "https://Gmail.example/mcp/", [
        remote("mail", { url: "https://gmail.example/mcp" }),
      ]),
    ).toEqual({ kind: "present", name: "mail" });
    // An address with a query can't be compared, masked as it is, so it's never "already there".
    const tenant = "https://organization.example.invalid/mcp?tenant=••••";
    for (const [mine, theirs] of [
      [tenant, "https://organization.example.invalid/mcp"],
      ["https://organization.example.invalid/mcp", tenant],
      [tenant, tenant],
    ] as const) {
      expect(
        elsewhereDraft("claude.ai Example", mine, [remote("example", { url: theirs })], "codex"),
      ).toMatchObject({ kind: "form", draft: { name: "example-2" } });
    }
    // Codex's sign-in hangs on the exact URL, so its copy with a trailing slash isn't this one.
    const slashed = [remote("internal-kb", { url: "https://mcp.example.invalid/internal-kb/" })];
    const kb = "https://mcp.example.invalid/internal-kb";
    expect(elsewhereDraft("claude.ai Internal KB", kb, slashed, "codex")).toMatchObject({
      kind: "form",
      draft: { name: "internal-kb-2", url: kb },
    });
    expect(elsewhereDraft("claude.ai Internal KB", kb, slashed, "claude")).toEqual({
      kind: "present",
      name: "internal-kb",
    });
  });

  it("reads the destination afresh before a copy, and refuses when it can't be read", async () => {
    const read = vi.fn(async (): Promise<{ agents: ReadonlyArray<AgentConfiguredServers> }> => ({
      agents: [{ target: "codex" as const, signIn: "onRequest" as const, servers: [remote("kb")] }],
    }));
    expect((await freshServersOf(read, "codex", "/repo")).map((s) => s.name)).toEqual(["kb"]);
    expect(read).toHaveBeenCalledWith({ cwd: "/repo", fresh: true });
    // A failed read is no proof that a name is free.
    read.mockResolvedValueOnce({
      agents: [{ target: "codex", signIn: "onRequest", servers: [], error: "bad" }],
    });
    await expect(freshServersOf(read, "codex")).rejects.toThrow("Couldn't read Codex's config");
    await expect(freshServersOf(read, "claude")).rejects.toThrow("Couldn't read Claude Code's");
  });

  it("polls only a pending local read", () => {
    expect(nextConfiguredRead({ agents: AGENTS, refreshing: true })).toBe(REFRESH_POLL_MS);
    expect(nextConfiguredRead({ agents: AGENTS })).toBe(false);
  });
});

const row = (name: string) =>
  screen.getAllByTestId("configured-connector").find((r) => r.getAttribute("aria-label") === name)!;

const api = (agents: ReadonlyArray<AgentConfiguredServers> = AGENTS) => ({
  listProjects: vi.fn(async () => []),
  listConfiguredConnectors: vi.fn(async () => ({ agents })),
  openExternal: vi.fn(async () => {}),
});

/** A claude.ai connector a running Claude thread says is signed out, in Claude Code's list. */
const linear: ConfiguredServer = {
  name: "linear",
  transport: "other",
  scope: "claudeai",
  carriesValues: false,
  signedIn: false,
};
const withLinear = (server: ConfiguredServer): ReadonlyArray<AgentConfiguredServers> => [
  { target: "claude", signIn: "liveOnly", servers: [server] },
  AGENTS[1]!,
];

/** Claude Code's list where it can sign in with no thread running. */
const threadless = (server: ConfiguredServer): ReadonlyArray<AgentConfiguredServers> => [
  { target: "claude", signIn: "liveOnly", threadlessSignIn: true, servers: [server] },
  AGENTS[1]!,
];

describe("ConnectorsSettings", () => {
  it("shows each agent's copy quietly, and asks Codex for sign-ins only when told to", async () => {
    const mock = api();
    renderWithApi(<ConnectorsSettings />, mock);
    await screen.findAllByTestId("configured-connector");

    expect(mock.listConfiguredConnectors.mock.calls).toEqual([[{}]]);
    expect(within(row("github")).getByText("Signed in")).toBeTruthy();
    expect(within(row("github")).getAllByText("Configured")).toHaveLength(1);
    expect(within(row("linear")).getByText("claude.ai")).toBeTruthy();
    expect(within(row("linear")).queryByRole("button", { name: / actions$/ })).toBeNull();
    // "Not signed in" is ordinary: muted, never the destructive or warning tone.
    const signedOut = within(row("example")).getByText("Not signed in");
    expect(signedOut.className).toContain("text-muted-foreground");
    expect(signedOut.className).not.toMatch(/destructive|warning/);
    // Without a running Claude thread nothing says a Claude Code server is signed out.
    expect(screen.queryByRole("button", { name: /Sign in to .* in Claude Code/ })).toBeNull();
    expect(screen.getByText(/signs in through that thread/)).toBeTruthy();

    mock.listConfiguredConnectors.mockImplementation(async () => ({
      agents: withSignIns(AGENTS, [
        { target: "codex", signIn: "onRequest", servers: [remote("example", { signedIn: true })] },
      ]),
    }));
    fireEvent.click(screen.getByRole("button", { name: "Check sign-ins" }));
    await waitFor(() =>
      expect(mock.listConfiguredConnectors).toHaveBeenLastCalledWith({ checkSignIn: ["codex"] }),
    );
    await waitFor(() => expect(within(row("example")).getByText("Signed in")).toBeTruthy());
  });

  it("offers a sign-in for a signed-out server, and its refresh reads afresh", async () => {
    const mock = {
      ...api(),
      listConfiguredConnectors: vi.fn(async () => ({
        agents: AGENTS,
      })),
    };
    renderWithApi(<ConnectorsSettings />, mock);
    await screen.findAllByTestId("configured-connector");
    expect(within(row("example")).getByText("Not signed in")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in to example in Codex" })).toBeTruthy();
    // The page's own refresh reads afresh; opening it took the last read.
    expect(mock.listConfiguredConnectors.mock.calls).toEqual([[{}]]);
    fireEvent.click(screen.getByRole("button", { name: "Refresh connectors" }));
    await waitFor(() =>
      expect(mock.listConfiguredConnectors).toHaveBeenLastCalledWith({ fresh: true }),
    );
  });

  it("folds a catalogue nobody signed in to, and finds a server by name", async () => {
    const catalogue = Array.from({ length: 12 }, (_, i) =>
      remote(`platform-${i}`, { signedIn: false }),
    );
    renderWithApi(
      <ConnectorsSettings />,
      api([
        { target: "claude", signIn: "liveOnly", servers: [] },
        { target: "codex", signIn: "onRequest", servers: [remote("github"), ...catalogue] },
      ]),
    );
    const fold = await screen.findByRole("button", { name: /Not signed in/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(fold.textContent).toContain("12");
    expect(
      screen.getByRole("rowgroup", { name: "Servers not signed in", hidden: true }),
    ).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter connectors" }), {
      target: { value: "platform-7" },
    });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("configured-connector")).toHaveLength(1);
  });

  it("adds a server to an agent that lacks it, signs in and removes, each through that agent", async () => {
    const mock = {
      ...api(),
      addConnector: vi.fn(async () => ({ name: "example", session: "noSession" as const })),
      removeConnector: vi.fn(async () => ({ name: "example", session: "noSession" as const })),
      signInConnector: vi.fn(async () => ({
        kind: "open" as const,
        authorizationUrl: "https://idp.example/authorize",
      })),
    };
    renderWithApi(<ConnectorsSettings />, mock);
    await screen.findAllByTestId("configured-connector");

    fireEvent.click(
      within(row("example")).getByRole("button", { name: "Add example to Claude Code" }),
    );
    await waitFor(() =>
      expect(mock.addConnector).toHaveBeenCalledWith({
        scope: "user",
        name: "example",
        config: { type: "http", url: "https://organization.example.invalid/example" },
        targets: ["claude"],
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain("keeps its own sign-in");

    // A claude.ai connector has no address to copy, so the form opens with its name filled in.
    fireEvent.click(within(row("linear")).getByRole("button", { name: "Add linear to Codex" }));
    const form = await screen.findByTestId("connector-add-form");
    expect((within(form).getByLabelText("Server name") as HTMLInputElement).value).toBe("linear");
    expect(within(form).getByRole("checkbox", { name: "Codex" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(within(form).getAllByRole("radio", { name: /Local|Project|User/ })).toHaveLength(1);
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));

    fireEvent.click(
      within(row("example")).getByRole("button", { name: "Sign in to example in Codex" }),
    );
    await waitFor(() =>
      expect(mock.signInConnector).toHaveBeenCalledWith({
        target: "codex",
        name: "example",
        scope: "user",
      }),
    );
    await waitFor(() =>
      expect(mock.openExternal).toHaveBeenCalledWith("https://idp.example/authorize"),
    );
    expect(await within(row("example")).findByText("Waiting for sign-in…")).toBeTruthy();

    // Asked once, Codex isn't asked again by the refreshes that follow every change.
    fireEvent.click(screen.getByRole("button", { name: "Check sign-ins" }));
    await waitFor(() =>
      expect(mock.listConfiguredConnectors).toHaveBeenLastCalledWith({ checkSignIn: ["codex"] }),
    );
    const reads = mock.listConfiguredConnectors.mock.calls.length;
    fireEvent.click(within(row("keyed")).getByRole("button", { name: "keyed in Codex actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from Codex…" }));
    // Nothing goes until the strip under the row is confirmed.
    const strip = within(row("keyed")).getByRole("group", { name: "Remove keyed from Codex" });
    expect(strip.textContent).toContain("the other agents keep theirs");
    expect(strip.textContent).toContain("A sign-in it had isn't revoked.");
    expect(mock.removeConnector).not.toHaveBeenCalled();
    fireEvent.click(within(strip).getByRole("button", { name: "Remove server" }));
    await waitFor(() =>
      expect(mock.removeConnector).toHaveBeenCalledWith({
        name: "keyed",
        scope: "user",
        target: "codex",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh connectors" }));
    await waitFor(() =>
      expect(mock.listConfiguredConnectors.mock.calls.length).toBeGreaterThan(reads),
    );
    expect(
      mock.listConfiguredConnectors.mock.calls
        .slice(reads)
        .every((call) => !JSON.stringify(call).includes("checkSignIn")),
    ).toBe(true);
  });

  it("signs Claude Code in through a running thread, and watches for it to finish", async () => {
    const mock = {
      ...api(withLinear(linear)),
      signInConnector: vi.fn(async () => ({
        kind: "open" as const,
        authorizationUrl: "https://claude.ai/connect/linear",
      })),
    };
    renderWithApi(<ConnectorsSettings />, mock);
    const signIn = await screen.findByRole("button", { name: "Sign in to linear in Claude Code" });
    fireEvent.click(signIn);
    await waitFor(() =>
      expect(mock.signInConnector).toHaveBeenCalledWith({
        target: "claude",
        name: "linear",
        scope: "claudeai",
      }),
    );
    await waitFor(() =>
      expect(mock.openExternal).toHaveBeenCalledWith("https://claude.ai/connect/linear"),
    );
    expect(await within(row("linear")).findByText("Waiting for sign-in…")).toBeTruthy();

    // The running thread reports it signed in on a later poll.
    mock.listConfiguredConnectors.mockImplementation(async () => ({
      agents: withLinear({ ...linear, signedIn: true }),
    }));
    expect(await screen.findByText("Signed in to linear.", {}, { timeout: 5_000 })).toBeTruthy();
  });

  it("signs Claude Code in with no thread running, and says why one didn't finish", async () => {
    const mock = {
      ...api(threadless(remote("example"))),
      signInConnector: vi.fn(async () => ({ kind: "started" as const })),
    };
    renderWithApi(<ConnectorsSettings />, mock);
    const signIn = await screen.findByRole("button", { name: "Sign in to example in Claude Code" });
    expect(screen.getByText(/Sign in works without one/)).toBeTruthy();
    fireEvent.click(signIn);
    await waitFor(() =>
      expect(mock.signInConnector).toHaveBeenCalledWith({
        target: "claude",
        name: "example",
        scope: "user",
      }),
    );
    // Claude Code opens the browser itself.
    expect(mock.openExternal).not.toHaveBeenCalled();
    expect(await within(row("example")).findByText("Waiting for sign-in…")).toBeTruthy();

    mock.listConfiguredConnectors.mockImplementation(async () => ({
      agents: threadless(remote("example", { signInFailed: "Authentication timeout" })),
    }));
    expect(
      await screen.findByText(
        "Claude Code didn't finish signing in to example: Authentication timeout",
        {},
        { timeout: 5_000 },
      ),
    ).toBeTruthy();
    expect(within(row("example")).queryByText("Waiting for sign-in…")).toBeNull();
  });

  it("shows claude.ai connectors as last seen with no thread, and signs in on claude.ai", async () => {
    const seenAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const lastSeen: ReadonlyArray<AgentConfiguredServers> = [
      {
        target: "claude",
        signIn: "liveOnly",
        claudeAiFrom: "lastSeen",
        servers: [
          { ...linear, seenAt, everConnected: true },
          { ...linear, name: "claude.ai Teams", seenAt, signedIn: true },
        ],
      },
      AGENTS[1]!,
    ];
    const mock = {
      ...api(lastSeen),
      signInConnector: vi.fn(async () => ({
        kind: "onClaudeAi" as const,
        authorizationUrl: "https://claude.ai/api/organizations/o/mcp/start-auth/s",
      })),
    };
    renderWithApi(<ConnectorsSettings />, mock);
    const signIn = await screen.findByRole("button", { name: "Sign in to linear in Claude Code" });
    // Signed in before, so its sign-in lapsed; each row says when it was seen.
    expect(within(row("linear")).getByText("Signed out")).toBeTruthy();
    expect(within(row("linear")).getByText("as of 5m ago")).toBeTruthy();
    expect(within(row("claude.ai Teams")).getByText("Signed in")).toBeTruthy();
    expect(screen.getByText(/as a Claude thread last reported them, 5m ago/)).toBeTruthy();

    fireEvent.click(signIn);
    await waitFor(() =>
      expect(mock.openExternal).toHaveBeenCalledWith(
        "https://claude.ai/api/organizations/o/mcp/start-auth/s",
      ),
    );
    expect(await screen.findByText(/Finish signing in to linear on claude\.ai/)).toBeTruthy();
    // claude.ai tells nobody when it's done, so the row isn't left waiting.
    expect(within(row("linear")).queryByText("Waiting for sign-in…")).toBeNull();
  });

  it("moves a last-seen row's age on with the clock, without reading the list again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const seenAt = new Date(Date.now() - 5 * 60_000).toISOString();
      const mock = api([
        {
          target: "claude",
          signIn: "liveOnly",
          claudeAiFrom: "lastSeen",
          servers: [{ ...linear, seenAt }],
        },
        AGENTS[1]!,
      ]);
      renderWithApi(<ConnectorsSettings />, mock);
      expect(await screen.findByText("as of 5m ago")).toBeTruthy();
      const reads = mock.listConfiguredConnectors.mock.calls.length;
      act(() => void vi.advanceTimersByTime(60_000));
      expect(await screen.findByText("as of 6m ago")).toBeTruthy();
      expect(mock.listConfiguredConnectors.mock.calls.length).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers local claude.ai sign-in for a connector used before", async () => {
    renderWithApi(<ConnectorsSettings />, {
      ...api([
        {
          target: "claude",
          signIn: "liveOnly",
          claudeAiFrom: "history",
          servers: [
            {
              name: "linear",
              transport: "other",
              scope: "claudeai",
              carriesValues: false,
              everConnected: true,
            },
          ],
        },
        AGENTS[1]!,
      ]),
    });
    await screen.findAllByTestId("configured-connector");
    expect(
      await screen.findByRole("button", { name: "Sign in to linear in Claude Code" }),
    ).toBeTruthy();
    expect(within(row("linear")).getByText("Used before")).toBeTruthy();
    expect(screen.getByText(/you've used before are listed/)).toBeTruthy();
  });

  it("does not load or offer the inherited corporate catalogue", async () => {
    const mock = {
      ...api(),
      listConnectorCatalogue: vi.fn(async () => ({ source: "synthetic", servers: [] })),
    };
    renderWithApi(<ConnectorsSettings />, mock);
    await screen.findAllByTestId("configured-connector");
    expect(screen.queryByRole("button", { name: "Browse servers" })).toBeNull();
    expect(mock.listConnectorCatalogue).not.toHaveBeenCalled();
  });

  it("keeps the other agents' servers when one config can't be read", async () => {
    const mock = {
      ...api([
        AGENTS[0]!,
        { target: "codex", signIn: "onRequest", servers: [], error: "config.toml: line 3" },
      ]),
      addConnector: vi.fn(async () => ({ name: "github", session: "noSession" as const })),
    };
    renderWithApi(<ConnectorsSettings />, mock);
    await screen.findAllByTestId("configured-connector");
    expect(screen.getByText(/Couldn.t read Codex.s config: config.toml: line 3/)).toBeTruthy();
    expect(within(row("github")).getByText("Configured")).toBeTruthy();
    fireEvent.click(within(row("github")).getByRole("button", { name: "Add github to Codex" }));
    await waitFor(() => expect(screen.getByText(/Couldn.t read Codex.s config/)).toBeTruthy());
    expect(mock.addConnector).not.toHaveBeenCalled();
  });
});
