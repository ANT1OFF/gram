import type { AgentUnavailable } from "@gram/contracts";
import type * as Effect from "effect/Effect";

/** A managed Codex executable a new app-server is about to start from. */
export interface ManagedCodex {
  readonly path: string;
  readonly version: string;
  /**
   * Releases the hold that keeps this version's files in place; called once, when the app-server
   * started from it exits (or fails to start).
   */
  readonly release: () => void;
  /** The app-server answered `initialize`. */
  readonly started: Effect.Effect<void>;
  /**
   * It failed before answering. True when that made the store go back to the previous version,
   * so starting again may work.
   */
  readonly failed: (message: string) => Effect.Effect<boolean>;
}

/**
 * Where new Codex app-servers get their executable. `undefined` from `resolve` means the user's
 * own `codex` on the login-shell PATH; a failure means the user chose Gram's managed
 * runtime and it can't be used, which is never papered over by falling back to PATH.
 */
export interface CodexRuntimeSource {
  readonly resolve: Effect.Effect<ManagedCodex | undefined, AgentUnavailable>;
}
