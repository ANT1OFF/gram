import { describe, expect, it } from "vitest";
import {
  checkMcpServerProposal,
  commandLineOf,
  mcpServerProposalCard,
  mcpServerProposalSummary,
  secretName,
  secretValue,
  type McpServerProposeInput,
} from "./mcp-propose.ts";

const stdio = (
  server: Partial<{ command: string; args: Array<string>; env: Record<string, string> }> = {},
): McpServerProposeInput => ({
  name: "docs-index",
  server: { type: "stdio", command: "npx", args: ["-y", "@example/docs-index-mcp"], ...server },
  targets: ["claude"],
  reason: "Search the docs.",
});

const remote = (url: string, headers?: Record<string, string>): McpServerProposeInput => ({
  name: "tracker",
  server: { type: "http", url, ...(headers === undefined ? {} : { headers }) },
  targets: ["claude", "codex"],
  reason: "Read the tracker.",
});

/** A right-to-left override and a zero-width space, which would hide what the card shows. */
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);

/** The errors a proposal is refused with, or `[]` when it passes. */
const errorsOf = (input: McpServerProposeInput) => {
  const checked = checkMcpServerProposal(input, ["gram"]);
  return checked.ok ? [] : checked.errors;
};

describe("checkMcpServerProposal", () => {
  it("passes an ordinary local and remote server, defaulting to the user scope", () => {
    const local = checkMcpServerProposal(stdio({ env: { LOG_LEVEL: "info" } }));
    expect(local).toMatchObject({ ok: true, proposal: { scope: "user", replace: false } });
    const far = checkMcpServerProposal(remote("https://mcp.example.invalid/tracker?region=eu"));
    expect(far).toMatchObject({ ok: true });
    expect(errorsOf(remote("http://localhost:8123/mcp"))).toEqual([]);
  });

  it("refuses bad and reserved names, and an empty reason", () => {
    expect(errorsOf({ ...stdio(), name: "has space" })[0]).toContain("letters, digits");
    expect(errorsOf({ ...stdio(), name: "Gram" })[0]).toContain("Gram's own server");
    expect(errorsOf({ ...stdio(), reason: "  " })[0]).toContain("Say why");
  });

  it("refuses what the targets can't run: SSE or a project scope in Codex", () => {
    expect(
      errorsOf({
        ...remote("https://mcp.example.invalid/sse"),
        server: { type: "sse", url: "https://mcp.example.invalid/sse" },
      }),
    ).toEqual([expect.stringContaining("Codex connects over streamable HTTP only")]);
    expect(errorsOf({ ...stdio(), targets: ["codex"], scope: "project" })).toEqual([
      expect.stringContaining("Codex keeps MCP servers for every project only"),
    ]);
    expect(errorsOf({ ...stdio(), scope: "project" })).toEqual([]);
  });

  it("refuses URLs that aren't https, or carry a user, a token or a fragment", () => {
    for (const [url, said] of [
      ["http://mcp.example.invalid/x", "must be https"],
      ["ftp://mcp.example.invalid/x", "must be https"],
      ["https://user:pw@mcp.example.invalid/x", "user name or password"],
      ["https://mcp.example.invalid/x?access_token=abc", "credential in its query (access_token)"],
      ["https://mcp.example.invalid/x?k=sk-abcdefghijklmnopqrstuv", "credential in its query (k)"],
      ["https://mcp.example.invalid/x#frag", "#fragment"],
      ["not a url", "isn't a URL"],
    ] as const) {
      expect(errorsOf(remote(url)), url).toEqual([expect.stringContaining(said)]);
    }
  });

  it("refuses secret headers, env vars and arguments, and loader env vars", () => {
    expect(errorsOf(remote("https://mcp.example.invalid/x", { "X-Api-Key": "v" }))[0]).toContain(
      "Header X-Api-Key looks like a credential",
    );
    expect(
      errorsOf(remote("https://mcp.example.invalid/x", { "X-Tenant": "Bearer abcdefghijkl" }))[0],
    ).toContain("Header X-Tenant looks like a credential");
    expect(errorsOf(remote("https://mcp.example.invalid/x", { "X-Tenant": "docs" }))).toEqual([]);
    expect(errorsOf(stdio({ env: { DB_PASSWORD: "hunter2" } }))[0]).toContain("credential");
    expect(errorsOf(stdio({ env: { SERVICE_KEY: "x" } }))[0]).toContain("credential");
    expect(
      errorsOf(stdio({ env: { WORKSPACE: "Zx8Qm2Lp9Vt4Rw7Ky3Nb6Hc1Jd5Fg0Sa" } }))[0],
    ).toContain("Env var WORKSPACE looks like a credential");
    expect(errorsOf(stdio({ env: { LD_PRELOAD: "/tmp/x.so" } }))[0]).toContain(
      "changes which program runs",
    );
    expect(errorsOf(stdio({ env: { PATH: "/tmp" } }))[0]).toContain("changes which program runs");
    expect(errorsOf(stdio({ args: ["--token", "abc"] }))[0]).toContain(
      "(--token) passes a credential",
    );
    expect(errorsOf(stdio({ args: ["--api-key=abc"] }))[0]).toContain("(--api-key) passes");
    expect(
      errorsOf(stdio({ args: [`${"ghp"}_${"abcdefghijklmnopqrstuvwxyz0123"}`] }))[0],
    ).toContain("Argument 1 looks like a credential");
    expect(errorsOf(stdio({ args: ["https://u:p@mcp.example.invalid"] }))[0]).toContain(
      "user name or password",
    );
  });

  it("checks a long run of repeated flag text in linear time", () => {
    // Just under the length limit, which stops anything longer before the flag check.
    const flag = `-${"token".repeat(190)}!`;
    const started = performance.now();
    expect(errorsOf(stdio({ args: [flag, "x"] }))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("refuses a command found relative to each session's folder", () => {
    expect(errorsOf(stdio({ command: "./server.sh" }))[0]).toContain("relative path");
    expect(errorsOf(stdio({ command: "bin/server" }))[0]).toContain("relative path");
    expect(errorsOf(stdio({ command: "/usr/local/bin/server" }))).toEqual([]);
  });

  it("refuses an auth scheme with its credentials, in any case and however short", () => {
    const url = "https://mcp.example.invalid/x";
    for (const value of [
      "Basic dTpw",
      "Bearer abc",
      "bearer abcdefghijklmnopqrstuvwxyz",
      "BEARER x",
      "Digest username=u",
      "Authorization: bearer abc",
    ]) {
      expect(errorsOf(remote(url, { "X-Tenant": value })), value).toEqual([
        expect.stringContaining("Header X-Tenant looks like a credential"),
      ]);
      expect(errorsOf(stdio({ env: { SERVICE_CONFIG: value } })), value).toEqual([
        expect.stringContaining("Env var SERVICE_CONFIG looks like a credential"),
      ]);
    }
    // The words alone, or inside ordinary text, are not credentials.
    for (const value of ["basic", "Bearer", "use basic mode", "tokens: 10"]) {
      expect(errorsOf(stdio({ env: { SERVICE_CONFIG: value } })), value).toEqual([]);
    }
  });

  it("refuses characters that would hide what the card shows", () => {
    expect(errorsOf(stdio({ command: `np${RLO}x` }))[0]).toContain("hidden characters");
    expect(errorsOf(stdio({ args: ["a\nb"] }))[0]).toContain("hidden characters");
    expect(errorsOf(stdio({ env: { MODE: `a${ZWSP}b` } }))[0]).toContain("hidden characters");
  });
});

describe("secretName and secretValue", () => {
  it("know credential names by part, not by any substring", () => {
    for (const name of [
      "API_KEY",
      "GITHUB_TOKEN",
      "X-Auth-Token",
      "Authorization",
      "client_secret",
    ]) {
      expect(secretName(name), name).toBe(true);
    }
    for (const name of ["KEYBOARD_LAYOUT", "PATH_PREFIX", "AUTHOR", "LOG_LEVEL", "X-Tenant"]) {
      expect(secretName(name), name).toBe(false);
    }
  });

  it("know key-shaped values, but not ids, paths or package names", () => {
    for (const value of [
      "sk-abcdefghijklmnopqrstuvwx",
      "0123456789abcdef0123456789abcdef",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
      "Zx8Qm2Lp9Vt4Rw7Ky3Nb6Hc1Jd5Fg0Sa",
    ]) {
      expect(secretValue(value), value).toBe(true);
    }
    for (const value of [
      "123e4567-e89b-12d3-a456-426614174000",
      "/Users/dev/code/docs/node_modules/.bin/server",
      "@example/docs-index-mcp@1.2.3",
      "info",
    ]) {
      expect(secretValue(value), value).toBe(false);
    }
  });
});

describe("mcpServerProposalCard", () => {
  it("shows the command line as a shell would run it, and the host in ASCII", () => {
    expect(commandLineOf("node", ["server.js", "a b", "it's"])).toBe(
      `node server.js 'a b' 'it'\\''s'`,
    );
    const checked = checkMcpServerProposal(remote("https://bücher.example/mcp"));
    if (!checked.ok) throw new Error(checked.errors.join(" "));
    const card = mcpServerProposalCard(checked.proposal, "/work/repo", {});
    expect(card.host).toBe("xn--bcher-kva.example");
    expect(card.url).toBe("https://xn--bcher-kva.example/mcp");
    expect(card.notes).toEqual([
      "If the server asks you to sign in: in Claude Code, run /mcp and choose Authenticate; in Codex, run codex mcp login tracker. Gram never sees the token.",
    ]);
    expect(mcpServerProposalSummary(card)).toBe(
      "Add the MCP server “tracker”, a remote server at xn--bcher-kva.example, in Claude Code and Codex.",
    );
  });

  it("names the file a project server goes in, and what it replaces", () => {
    const checked = checkMcpServerProposal({ ...stdio(), scope: "project", replace: true });
    if (!checked.ok) throw new Error(checked.errors.join(" "));
    const card = mcpServerProposalCard(checked.proposal, "/work/repo/", {
      claude: {
        name: "docs-index",
        transport: "stdio",
        command: "old-server",
        args: ["--x"],
        scope: "project",
        carriesValues: false,
      },
    });
    expect(card.action).toBe("replace");
    expect(card.targets[0]).toMatchObject({
      where: expect.stringContaining("/work/repo/.mcp.json"),
      replaces: { commandLine: "old-server --x", scope: "project" },
    });
    expect(card.notes).toBeUndefined();
  });
});
