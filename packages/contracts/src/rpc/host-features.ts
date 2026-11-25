import * as Schema from "effect/Schema";

/**
 * What a host can do beyond its capabilities, named in its hello's `features`. Every one is
 * optional: a control plane uses it only on a host that names it, and a host without it loses only
 * that. On the wire these are plain strings, so a control plane reads a hello naming one it
 * doesn't know yet, and ignores it.
 */
export const HostFeature = Schema.Literals([
  "thread-places",
  "browser-policy",
  "session-retarget",
  "file-parts",
  "file-parts-contained",
  "wip-restore",
  "wip-restore-ref",
  "wip-restore-pending",
  "wip-restore-kept",
  "wip-keep",
  "agent-opencode",
  "agent-codex",
  "agent-opencode-sessions",
  "agent-grok",
  "agent-antigravity",
  "account-scope",
  "shared-folders",
  "dream-sessions",
  "stop-going",
  "app-tools-tunnel",
  "loopback-tunnels",
  "worktree-hooks",
]);
export type HostFeature = typeof HostFeature.Type;
