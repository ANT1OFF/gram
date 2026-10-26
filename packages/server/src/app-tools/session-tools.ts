import { AppToolError, type ThreadId } from "@gram/contracts";
import { samePath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveFolder } from "../fs/folders.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes.ts";
import { defineAppTool, failed, type AppToolDefinition } from "./definition.ts";

const unknownThread = (tool: string, threadId: ThreadId) =>
  new AppToolError({ tool, message: `unknown thread ${threadId}` });

/** Connector controls and folder grants, driven through the live agent session. */
export const sessionAppTools = (
  runtimes: ThreadRuntimesShape,
  store: ThreadStoreShape,
): ReadonlyArray<AppToolDefinition> => {
  const connectors = (tool: string, threadId: ThreadId) =>
    runtimes.session(threadId).pipe(
      Effect.mapError(() => new AppToolError({ tool, message: "There's no live agent session." })),
      Effect.flatMap((session) =>
        session.connectors === undefined
          ? Effect.fail(
              new AppToolError({ tool, message: "This agent doesn't expose its connectors." }),
            )
          : Effect.succeed(session.connectors),
      ),
    );

  const connectorsStatus = defineAppTool({
    descriptor: {
      name: "connectors_status",
      class: "read",
      description:
        "List this session's MCP connectors and whether each is connected, failed, needs auth, pending or disabled.",
    },
    input: Schema.Struct({ name: Schema.optionalKey(Schema.String) }),
    handle: (threadId, { name }) =>
      connectors("connectors_status", threadId).pipe(
        Effect.flatMap((c) => c.status.pipe(Effect.mapError(failed("connectors_status")))),
        // The agent has the tools themselves already; listing them again only costs context.
        Effect.map((all) => ({
          connectors: (name === undefined ? all : all.filter((c) => c.name === name)).map(
            ({ tools: _tools, ...connector }) => connector,
          ),
        })),
      ),
  });

  const reconnectConnector = defineAppTool({
    descriptor: {
      name: "reconnect_connector",
      class: "self",
      description: "Reconnect one of this session's MCP connectors by name.",
    },
    input: Schema.Struct({ name: Schema.NonEmptyString }),
    handle: (threadId, { name }) =>
      connectors("reconnect_connector", threadId).pipe(
        Effect.flatMap((c) =>
          c.reconnect(name).pipe(Effect.mapError(failed("reconnect_connector"))),
        ),
        Effect.as({ reconnected: name }),
      ),
  });

  const setConnectorEnabled = defineAppTool({
    descriptor: {
      name: "set_connector_enabled",
      class: "self",
      description: "Enable or disable one of this session's MCP connectors by name.",
    },
    input: Schema.Struct({ name: Schema.NonEmptyString, enabled: Schema.Boolean }),
    handle: (threadId, { name, enabled }) =>
      connectors("set_connector_enabled", threadId).pipe(
        Effect.flatMap((c) =>
          c.setEnabled(name, enabled).pipe(Effect.mapError(failed("set_connector_enabled"))),
        ),
        Effect.as({ name, enabled }),
      ),
  });

  const requestDirectory = defineAppTool({
    descriptor: {
      name: "request_directory",
      class: "self",
      description:
        "Ask the user to grant access to a folder outside this thread's checkout. Returns whether it was granted.",
    },
    input: Schema.Struct({
      path: Schema.NonEmptyString,
      reason: Schema.optionalKey(Schema.String),
    }),
    handle: (threadId, { path, reason }) =>
      Effect.gen(function* () {
        const tool = "request_directory";
        const folder = yield* resolveFolder(path).pipe(
          Effect.mapError(
            (e) => new AppToolError({ tool, message: e.message ?? `Folder not found: ${path}` }),
          ),
        );
        const thread = yield* store
          .getThread(threadId)
          .pipe(Effect.mapError(() => unknownThread(tool, threadId)));
        if (thread.additionalDirectories?.some((granted) => samePath(granted, folder)) === true) {
          return { granted: true, path: folder };
        }
        const answer = yield* runtimes
          .requestApproval(threadId, {
            toolName: `mcp__gram__${tool}`,
            displayName: "Grant folder access",
            input: { path: folder, ...(reason === undefined ? {} : { reason }) },
            ...(reason === undefined ? {} : { description: reason }),
            suggestions: [],
            scopes: ["once"],
          })
          .pipe(Effect.mapError(() => unknownThread(tool, threadId)));
        if (answer.decision !== "allow") return { granted: false, path: folder };
        yield* runtimes
          .addDirectories(threadId, [folder])
          .pipe(Effect.mapError(() => unknownThread(tool, threadId)));
        return { granted: true, path: folder };
      }),
  });

  return [connectorsStatus, reconnectConnector, setConnectorEnabled, requestDirectory];
};
