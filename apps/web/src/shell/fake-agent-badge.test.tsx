// @vitest-environment happy-dom
import type { Diagnostics } from "@gram/contracts";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithApi } from "@/panels/test-utils";

import { FAKE_AGENT_HINT, FakeAgentBadge } from "./fake-agent-badge";

const DIAGNOSTICS: Diagnostics = {
  version: "0.0.0-dev",
  platform: "darwin",
  arch: "arm64",
  versions: {},
  dataDir: "/tmp/gram-state",
  threads: { total: 0, live: 0, working: 0 },
};

afterEach(cleanup);

describe("FakeAgentBadge", () => {
  it("shows while the server runs the fake agent", async () => {
    renderWithApi(<FakeAgentBadge />, {
      diagnostics: async () => ({ ...DIAGNOSTICS, fakeAgent: true }),
    });
    const badge = await screen.findByTestId("fake-agent-badge");
    expect(badge.textContent).toContain("Fake agent");
    expect(badge.getAttribute("aria-label")).toContain(FAKE_AGENT_HINT);
  });

  it("renders nothing with real agents", async () => {
    const diagnostics = vi.fn(async () => DIAGNOSTICS);
    renderWithApi(<FakeAgentBadge />, { diagnostics });
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("fake-agent-badge")).toBeNull();
  });
});
