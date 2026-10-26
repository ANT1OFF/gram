import { createSdkMcpServer, query, tool, type Options } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AppTool, AppToolRegistryPort } from "../host.ts";
import { buildAppToolServer } from "./apptools.ts";
import { CLAUDE_AGENT_SDK_VERSION } from "./sdk.ts";

const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("CLAUDE_AGENT_SDK_VERSION", () => {
  it("matches the installed Agent SDK", () => {
    // The package's exports don't include `./package.json`, so resolve the entry point instead.
    const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    expect(readJson(join(dirname(entry), "package.json"))["version"]).toBe(
      CLAUDE_AGENT_SDK_VERSION,
    );
  });

  it("still implements the mcp_authenticate its typings leave out", () => {
    // Without it every MCP sign-in falls back to /mcp in a terminal, quietly; a bump should say so.
    const entry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const source = readFileSync(entry, "utf8");
    expect(source).toContain("async mcpAuthenticate(");
    expect(source).toContain('subtype:"mcp_authenticate"');
  });

  it("matches the pin in package.json", () => {
    const pkg = readJson(fileURLToPath(new URL("../../package.json", import.meta.url)));
    expect((pkg["dependencies"] as Record<string, string>)["@anthropic-ai/claude-agent-sdk"]).toBe(
      CLAUDE_AGENT_SDK_VERSION,
    );
  });
});

describe("the app tool server on the installed SDK", () => {
  it("hands a tool the arguments as sent, a key its schema doesn't name included", async () => {
    const seen: Array<unknown> = [];
    const appTool: AppTool = {
      descriptor: { name: "merge", class: "outward", description: "Merge it." },
      input: Schema.Struct({
        number: Schema.optionalKey(Schema.Int),
      }) as unknown as AppTool["input"],
      run: (input) =>
        Effect.sync(() => {
          seen.push(input);
          return "ok";
        }),
    };
    const registry = { forSession: () => [appTool] } as unknown as AppToolRegistryPort;
    const server = buildAppToolServer("t1" as ThreadId, registry, { tool, createSdkMcpServer })!;
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.config.instance.connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);

    const [listed] = (await client.listTools()).tools;
    expect(listed?.inputSchema.properties).toHaveProperty("number");
    await client.callTool({ name: "merge", arguments: { pr: 13 } });
    await client.callTool({ name: "merge", arguments: { number: 13 } });
    expect(seen).toEqual([{ pr: 13 }, { number: 13 }]);
    // zod still guards the keys the schema does name.
    const wrong = await client.callTool({ name: "merge", arguments: { number: "13" } });
    expect(wrong.isError).toBe(true);
    expect(seen).toHaveLength(2);
    await client.close();
  });
});

/** The `initialize` control request the installed SDK sends a child for these options. */
const initializeRequest = (systemPrompt: Options["systemPrompt"]) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const q = query({
      prompt: "hi",
      options: {
        pathToClaudeCodeExecutable: process.execPath,
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        spawnClaudeCodeProcess: () => {
          const stdin = new PassThrough();
          let buffered = "";
          stdin.setEncoding("utf8").on("data", (data: string) => {
            buffered += data;
            for (const line of buffered.split("\n").slice(0, -1)) {
              const message = JSON.parse(line) as { request?: Record<string, unknown> };
              if (message.request?.["subtype"] === "initialize") {
                resolve(message.request);
                q.close();
              }
            }
            buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
          });
          return Object.assign(new EventEmitter(), {
            stdin,
            stdout: new PassThrough(),
            killed: false,
            exitCode: null,
            kill: () => true,
          });
        },
      },
    });
    // Closing the query rejects the pending read; only the request matters here.
    q.next().catch(() => {});
  });

describe("the system prompt on the installed SDK", () => {
  it("sends an empty custom prompt when the option is omitted, and the CLI's own for the preset", async () => {
    expect((await initializeRequest(undefined))["systemPrompt"]).toEqual([""]);
    const preset = await initializeRequest({
      type: "preset",
      preset: "claude_code",
      append: "Role.",
      snapshot: false,
    });
    expect(preset).not.toHaveProperty("systemPrompt");
    expect(preset).toMatchObject({ appendSystemPrompt: "Role.", systemPromptSnapshot: false });
  });
});
