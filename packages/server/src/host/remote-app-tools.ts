import type { McpEndpoint, RemoteAppTools } from "@gram/agents";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { DAY_MS } from "../zone-time.ts";

/** As long as a call may wait: the MCP client's own default gives up after a minute. */
const CALL_TIMEOUT_MS = DAY_MS;

/**
 * A thread's app tools as the server's MCP endpoint serves them, for a session the host opens: the
 * tools it lists now, and each call made to it. The endpoint's bearer token stays in this process;
 * the agent sees an in-process server. The connection closes with the scope.
 */
export const appToolsAt = (
  endpoint: McpEndpoint,
): Effect.Effect<RemoteAppTools, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const next = new Client({ name: "gram-host", version: "1.0.0" });
          const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
            requestInit: { headers: { ...endpoint.headers } },
          });
          // The SDK's optional members don't satisfy `exactOptionalPropertyTypes`.
          await next.connect(transport as Transport);
          return next;
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
      (open) => Effect.promise(() => open.close().catch(() => undefined)),
    );
    const listed = yield* Effect.tryPromise({
      try: () => client.listTools(),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
    return {
      tools: listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        alwaysLoad: tool["_meta"]?.["anthropic/alwaysLoad"] === true,
      })),
      call: async (name, args, signal) =>
        (await client.callTool(
          { name, arguments: (args ?? {}) as Record<string, unknown> },
          undefined,
          // A call can wait on an approval card for as long as the user takes.
          { timeout: CALL_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
        )) as CallToolResult,
    } satisfies RemoteAppTools;
  });
