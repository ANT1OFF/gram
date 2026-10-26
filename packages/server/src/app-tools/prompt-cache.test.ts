import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { makeMcpServer, toolInputSchema } from "./http-mcp.ts";
import { bindAppTools, defineAppTool } from "./registry.ts";

const threadId = "synthetic-cache-thread" as ThreadId;
const definitions = () =>
  ["zeta", "alpha"].map((name) =>
    defineAppTool({
      descriptor: {
        name,
        class: name === "zeta" ? "outward" : "self",
        description: "Synthetic cache fixture",
      },
      input: Schema.Struct({ text: Schema.String }),
      handle: (thread, { text }) => Effect.succeed({ thread, name, text }),
    }),
  );

describe("app tool prompt prefix", () => {
  it("keeps definitions identical across registration schedules without mutating the registry", () => {
    const first = definitions();
    const second = first.toReversed();
    const serialized = (input: typeof first) =>
      JSON.stringify(
        bindAppTools(input, threadId).map((tool) => ({
          ...tool.descriptor,
          inputSchema: toolInputSchema(tool),
        })),
      );
    expect(serialized(first)).toBe(serialized(second));
    expect(first.map((tool) => tool.descriptor.name)).toEqual(["zeta", "alpha"]);
    expect(second.map((tool) => tool.descriptor.name)).toEqual(["alpha", "zeta"]);
    expect(bindAppTools(first, threadId).map((tool) => tool.descriptor.name)).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("preserves a synthetic warm prefix on MCP re-listing and still gates outward calls", async () => {
    // No provider, CLI, auth lookup or tokenizer. Counts are an explicit cache oracle,
    // illustrating full-prefix exposure, not a measurement of provider token savings.
    const fixture = {
      provider: "claude",
      auth: "synthetic-no-auth",
      cli: "fixture",
      tokens: 120_000,
    };
    const source = definitions();
    const approved: string[] = [];
    const gate = {
      approve: (_thread: ThreadId, tool: { name: string }) =>
        Effect.sync(() => void approved.push(tool.name)),
    };
    let offered = bindAppTools(source, threadId, gate);
    const server = makeMcpServer(() => offered);
    const client = new Client({ name: "synthetic-prefix-audit", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const before = JSON.stringify((await client.listTools()).tools);
      offered = bindAppTools(source.toReversed(), threadId, gate);
      const after = JSON.stringify((await client.listTools()).tools);
      const usage = {
        cache_read_input_tokens: before === after ? fixture.tokens : 0,
        cache_creation_input_tokens: before === after ? 0 : fixture.tokens,
      };
      expect(usage).toEqual({
        cache_read_input_tokens: 120_000,
        cache_creation_input_tokens: 0,
      });
      expect(after).toBe(before);
      expect(JSON.parse(after).map((tool: { name: string }) => tool.name)).toEqual([
        "alpha",
        "zeta",
      ]);
      for (const name of ["alpha", "zeta"]) {
        const result = await client.callTool({ name, arguments: { text: "invented input" } });
        expect(result.content).toEqual([
          {
            type: "text",
            text: JSON.stringify({ thread: threadId, name, text: "invented input" }),
          },
        ]);
      }
      expect(approved).toEqual(["zeta"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
