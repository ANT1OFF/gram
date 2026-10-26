import { it as effectIt } from "@effect/vitest";
import { ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
  accessOf,
  catalogueFrom,
  codexRedirect,
  McpCatalogue,
  McpCatalogueLive,
  readmeEntries,
  signInUnsupportedBy,
} from "./catalogue.ts";

const README = [
  "| Server | Description | Install | Documentation |",
  "| ------ | ----------- | ------- | ------------- |",
  '| **Example** | Minimal MCP server template | <a href="https://cursor.com/x">add</a> | [Docs](mcp/example/README.md) |',
  "| **npm registry** | Read-only Artifactory and Xray | — | [Docs](mcp/registry/README.md) |",
  "| **Bloomberg** | Local only | — | [Docs](local-mcp/bloomberg/README.md) |",
].join("\n");

const auth = (id: string, redirects: ReadonlyArray<string>) =>
  [
    "identifier_uris:",
    `  - https://mcp.example.invalid/${id}`,
    "public_client_reply_urls:",
    ...redirects.map((uri) => `  - ${uri}`),
    "access_token_version: 2",
  ].join("\n");

const base = (groups: ReadonlyArray<string>) =>
  [
    "name: MCP X",
    "service_principal:",
    "  enterprise_app: true",
    "  role_assignments:",
    ...groups.flatMap((group) => [`    - name: ${group}`, "      role: x_user"]),
  ].join("\n");

describe("the MCP platform's catalogue", () => {
  it("derives Codex's per-server redirect as the platform registers it", () => {
    // Deterministic redirect for a synthetic MCP endpoint.
    expect(codexRedirect("https://mcp.example.invalid/example")).toBe(
      "http://127.0.0.1/callback/2SzmdK7bbc54",
    );
  });

  it("reads titles from the README, and each app's access and the agents it accepts", () => {
    expect([...readmeEntries(README)]).toEqual([
      ["example", { title: "Example", description: "Minimal MCP server template" }],
      ["registry", { title: "npm registry", description: "Read-only Artifactory and Xray" }],
    ]);
    expect(accessOf(base(["SYS_(MCP)_(All Users)"]))).toEqual({
      everyone: true,
      groups: ["SYS_(MCP)_(All Users)"],
    });
    expect(accessOf(base(["SYS_(MCP)_(registry)"]))).toEqual({
      everyone: false,
      groups: ["SYS_(MCP)_(registry)"],
    });
    const url = "https://mcp.example.invalid/example";
    expect(
      signInUnsupportedBy(
        auth("example", [
          "http://127.0.0.1:19876/mcp/oauth/callback",
          "http://localhost:8000/callback",
          codexRedirect(url),
        ]),
        url,
      ),
    ).toEqual([]);
    // Codex's address is per server, so another server's doesn't count.
    expect(
      signInUnsupportedBy(
        auth("example", ["http://localhost:8000/callback", codexRedirect(`${url}/`)]),
        url,
      ),
    ).toEqual(["codex"]);
  });

  it("lists a server only with its production app, or every described one without the apps", () => {
    const servers = { readme: README, ids: ["registry", "example", "undocumented", "Bad_Name"] };
    const apps = new Map([
      [
        "example",
        {
          auth: auth("example", ["http://localhost:8000/callback"]),
          base: base(["SYS_(MCP)_(All Users)"]),
        },
      ],
      ["undocumented", { auth: auth("undocumented", []) }],
      // An app for another address isn't this server's.
      ["registry", { auth: auth("elsewhere", []) }],
    ]);
    expect(catalogueFrom(servers, apps)).toEqual([
      {
        id: "example",
        title: "Example",
        description: "Minimal MCP server template",
        url: "https://mcp.example.invalid/example",
        access: { everyone: true, groups: ["SYS_(MCP)_(All Users)"] },
        signInUnsupported: ["codex"],
      },
      {
        id: "undocumented",
        title: "undocumented",
        url: "https://mcp.example.invalid/undocumented",
        signInUnsupported: ["claude", "codex"],
      },
    ]);
    expect(catalogueFrom(servers, undefined).map((server) => server.id)).toEqual([
      "example",
      "registry",
    ]);
  });
});

// `GRAM_LIVE_MCP_CATALOGUE=1`: the catalogue as the signed-in `gh` reads it. It reaches GitHub only,
// never a server it lists.
describe.skipIf(process.env["GRAM_LIVE_MCP_CATALOGUE"] !== "1")(
  "MCP platform catalogue, live (GRAM_LIVE_MCP_CATALOGUE)",
  () => {
    effectIt.live(
      "lists the platform's servers with access and sign-in support",
      () =>
        Effect.gen(function* () {
          const catalogue = yield* (yield* McpCatalogue).read;
          expect(catalogue.detailsError).toBeUndefined();
          const example = catalogue.servers.find((server) => server.id === "example");
          expect(example).toMatchObject({
            url: "https://mcp.example.invalid/example",
            access: { everyone: true },
            signInUnsupported: [],
          });
          console.log(
            `catalogue: ${catalogue.servers.length} servers, ${
              catalogue.servers.filter((server) => (server.signInUnsupported ?? []).length > 0)
                .length
            } refusing some agent's sign-in`,
          );
        }).pipe(Effect.provide(McpCatalogueLive.pipe(Layer.provide(ProcLive)))),
      60_000,
    );
  },
);
