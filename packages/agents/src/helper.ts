import type { AgentModel, ReasoningVariant } from "@gram/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A safe, content-free failure classification; never carries a CLI body or transcript. */
export class HelperTransportError extends Schema.TaggedError<HelperTransportError>()(
  "HelperTransportError",
  {
    detail: Schema.optional(Schema.String),
    failure: Schema.Literals([
      "auth",
      "unavailable",
      "restriction",
      "rateLimited",
      "server",
      "malformed",
    ]),
  },
) {}

export interface HelperCall {
  readonly model: string;
  /** Helpers always use Standard; a future Codex adapter must send serviceTier: "default". */
  readonly speed: "standard";
  readonly effort?: ReasoningVariant | undefined;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  /** Re-read current authorization after startup and enqueue synchronously inside that check. */
  readonly authorize: (enqueue: () => void) => Effect.Effect<void, HelperTransportError>;
}

export interface HelperReply {
  readonly text: string;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
}

/**
 * Optional one-shot helper boundary, independent of ordinary visible agent sessions. Claude is
 * tool-free; guided Codex disables environment access but may retain other CLI tools/context.
 * Both use Standard speed, isolate protocol/history, retain their own CLI login,
 * and close every process on cancellation. A host without verified controls leaves this absent.
 */
export interface HelperAdapter {
  /** Guided Codex can retain CLI host context and non-environment native tools. */
  readonly mode?: "tool-free" | "guided";
  readonly models: Effect.Effect<ReadonlyArray<AgentModel>, HelperTransportError>;
  readonly generate: (call: HelperCall) => Effect.Effect<HelperReply, HelperTransportError>;
}

export const CODEX_HELPER_RESTRICTION =
  "This Codex adapter has no guided subscription helper transport. Select a qualified Codex 0.162.1 runtime and refresh. Ordinary Codex chats still work.";
