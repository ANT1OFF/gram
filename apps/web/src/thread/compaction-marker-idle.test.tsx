// @vitest-environment happy-dom
import type { CompactionData, WorkspaceId } from "@gram/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { CompactionMarker, compactionLabel, idleCompactRequestText } from "./compaction-marker";

afterEach(cleanup);

const intl = { locale: "en-GB", timeZone: "UTC" };
const at = Date.UTC(2026, 9, 20, 14, 32);
const idle = (outcome: NonNullable<CompactionData["outcome"]>): CompactionData => ({
  trigger: "manual",
  reason: "idle",
  outcome,
  at,
  ...(outcome === "completed" ? { preTokens: 403_004, postTokens: 30_000 } : {}),
  workspaceId: "w-1" as WorkspaceId,
});

const inRouter = (node: React.ReactNode) => {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ["/t/x"] }),
  });
  return <RouterProvider router={router} />;
};

describe("idle compaction marker", () => {
  it("says why and how it ended, in 24-hour time", () => {
    expect(compactionLabel(idle("completed"), at, intl)).toBe(
      "Context compacted · idle, before cache expiry · 14:32 · 403K → 30K tokens",
    );
    expect(compactionLabel(idle("failed"), at, intl)).toBe("Idle compaction failed · 14:32");
    expect(compactionLabel(idle("unknown"), at, intl)).toBe(
      "Idle compaction · outcome unknown · 14:32",
    );
    // The agent's own compactions read as before.
    expect(compactionLabel({ trigger: "auto", at }, at, intl)).toBe("Context compacted · 14:32");
  });

  it("links to the workspace's setting, and claims no summary for one that didn't complete", async () => {
    render(inRouter(<CompactionMarker compaction={idle("failed")} />));
    await userEvent.click(await screen.findByRole("button", { name: /Idle compaction failed/ }));
    const details = screen.getByTestId("compaction-details");
    expect(details.textContent).toContain("Idle compaction · Failed");
    expect(details.textContent).not.toContain("Summary not provided");
    expect(screen.getByTestId("compaction-setting").getAttribute("href")).toBe(
      "/settings/workspaces/w-1#idle-compact",
    );
  });

  it("names the request Gram sent in place of a user bubble", () => {
    expect(idleCompactRequestText({ kind: "idleCompact", contextTokens: 403_004 })).toBe(
      "Gram asked the agent to compact this idle thread before its cache expires · 403K tokens",
    );
  });
});
