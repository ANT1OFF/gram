import type {
  createSdkMcpServer,
  McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as z from "zod";
import { appToolAnnotations, appToolResultContent } from "../app-tools.ts";
import type { AppTool, AppToolRegistryPort, RemoteAppTools, ToolAudience } from "../host.ts";
import * as Predicate from "effect/Predicate";

export const APP_TOOL_SERVER = "gram";

/** M1 core tools are always loaded; the rest are deferred behind ToolSearch. */
export const CORE_APP_TOOLS: ReadonlySet<string> = new Set([
  "set_title",
  "set_plan",
  "wrap_up",
  "mark_chapter",
  "spawn_task",
  "dismiss_task",
  "mark_completed",
  "set_unread",
  "notify_user",
  "wait_on_user",
  "resolve_wait",
]);

/**
 * Tools only the main agent may call. Their effect belongs to the turn as the user sees it, and the
 * registry can't tell who called: a subagent's `wrap_up` would land on the main reply as the turn's
 * box, or ask the user a question the main agent never saw.
 */
export const MAIN_AGENT_APP_TOOLS: ReadonlySet<string> = new Set(["wrap_up"]);

/** The name Claude sees, e.g. `mcp__gram__set_title`. */
export const appToolName = (name: string): string => `mcp__${APP_TOOL_SERVER}__${name}`;

export interface McpServerFactory {
  readonly tool: typeof tool;
  readonly createSdkMcpServer: typeof createSdkMcpServer;
}

/**
 * Effect Schema → JSON Schema 2020-12 (`Schema.toJsonSchemaDocument`) → zod 4 (`z.fromJSONSchema`,
 * which resolves `$defs`), so the schema must be an object. zod only guards the MCP boundary; the
 * tool's `run` decodes the arguments as sent with the Effect schema, so brands and transformations
 * still apply. Loose, so a key the schema doesn't name reaches `run` too, which refuses one on an
 * outward tool rather than act on a default.
 */
export const toZodObject = (schema: Schema.Codec<unknown, unknown>): z.ZodObject => {
  const doc = Schema.toJsonSchemaDocument(schema);
  const zod = z.fromJSONSchema({
    ...doc.schema,
    $defs: doc.definitions,
  });
  if (!(zod instanceof z.ZodObject)) {
    throw new Error(`App tool input must be an object schema, got ${zod.def.type}`);
  }
  return zod.loose();
};

const textResult = (text: string, isError = false): CallToolResult =>
  isError
    ? { isError: true, content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }] };

const runAppTool = (appTool: AppTool, args: unknown): Effect.Effect<CallToolResult> =>
  appTool.run(args).pipe(
    Effect.map((output): CallToolResult => ({ content: appToolResultContent(output) })),
    Effect.catchTag("AppToolError", (error) => Effect.succeed(textResult(error.message, true))),
  );

export interface AppToolServer {
  readonly config: McpSdkServerConfigWithInstance;
  /**
   * The tools' full MCP names. The session lets these through its own permission layer: each
   * tool's `run` carries the registry's approval gate (`AppToolRegistryPort.forSession`).
   */
  readonly names: ReadonlySet<string>;
}

const signalOf = (extra: unknown): AbortSignal | undefined => {
  const signal = Predicate.isObject(extra) ? extra["signal"] : undefined;
  return signal instanceof AbortSignal ? signal : undefined;
};

/**
 * The `gram` MCP server for one thread, or `undefined` if the registry offers no tools.
 * `audience` is the thread's role, which decides the tools the registry binds for it.
 */
export const buildAppToolServer = (
  threadId: ThreadId,
  registry: AppToolRegistryPort,
  sdk: McpServerFactory,
  audience?: ToolAudience,
): AppToolServer | undefined => {
  const tools = registry.forSession(threadId, audience);
  if (tools.length === 0) return undefined;
  const config = sdk.createSdkMcpServer({
    name: APP_TOOL_SERVER,
    version: "1.0.0",
    tools: tools.map((appTool) =>
      sdk.tool(
        appTool.descriptor.name,
        appTool.descriptor.description,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the Agent SDK's tool() takes a whole Zod object at run time; its types name only a raw shape
        toZodObject(appTool.input) as unknown as z.ZodRawShape,
        (args, extra) => {
          const signal = signalOf(extra);
          return Effect.runPromise(
            runAppTool(appTool, args),
            signal === undefined ? undefined : { signal },
          );
        },
        {
          alwaysLoad: CORE_APP_TOOLS.has(appTool.descriptor.name),
          annotations: appToolAnnotations(appTool.descriptor.class),
        },
      ),
    ),
  });
  return { config, names: new Set(tools.map((t) => appToolName(t.descriptor.name))) };
};

/**
 * The `gram` MCP server for a session whose tools are served elsewhere (`RemoteAppTools`): the
 * same in-process server, so Claude Code treats it as it does the registry's, with each call
 * handed to `remote`. `undefined` if it lists no tools.
 */
export const buildRemoteAppToolServer = (
  remote: RemoteAppTools,
  sdk: McpServerFactory,
): AppToolServer | undefined => {
  if (remote.tools.length === 0) return undefined;
  const config = sdk.createSdkMcpServer({
    name: APP_TOOL_SERVER,
    version: "1.0.0",
    tools: remote.tools.map((listed) => {
      const zod = z.fromJSONSchema(listed.inputSchema);
      if (!(zod instanceof z.ZodObject)) {
        throw new Error(`App tool input must be an object schema, got ${zod.def.type}`);
      }
      return sdk.tool(
        listed.name,
        listed.description,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the Agent SDK's tool() takes a whole Zod object at run time; its types name only a raw shape
        zod.loose() as unknown as z.ZodRawShape,
        (args, extra) =>
          remote
            .call(listed.name, args, signalOf(extra))
            .catch((error: unknown) =>
              textResult(error instanceof Error ? error.message : String(error), true),
            ),
        {
          alwaysLoad: listed.alwaysLoad,
          ...(listed.annotations === undefined ? {} : { annotations: listed.annotations }),
        },
      );
    }),
  });
  return { config, names: new Set(remote.tools.map((t) => appToolName(t.name))) };
};
