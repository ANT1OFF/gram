import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  AddConnectorPayload,
  ConfiguredConnectors,
  ConfiguredConnectorsPayload,
  ConnectorCatalogue,
  ConnectorSignInPayload,
  mcpScopeFor,
} from "./connectors-config.ts";
import {
  CONNECTOR_HEALTH_LABEL,
  ConnectorList,
  ConnectorSignIn,
  connectorHealth,
  type Connector,
} from "./connectors.ts";
import { GramRpcs } from "./rpc.ts";
import { expectRoundTrip } from "./test-utils.ts";

/** A connected connector's health, with `connector` changed. */
const health = (connector: Partial<Connector>) =>
  connectorHealth({ status: "connected", ...connector });

describe("connectors", () => {
  it("reads each connector's state the same way in every view", () => {
    expect(health({})).toBe("connected");
    expect(health({ status: "pending" })).toBe("connecting");
    expect(health({ status: "pending", unconfirmed: true })).toBe("connecting");
    expect(health({ status: "needs-auth" })).toBe("needs-auth");
    expect(health({ status: "failed" })).toBe("failed");
    expect(health({ status: "disabled" })).toBe("disabled");
    expect(health({ status: "disabled", notGiven: true })).toBe("not-given");
    expect(CONNECTOR_HEALTH_LABEL["needs-auth"]).toBe("Not signed in");
  });

  it("round-trips live and not-live listings, keeping absent fields absent", () => {
    for (const list of [
      {
        live: true,
        connectors: [
          { name: "github", status: "connected", scope: "user" },
          {
            name: "linear",
            status: "needs-auth",
            scope: "claudeai",
            error: "Authentication required",
          },
          { name: "local", status: "pending" },
        ],
      },
      {
        live: true,
        connectors: [
          {
            name: "claude.ai Internal KB",
            status: "connected",
            scope: "claudeai",
            source: "claudeai",
            url: "https://mcp.example.invalid/internal-kb",
            tools: [
              { name: "search", readOnly: true },
              { name: "purge", readOnly: false, destructive: true },
              { name: "plain" },
            ],
            claudeAi: { id: "mcpsrv_1", orgManaged: true },
          },
          {
            name: "claude.ai Gmail",
            status: "failed",
            scope: "claudeai",
            claudeAi: { blocked: "Not allowed for your seat", claudeSignInRejected: true },
          },
        ],
        claudeAiUnavailable: "claude.ai connectors need your Claude sign-in.",
      },
      { live: false, reason: "noSession" },
      { live: false, reason: "unsupported" },
    ])
      expectRoundTrip(ConnectorList, Schema.decodeUnknownSync(ConnectorList)(list));
    expect(() =>
      Schema.decodeUnknownSync(ConnectorList)({
        live: true,
        connectors: [{ name: "x", status: "offline" }],
      }),
    ).toThrow();
  });

  it("round-trips every way a sign-in starts, and an add for several agents", () => {
    expectRoundTrip(ConnectorSignIn, { kind: "open", authorizationUrl: "https://idp.example/a" });
    expectRoundTrip(ConnectorSignIn, { kind: "started" });
    expectRoundTrip(ConnectorSignIn, {
      kind: "onClaudeAi",
      authorizationUrl: "https://claude.ai/api/organizations/o/mcp/start-auth/s",
    });
    expect(() => Schema.decodeUnknownSync(ConnectorSignIn)({ kind: "open" })).toThrow();
    expect(GramRpcs.requests.has("connectors.authenticate")).toBe(true);

    const add = {
      threadId: "t1",
      scope: "local",
      name: "example",
      config: { type: "http", url: "https://organization.example.invalid/example" },
    };
    const decode = Schema.decodeUnknownSync(AddConnectorPayload);
    expectRoundTrip(AddConnectorPayload, decode({ ...add, targets: ["codex", "claude"] }));
    expect(decode(add)).not.toHaveProperty("targets");
    expect(() => decode({ ...add, targets: [] })).toThrow();
    expect(() => decode({ ...add, targets: ["acp"] })).toThrow();
  });

  it("clamps Claude Code's scopes to the ones another agent has", () => {
    expect(mcpScopeFor("claude", "local")).toBe("local");
    expect(mcpScopeFor("codex", "project")).toBe("user");
  });

  it("round-trips every agent's configured servers, and has no field for a header or env value", () => {
    const configured = Schema.decodeUnknownSync(ConfiguredConnectors)({
      agents: [
        {
          target: "claude",
          signIn: "liveOnly",
          servers: [
            { name: "linear", transport: "other", scope: "claudeai", carriesValues: false },
            {
              name: "claude.ai Atlassian",
              transport: "other",
              scope: "claudeai",
              carriesValues: false,
              signedIn: false,
              seenAt: "2026-10-08T12:00:00.000Z",
              everConnected: true,
            },
            {
              name: "claude.ai Internal KB",
              transport: "other",
              url: "https://mcp.example.invalid/internal-kb",
              scope: "claudeai",
              carriesValues: false,
              tools: [{ name: "search", readOnly: true }],
              claudeAi: { id: "mcpsrv_1" },
            },
            {
              name: "files",
              transport: "stdio",
              command: "npx",
              args: ["-y", "server-filesystem"],
              scope: "local",
              carriesValues: true,
            },
          ],
        },
        {
          target: "codex",
          signIn: "onRequest",
          servers: [
            {
              name: "example",
              transport: "http",
              url: "https://organization.example.invalid/example",
              scope: "user",
              signedIn: false,
              carriesValues: false,
              disabled: true,
            },
          ],
        },
        { target: "codex", signIn: "reported", servers: [], error: "config.toml: malformed" },
      ],
    });
    expectRoundTrip(ConfiguredConnectors, configured);
    expectRoundTrip(ConfiguredConnectors, {
      agents: [
        {
          target: "claude",
          signIn: "liveOnly",
          servers: [],
          claudeAiUnavailable: "claude.ai connectors need your Claude sign-in.",
        },
      ],
    });
    // Decoding drops what the schema doesn't name, so a reader that leaked one couldn't send it.
    const leaked = Schema.decodeUnknownSync(ConfiguredConnectors)({
      agents: [
        {
          target: "codex",
          signIn: "onRequest",
          servers: [
            {
              name: "x",
              transport: "http",
              scope: "user",
              carriesValues: true,
              headers: { Authorization: "Bearer hunter2hunter2" },
              env: { KEY: "hunter2hunter2" },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(leaked)).not.toContain("hunter2");

    expectRoundTrip(ConfiguredConnectorsPayload, { cwd: "/repo", checkSignIn: ["codex"] });
    expectRoundTrip(ConfiguredConnectorsPayload, {});
    expectRoundTrip(ConnectorSignInPayload, { target: "codex", name: "example", cwd: "/repo" });
    const signIn = Schema.decodeUnknownSync(ConnectorSignInPayload);
    expect(() => signIn({ target: "grok", name: "example" })).toThrow();
    expect(() => signIn({ target: "codex", name: "" })).toThrow();
    // A claude.ai connector goes by its display name.
    expectRoundTrip(ConnectorSignInPayload, {
      target: "claude",
      name: "claude.ai Teams",
      scope: "claudeai",
    });
    for (const tag of ["connectors.configured", "connectors.signIn"] as const) {
      const errors = JSON.stringify(GramRpcs.requests.get(tag)!.errorSchema.ast);
      expect(errors).toContain("NotImplemented");
    }
  });

  it("registers the connector RPCs and decodes a toggle", () => {
    const tags = [...GramRpcs.requests.keys()];
    expect(tags).toEqual(
      expect.arrayContaining(["connectors.list", "connectors.reconnect", "connectors.setEnabled"]),
    );
    const decode = Schema.decodeUnknownSync(
      GramRpcs.requests.get("connectors.setEnabled")!.payloadSchema,
    );
    expect(decode({ threadId: "t1", name: "github", enabled: false })).toEqual({
      threadId: "t1",
      name: "github",
      enabled: false,
    });
    expect(() => decode({ threadId: "t1", name: "github" })).toThrow();
  });

  it("round-trips the platform's catalogue, with and without its Entra details", () => {
    expectRoundTrip(ConnectorCatalogue, {
      source: "EXAMPLE/example-mcp-servers",
      servers: [
        {
          id: "registry",
          title: "npm registry",
          description: "Read-only Artifactory and Xray",
          url: "https://mcp.example.invalid/registry",
          access: { everyone: true, groups: ["SYS_(MCP)_(All Users)"] },
          signInUnsupported: [],
        },
        { id: "agresso", title: "Agresso", url: "https://mcp.example.invalid/agresso" },
      ],
      detailsError: "Couldn't read EXAMPLE/example-identity-apps",
    });
    const decode = Schema.decodeUnknownSync(ConnectorCatalogue);
    expect(() =>
      decode({ source: "x", servers: [{ id: "a b", title: "A", url: "https://x/a" }] }),
    ).toThrow();
  });
});
