import type { ToolAudience } from "@gram/agents";
import {
  AppToolError,
  ORCHESTRATOR_HAS_NO_PR,
  type AppToolDescriptor,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { DecisionQuestion } from "../embedding/decision-hook.ts";

/** What the gate decided about one call, for a handler whose result depends on it. */
export interface AppToolCall {
  /**
   * The user approved this call on a card (`true`), or the gate let it through without one
   * (`false`); absent when the binding has no gate, as a scripted test call has none.
   */
  readonly carded?: boolean | undefined;
}

/**
 * Why a call the workspace's `full` autonomy would otherwise make without a card still asks the
 * user (a merge on a PR Gram couldn't confirm is the worker's own), said to each who reads it.
 */
export interface AskedDespiteAutonomy {
  /** Under the card's text: what full auto covers, why this call isn't covered, what approving does. */
  readonly user: string;
  /** For the calling agent, in its result however the card is answered: the reason and its fix. */
  readonly agent: string;
  /** A few words for the orchestrator's ledger line, ahead of the card's text so they survive a cut. */
  readonly tag: string;
}

/**
 * A tool definition before it's bound to a thread. `T` is what a call acts on: its decoded input,
 * or what `resolve` makes of it.
 */
export interface AppToolDefinition<S extends Schema.Top = Schema.Top, T = S["Type"]> {
  readonly descriptor: AppToolDescriptor;
  /**
   * An object schema with at least one field, even if optional: `Schema.Struct({})` has no object
   * JSON Schema, so neither the Claude nor the HTTP MCP transport can list the tool.
   */
  readonly input: S;
  /** Refuse unknown argument keys instead of dropping them, before target resolution or approval. */
  readonly rejectExcessProperties?: true;
  /**
   * What the call acts on, worked out once from the decoded input before any card is raised, so
   * the card's `describe` and `handle` see the same target: one read after the user answered could
   * name another PR or thread than the card did. A failure fails the call with no card. It reads
   * only. Absent, both get the decoded input.
   */
  resolve?(threadId: ThreadId, input: S["Type"]): Effect.Effect<T, AppToolError>;
  /** Also require `resolve` to succeed in the bound approval query; its errors must refuse, not ask. */
  readonly approvalRequiresResolvedTarget?: true;
  handle(threadId: ThreadId, input: T, call: AppToolCall): Effect.Effect<unknown, AppToolError>;
  /** The approval card's text for a call, e.g. naming the target thread; defaults to the description. */
  describe?(threadId: ThreadId, input: T): Effect.Effect<string>;
  /** The threads the tool is bound for; absent means every thread. */
  readonly audience?: ReadonlyArray<ToolAudience>;
  /**
   * Whether this call needs an approval card, when the class can't say: `false` lets a
   * *crossThread* call through (delegation), `true` raises a card for a class that normally has
   * none. An *outward* tool is never asked (`approvalFor`). `target` is what `resolve` made of the
   * input, the one the card and `handle` see, so a check that must agree with them reads that.
   */
  needsApproval?(threadId: ThreadId, input: S["Type"], target: T): Effect.Effect<boolean>;
  /**
   * The one way an *outward* call goes without its card: the user set
   * the workspace's autonomy to `full`, and the caller is its orchestrator acting on a worker it
   * spawned. A tool that may be delegated like that says so by carrying this check, which answers
   * through `fullAutonomyAllows` in `orchestration/rules.ts` and reads only, since a gate may ask
   * twice. `target` is what `resolve` made of the input, the one `handle` acts on, so the check can
   * hold the delegation to what is acted on and not only to the thread named. It is read for an
   * `outward` tool alone, only `true` lets a call through, and `needsApproval` still never relaxes
   * that class.
   */
  delegatedAtFullAutonomy?(threadId: ThreadId, input: S["Type"], target: T): Effect.Effect<boolean>;
  /**
   * When `delegatedAtFullAutonomy` said no and a card is raised: why, if full autonomy would have
   * covered the call but for something about it. Messaging only; it never changes the verdict.
   */
  whyAsked?(threadId: ThreadId, target: T): Effect.Effect<AskedDespiteAutonomy | undefined>;
  /**
   * Every call raises a card for that call alone, in every mode, for every audience and at every
   * autonomy: `bypassPermissions`, an earlier answer and `delegatedAtFullAutonomy` don't lift it,
   * and `needsApproval` isn't read. For a call that publishes what only the user can vouch for,
   * such as an issue on a shared repo that may carry context from the conversation.
   */
  readonly alwaysAsks?: true;
  /**
   * What a decision hook is asked before this call, where one is configured (`embedding/guard.ts`):
   * the outward action the call is, with what is known of it. Asked after `resolve` and before
   * Gram's own approval, which still applies to a call the hook allows. `undefined` for a call
   * that is no such action (a merge intent dropped, say). Reads nothing.
   */
  decision?(threadId: ThreadId, target: T): Pick<DecisionQuestion, "action" | "detail"> | undefined;
  /**
   * What the card's details show for a call, when what runs isn't the input as sent (an issue as
   * composed and redacted, footer included); the input in the schema's encoding when absent.
   */
  cardDetails?(input: T): Readonly<Record<string, unknown>>;
}

export const defineAppTool = <S extends Schema.Top, T = S["Type"]>(tool: AppToolDefinition<S, T>) =>
  tool as unknown as AppToolDefinition;

/** The tools that act on the calling thread's own PR, which an orchestrator hasn't got. */
export const OWN_PR_AUDIENCE: ReadonlyArray<ToolAudience> = ["plain", "worker"];

/** Refuses `tool` on an orchestrator's thread, which follows no PR of its own. */
export const refuseOrchestratorPr = (tool: string, thread: Pick<Thread, "role">) =>
  thread.role === "orchestrator"
    ? Effect.fail(new AppToolError({ tool, message: ORCHESTRATOR_HAS_NO_PR }))
    : Effect.void;

/** A service failure as the tool's error, keeping its message. */
export const failed =
  (tool: string) =>
  (e: { readonly message: string }): AppToolError =>
    new AppToolError({ tool, message: e.message });
