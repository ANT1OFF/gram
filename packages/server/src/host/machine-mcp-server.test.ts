import { describe, expect, it } from "vitest";
import { machineMcpServerFrom } from "./machine-mcp-server.ts";

const named = (value: unknown) => machineMcpServerFrom(JSON.stringify(value));

describe("a machine's own MCP server, from its host's environment", () => {
  it("is a named https server, or plain http on loopback", () => {
    expect(named({ name: "tools", url: "https://mcp.example.test/mcp" }).server).toEqual({
      name: "tools",
      url: "https://mcp.example.test/mcp",
    });
    expect(named({ name: "tools", url: "http://127.0.0.1:3129/w/mcp" }).server?.url).toBe(
      "http://127.0.0.1:3129/w/mcp",
    );
  });

  it("is none, with no error, when unset", () => {
    expect(machineMcpServerFrom(undefined)).toEqual({ server: undefined });
    expect(machineMcpServerFrom("  ")).toEqual({ server: undefined });
  });

  it("is refused for plain http off loopback, a credential in the url, or a name a config can't take", () => {
    for (const value of [
      { name: "tools", url: "http://mcp.example.test/mcp" },
      { name: "tools", url: "https://user:secret@mcp.example.test/mcp" },
      { name: "tools", url: "file:///etc/passwd" },
      { name: 'a"b', url: "https://mcp.example.test/mcp" },
      { name: "", url: "https://mcp.example.test/mcp" },
      { url: "https://mcp.example.test/mcp" },
    ]) {
      const read = named(value);
      expect(read.server).toBeUndefined();
      expect(read.error).toBeDefined();
    }
    expect(machineMcpServerFrom("{not json").error).toBeDefined();
  });
});
