import { MACHINE_LOST_TAG } from "@/thread/saved-work-words";

import type { FailureItem } from "./needs-you-model";

/** The step a failure's row names, by what will move it. */
export type FailureStep =
  | { readonly kind: "checks"; readonly label: "Open failing check" }
  | {
      readonly kind: "limit";
      readonly label: "View limit";
      readonly to: "/settings/gateways" | "/usage";
    }
  | {
      readonly kind: "signIn";
      readonly label: "Sign in";
      readonly to: "/settings/gateways" | "/settings/agents";
    }
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

const MAY_CLEAR: ReadonlySet<string> = new Set(["rateLimit", "network"]);

/** What a failure's row says and offers. */
export const failureRow = (
  item: FailureItem,
  { onGateway, retryable }: FailureThreadFacts,
): FailureRow => {
  const { failure } = item;
  if (failure.kind === "checks") {
    return {
      cause: "Checks failing",
      detail: "Its agent is at rest; ask it to fix them.",
      step: { kind: "checks", label: "Open failing check" },
    };
  }
  const error = failure.error;
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
