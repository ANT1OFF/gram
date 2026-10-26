import * as Schema from "effect/Schema";

/**
 * Which `CODEX_HOME` a Codex session lives in: the user's own (`~/.codex`), or Gram's owned
 * homes for native gated (`owned`) and gateway sessions. A session can only be resumed or forked by an app-server on its home.
 */
export const CodexHome = Schema.Literals(["user", "owned", "gateway"]);
export type CodexHome = typeof CodexHome.Type;
