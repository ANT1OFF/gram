import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
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

/** Statuses whose responses carry no body, which `Response` refuses one for. */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * `fetch` over Node's own HTTP client, which has no limit on waiting for a response's headers. The
 * endpoint answers a call only once the tool returns, and a tool can wait on an approval card for as
 * long as the user takes, where the global `fetch` gives up after five minutes.
 */
const untimedFetch = (input: string | URL, init?: RequestInit): Promise<Response> =>
  new Promise((resolve, reject) => {
    const target = new URL(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      target,
      {
        method: init?.method ?? "GET",
        headers,
        ...(init?.signal == null ? {} : { signal: init.signal }),
      },
      (response) => {
        const status = response.statusCode ?? 500;
        const replyHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            replyHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        if (NO_BODY.has(status)) response.resume();
        resolve(
          new Response(
            NO_BODY.has(status) ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
            { status, statusText: response.statusMessage ?? "", headers: replyHeaders },
          ),
        );
      },
    );
    request.once("error", reject);
    const body = init?.body;
    if (body === undefined || body === null) request.end();
    else if (typeof body === "string" || body instanceof Uint8Array) request.end(body);
    else {
      request.destroy();
      reject(new Error("The app-tools connection sends only text bodies."));
    }
  });

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
            fetch: untimedFetch,
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
