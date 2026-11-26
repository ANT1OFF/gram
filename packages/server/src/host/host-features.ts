import type { HostFeature } from "@gram/contracts";

/** The features this build's host names in its hello, beside its capabilities. */
export const HOST_FEATURES: ReadonlyArray<HostFeature> = [
  "app-tools-tunnel",
  "account-scope",
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
  "shared-folders",
  "dream-sessions",
  "stop-going",
  "loopback-tunnels",
  "worktree-hooks",
  "repository-check-setup",
];
