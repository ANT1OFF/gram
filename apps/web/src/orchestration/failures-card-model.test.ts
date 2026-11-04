import type { ThreadId, WorkspaceId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { failureRow } from "./failures-card-model";
import type { FailureItem } from "./needs-you-model";

const item = (failure: Partial<FailureItem["failure"]>): FailureItem => ({
  kind: "failure",
  key: "k",
  ids: ["k"],
  workspaceId: "w" as WorkspaceId,
  feature: "mail",
  failure: {
    kind: "error",
    threadId: "t" as ThreadId,
    title: "Queue worker",
    project: "api",
    tag: "Turn failed",
    ...failure,
  },
});

describe("failureRow", () => {
  it("names the failing check as the step for red CI", () => {
    const row = failureRow(
      item({ kind: "checks", tag: "#212 checks failing", pr: { repo: "acme/api", number: 212 } }),
      { onGateway: false },
    );
    expect(row).toEqual({
      cause: "Checks failing",
      detail: "In acme/api. No agent is fixing it.",
      step: { kind: "checks", label: "Open failing check" },
    });
  });

  it("sends a spent limit to where the limit is set", () => {
    const spent = item({
      tag: "Spending limit",
      error: { kind: "costGuard", text: "The spending limit was reached." },
    });
    expect(failureRow(spent, { onGateway: true }).step).toEqual({
      kind: "limit",
      label: "View limit",
      to: "/settings/gateways",
    });
    expect(failureRow(spent, { onGateway: false }).step).toMatchObject({ to: "/usage" });
    expect(failureRow(spent, { onGateway: true }).detail).toBe("The spending limit was reached.");
  });

  it("opens the worker to retry a failure that may clear, and only opens it otherwise", () => {
    const limited = item({
      tag: "Rate limited",
      error: { kind: "rateLimit", text: "Rate limited." },
    });
    expect(failureRow(limited, { onGateway: false }).step).toEqual({
      kind: "retry",
      label: "Open to retry",
    });
    // The thread's own error has the last word.
    expect(failureRow(limited, { onGateway: false, retryable: false }).step.kind).toBe("open");
    const unknown = item({ error: { kind: "unknown", text: "" } });
    expect(failureRow(unknown, { onGateway: false, retryable: false })).toMatchObject({
      detail: "The turn stopped.",
      step: { kind: "open", label: "Open worker" },
    });
  });

  it("points a sign-in failure at the gateway or the agent's settings", () => {
    const auth = item({ tag: "Not signed in", error: { kind: "auth", text: "" } });
    expect(failureRow(auth, { onGateway: true }).step).toMatchObject({
      label: "Sign in",
      to: "/settings/gateways",
    });
    expect(failureRow(auth, { onGateway: false }).step).toMatchObject({ to: "/settings/agents" });
  });
});
