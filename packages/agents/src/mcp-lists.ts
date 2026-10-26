/**
 * How a session's MCP lists (`OpenSessionOptions.mcpAllowlist` and `mcpDenylist`) read for a
 * harness that has to apply them server by server: Claude Code takes the lists themselves, Codex
 * a switch per server they have configured.
 */
import { connectorListed, type ConnectorIdentity } from "@gram/contracts";
import type { OpenSessionOptions } from "./host.ts";

/** The lists a session was opened with. */
export type McpLists = Pick<OpenSessionOptions, "mcpAllowlist" | "mcpDenylist">;

/** Whether `o` narrows the session's servers at all. */
export const narrowsMcp = (o: McpLists): boolean =>
  o.mcpAllowlist !== undefined || (o.mcpDenylist ?? []).length > 0;

/** Whether a session opened with `o`'s lists leaves `server` out; a denylist entry wins. */
export const listsLeaveOut = (o: McpLists, server: ConnectorIdentity): boolean =>
  (o.mcpAllowlist !== undefined && !connectorListed(o.mcpAllowlist, server)) ||
  (o.mcpDenylist !== undefined && connectorListed(o.mcpDenylist, server));

/** The lists as `AgentConnectors` reports them, so a view can say a server was left out. */
export const reportedLists = (
  o: McpLists,
): { readonly allowlist?: ReadonlyArray<string>; readonly denylist?: ReadonlyArray<string> } => ({
  ...(o.mcpAllowlist === undefined ? {} : { allowlist: o.mcpAllowlist }),
  ...(o.mcpDenylist === undefined || o.mcpDenylist.length === 0 ? {} : { denylist: o.mcpDenylist }),
});
