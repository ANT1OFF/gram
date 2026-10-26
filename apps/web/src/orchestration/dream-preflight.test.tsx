// @vitest-environment happy-dom
import {
  DEFAULT_SETTINGS,
  type ModelRef,
  type ProjectId,
  type SelectedHarnessSupport,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { DreamsSection } from "./dreams-section";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
});

const workspace: WorkspaceState = {
  workspace: {
    id: "synthetic-workspace" as WorkspaceId,
    name: "Synthetic",
    projectIds: ["synthetic-project" as ProjectId],
    homeProjectId: "synthetic-project" as ProjectId,
    createdAt: 1,
  },
  charter: { maxConcurrentWorkers: 1 },
};
const setup = (model: ModelRef, observation: () => Partial<SelectedHarnessSupport>) => {
  const api = createMockApi({ speed: 0, persist: false, autoplay: false });
  vi.spyOn(api, "listDreams").mockResolvedValue([]);
  vi.spyOn(api, "agentSupport").mockImplementation(async (selected) => ({
    model: selected,
    checkedAt: 1,
    availability: { state: "available" },
    support: { dream: { state: "supported", evidence: "Synthetic qualified transport" } },
    ...observation(),
  }));
  const preview = vi.spyOn(api, "previewDream").mockResolvedValue({
    sources: [],
    notes: [],
    worktreesCovered: 0,
    worktreesTotal: 0,
    closedThreadsKept: 0,
  });
  const start = vi
    .spyOn(api, "startDream")
    .mockRejectedValue(new Error("Synthetic start boundary"));
  useServerSettings.setState({
    settings: { ...DEFAULT_SETTINGS, agents: { ...DEFAULT_SETTINGS.agents, defaultModel: model } },
  });
  renderWithApi(
    <DreamsSection
      state={workspace}
      reviewing={undefined}
      starting="dream"
      onStartingChange={vi.fn()}
    />,
    api,
  );
  return { api, preview, start };
};

describe("Dream selected-harness preflight", () => {
  it.each(["claude", "codex"] as const)(
    "submits explicitly selected per-run auto on the same %s harness without another confirmation",
    async (agent) => {
      const model: ModelRef = { agent, model: "synthetic-selected-model" };
      const { start } = setup(model, () => ({}));
      const review = screen.getByRole("radio", { name: /Review ·/ }) as HTMLInputElement;
      expect(review.checked).toBe(true);
      expect(screen.getByText("Adoption mode · this run only")).toBeDefined();
      fireEvent.click(screen.getByRole("radio", { name: /Auto ·/ }));
      expect(screen.getByText(/without another review or approval/)).toBeDefined();
      await waitFor(() =>
        expect(
          (screen.getByRole("button", { name: "Start dream" }) as HTMLButtonElement).disabled,
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole("button", { name: "Start dream" }));
      await screen.findByText("Synthetic start boundary");
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith(
        workspace.workspace.id,
        expect.objectContaining({ model, mode: "auto" }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
    },
  );
  it("does not gather inputs or start for an unqualified installed Codex version", async () => {
    const { preview, start } = setup({ agent: "codex", model: "synthetic-model" }, () => ({
      support: {
        dream: {
          state: "unknown",
          reason: "Synthetic CLI version is unqualified. Update and retry.",
        },
      },
    }));
    await screen.findByText("Unverified: Synthetic CLI version is unqualified. Update and retry.");
    expect(
      (screen.getByRole("button", { name: "Start dream" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Start dream" }));
    expect(preview).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("describes guided permissions and explicitly submits the shown Codex model after sign-in retry", async () => {
    let signedOut = true;
    const model: ModelRef = { agent: "codex", model: "synthetic-model" };
    const { preview, start } = setup(model, () => ({
      availability: signedOut
        ? { state: "signedOut", reason: "Sign in with codex login, then retry." }
        : { state: "available" },
      dreamMode: "guided",
      dreamReason:
        "Synthetic normal Codex permissions apply. Review the candidate and explicitly Adopt.",
    }));
    await screen.findByText("Sign in with codex login, then retry.");
    await screen.findByText(
      "Synthetic normal Codex permissions apply. Review the candidate and explicitly Adopt.",
    );
    expect(preview).not.toHaveBeenCalled();
    signedOut = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry check" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start dream" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(preview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Start dream" }));
    await screen.findByText("Synthetic start boundary");
    expect(start).toHaveBeenCalledWith(
      workspace.workspace.id,
      expect.objectContaining({ model, mode: "review" }),
    );
  });

  it("shows the selected unsupported default and never silently switches to Claude", async () => {
    const { api, preview, start } = setup({ agent: "grok", model: "synthetic-grok" }, () => ({
      support: {
        dream: {
          state: "unsupported",
          reason: "Synthetic selected harness has no Dream mode.",
          evidence: "Synthetic transport",
        },
      },
    }));
    await screen.findByText("Synthetic selected harness has no Dream mode.");
    expect(screen.getByText(/^Your default:.*synthetic-grok$/)).toBeDefined();
    expect(vi.mocked(api.agentSupport).mock.calls.every(([model]) => model.agent === "grok")).toBe(
      true,
    );
    expect(preview).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
