import { MACHINE_LOST_TAG } from "@/thread/saved-work-words";

import type { FailureItem } from "./needs-you-model";

// What the Board's and the orchestrator's failure card says of each failure: its cause in a few
// words, a line of detail, and the one next step it names. No React.

/** The step a failure's row names, by what will move it. */
export type FailureStep =
  /** The PR panel on the failing PR, where its checks are. */
  | { readonly kind: "checks"; readonly label: "Open failing check" }
  /** Where the limit is set: the gateway's settings, or Usage for a subscription. */
  | {
      readonly kind: "limit";
      readonly label: "View limit";
      readonly to: "/settings/gateways" | "/usage";
    }
  /** Where the agent or the gateway signs in. */
  | {
      readonly kind: "signIn";
      readonly label: "Sign in";
      readonly to: "/settings/gateways" | "/settings/agents";
    }
  /**
   * The worker, where its failed turn's Retry is. Retrying from here would send into the worker as
   * the user, which takes it over; the user does that in the worker, seeing what it did.
   */
  | { readonly kind: "retry"; readonly label: "Open to retry" }
  | { readonly kind: "open"; readonly label: "Open worker" | "Open to resume" };

/** A failure's row: cause, detail and step. */
export interface FailureRow {
  readonly cause: string;
  readonly detail: string;
  readonly step: FailureStep;
}

/** What the worker's own thread says of it, beside the ledger's failure. */
export interface FailureThreadFacts {
  /** Its thread runs on a gateway profile. */
  readonly onGateway: boolean;
  /** Its thread's own error says whether the failure may clear; absent where it isn't loaded. */
  readonly retryable?: boolean | undefined;
}

/** Kinds that may clear by themselves, for a worker whose own error isn't loaded. */
const MAY_CLEAR: ReadonlySet<string> = new Set(["rateLimit", "network"]);

/** What a failure's row says and offers. */
export const failureRow = (
  item: FailureItem,
  { onGateway, retryable }: FailureThreadFacts,
): FailureRow => {
  const { failure } = item;
  if (failure.kind === "checks") {
    // Only a thread of the user's own has one (`threadNeedsItems`): a worker's checks are its own
    // to fix, or its orchestrator's. Its PR's attention stands only while its agent is at rest
    // (`attentionOf`), so nothing is at work on them until the user asks it.
    return {
      cause: "Checks failing",
      detail: "Its agent is at rest; ask it to fix them.",
      step: { kind: "checks", label: "Open failing check" },
    };
  }
  const error = failure.error;
  // A lost machine: its worker's thread has Resume worker, which takes no retry.
  if (failure.tag === MACHINE_LOST_TAG)
    return {
      cause: failure.tag,
      detail: error?.text ?? "",
      step: { kind: "open", label: "Open to resume" },
    };
  const detail = error?.text === undefined || error.text === "" ? "The turn stopped." : error.text;
  const cause = failure.tag;
  switch (error?.kind) {
    case "costGuard":
      return {
        cause,
        detail,
        step: {
          kind: "limit",
          label: "View limit",
          to: onGateway ? "/settings/gateways" : "/usage",
        },
      };
    case "auth":
      return {
        cause,
        detail,
        step: {
          kind: "signIn",
          label: "Sign in",
          to: onGateway ? "/settings/gateways" : "/settings/agents",
        },
      };
    default:
      return {
        cause,
        detail,
        step:
          (retryable ?? (error !== undefined && MAY_CLEAR.has(error.kind)))
            ? { kind: "retry", label: "Open to retry" }
            : { kind: "open", label: "Open worker" },
      };
  }
};
