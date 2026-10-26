import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { appToolResultContent, type AppTool } from "@gram/agents";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { bearerToken, MCP_PATH } from "../http/auth.ts";
import { HttpRouter, HttpServerResponse } from "../platform/unstable.ts";
import { McpTokens } from "./mcp-tokens.ts";
import { AppToolRegistry } from "./registry.ts";

/** An app tool's input as an MCP `inputSchema`; throws unless the schema is an object. */
export const toolInputSchema = (tool: AppTool): Tool["inputSchema"] => {
  const doc = Schema.toJsonSchemaDocument(tool.input);
  if (doc.schema["type"] !== "object") {
    throw new Error(`App tool ${tool.descriptor.name} input must be an object schema`);
  }
  return {
    ...doc.schema,
    ...(Object.keys(doc.definitions).length === 0 ? {} : { $defs: doc.definitions }),
  } as Tool["inputSchema"];
};

const textResult = (text: string, isError = false): CallToolResult =>
  isError
    ? { isError: true, content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }] };

/** Runs the tool (which decodes its own input) and renders the outcome. Fails only on defects. */
export const callAppTool = (tool: AppTool, args: unknown): Effect.Effect<CallToolResult> =>
  tool.run(args).pipe(
    Effect.map((output): CallToolResult => ({ content: appToolResultContent(output) })),
    Effect.catchTag("AppToolError", (error) =>
      Effect.succeed({
        ...textResult(error.message, true),
        ...(error.approvalResolution === undefined
          ? {}
          : {
              structuredContent: {
                tool: error.tool,
                executionStarted: false,
                approvalResolution: error.approvalResolution,
              },
            }),
      }),
    ),
  );

/** A `gram` MCP server whose tools are bound to the thread only when listed or called. */
interface McpCalls {
  start(id: RequestId): AbortController;
  finish(id: RequestId, controller: AbortController): void;
  cancel(id: RequestId): void;
  readonly disconnected: AbortSignal;
  readonly authorization: AbortSignal;
}

export const makeMcpServer = (tools: () => ReadonlyArray<AppTool>, calls?: McpCalls): Server => {
  const server = new Server({ name: "gram", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools().map((tool) => ({
      name: tool.descriptor.name,
      description: tool.descriptor.description,
      inputSchema: toolInputSchema(tool),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const tool = tools().find((t) => t.descriptor.name === request.params.name);
    if (tool === undefined) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
    }
    const controller = calls?.start(extra.requestId);
    const signal =
      controller === undefined || calls === undefined
        ? extra.signal
        : AbortSignal.any([
            extra.signal,
            controller.signal,
            calls.disconnected,
            calls.authorization,
          ]);
    return Effect.runPromise(callAppTool(tool, request.params.arguments ?? {}), { signal }).finally(
      () => {
        if (controller !== undefined) calls?.finish(extra.requestId, controller);
      },
    );
  });
  // Stateless HTTP creates a different SDK Server for the cancellation POST. Route the standard
  // notification to its authenticated thread's active call instead of that new empty server.
  if (calls !== undefined)
    server.setNotificationHandler(CancelledNotificationSchema, (notification) => {
      if (notification.params.requestId !== undefined) calls.cancel(notification.params.requestId);
    });
  return server;
};

const methodNotAllowed = HttpServerResponse.text(
  JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  }),
  { status: 405, contentType: "application/json", headers: { allow: "POST" } },
);

/**
 * `POST /mcp`: the app-tool registry over stateless streamable HTTP, for the thread the bearer token
 * was issued to. Stateless mode offers no standalone SSE stream or session to delete, so GET and
 * DELETE get 405, which clients treat as "not supported".
 */
export const McpRoute = Layer.unwrap(
  Effect.gen(function* () {
    const tokens = yield* McpTokens;
    const registry = yield* AppToolRegistry;
    const running = new Map<AbortSignal, Map<RequestId, AbortController>>();
    return HttpRouter.add("*", MCP_PATH, (request) =>
      Effect.gen(function* () {
        if (request.method !== "POST") return methodNotAllowed;
        const token = bearerToken(request.headers);
        const identity = token === undefined ? undefined : yield* tokens.authorizationFor(token);
        if (identity === undefined) {
          return HttpServerResponse.text("unauthorized: bearer token required", { status: 401 });
        }
        const { threadId, signal: authorization } = identity;
        // Asked per request: a thread's role can change while its agent keeps the same token.
        const audience = yield* registry.audienceOf(threadId);
        const disconnected = new AbortController();
        const response = NodeHttpServerRequest.toServerResponse(request);
        const onClose = () => {
          if (!response.writableEnded) disconnected.abort();
        };
        response.once("close", onClose);
        const server = makeMcpServer(() => registry.forTransport(threadId, audience), {
          disconnected: disconnected.signal,
          authorization,
          start: (id) => {
            if (authorization.aborted)
              throw new McpError(ErrorCode.InvalidRequest, "Authorization revoked.");
            const active = running.get(authorization) ?? new Map<RequestId, AbortController>();
            if (active.has(id))
              throw new McpError(ErrorCode.InvalidRequest, "Duplicate active request id.");
            const controller = new AbortController();
            active.set(id, controller);
            running.set(authorization, active);
            return controller;
          },
          finish: (id, controller) => {
            const active = running.get(authorization);
            if (active?.get(id) !== controller) return;
            active.delete(id);
            if (active.size === 0) running.delete(authorization);
          },
          cancel: (id) => running.get(authorization)?.get(id)?.abort(),
        });
        // No `sessionIdGenerator`: stateless, so each request needs its own transport.
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        yield* Effect.acquireUseRelease(
          // The SDK's optional members don't satisfy `exactOptionalPropertyTypes`.
          Effect.promise(() => server.connect(transport as Transport)),
          () =>
            Effect.promise(() =>
              transport.handleRequest(NodeHttpServerRequest.toIncomingMessage(request), response),
            ),
          () =>
            Effect.promise(async () => {
              response.off("close", onClose);
              await server.close();
            }),
        );
        // The transport has ended the Node response; NodeHttpServer skips writing once it has.
        return HttpServerResponse.empty();
      }),
    );
  }),
);
