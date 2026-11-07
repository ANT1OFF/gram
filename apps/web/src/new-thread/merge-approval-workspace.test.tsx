// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type ProjectId, type WorkspaceState } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useUndoToasts } from "@/stores/undo-toasts";

import { useWorkspaceMergeApproval } from "./merge-approval";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
  useUndoToasts.setState({ toasts: [] });
  vi.restoreAllMocks();
});

/** The New form's use of the hook, with the draft's workspace switchable as its picker does. */
function Harness({ a, b }: { a: WorkspaceState; b: WorkspaceState }) {
  const [shown, setShown] = useState(a);
  const approval = useWorkspaceMergeApproval(shown, "full");
  return (
    <div>
      <span data-testid="approval">{approval.approval}</span>
      <button type="button" onClick={() => approval.pick("automatic")}>
        Pick Automatic
      </button>
      <button type="button" onClick={() => setShown(a)}>
        Show A
      </button>
      <button type="button" onClick={() => setShown(b)}>
        Show B
      </button>
      {approval.below}
    </div>
  );
}

/** Two synthetic workspaces that both ask before merging (Publish). */
const mount = async () => {
  const api = createMockApi({ speed: 0, autoplay: false });
  useServerSettings.setState({ settings: DEFAULT_SETTINGS });
  const make = async (name: string, project: string) => {
    const made = await api.saveWorkspace({
      name,
      projectIds: [project as ProjectId],
      homeProjectId: project as ProjectId,
    });
    await api.setOrchestratorCharter(made.workspace.id, { ...made.charter, autonomy: "publish" });
    return (await api.listWorkspaces()).find((each) => each.workspace.id === made.workspace.id)!;
  };
  const a = await make("alpha", "p-web");
  const b = await make("beta", "p-api");
  const setCharter = vi.spyOn(api, "setOrchestratorCharter");
  renderWithApi(<Harness a={a} b={b} />, api);
  return { setCharter };
};

describe("merge approval across workspaces", () => {
  it("drops a confirm opened for one workspace when the draft moves to another", async () => {
    const { setCharter } = await mount();
    expect(screen.getByTestId("approval").textContent).toBe("ask");
    fireEvent.click(screen.getByRole("button", { name: "Pick Automatic" }));
    expect(screen.getByTestId("merge-approval-confirm").textContent).toContain("alpha");

    // Moved to beta: alpha's confirm is gone, so it can't turn on Full for beta.
    fireEvent.click(screen.getByRole("button", { name: "Show B" }));
    expect(screen.queryByTestId("merge-approval-confirm")).toBeNull();
    // Nor does it come back with alpha.
    fireEvent.click(screen.getByRole("button", { name: "Show A" }));
    expect(screen.queryByTestId("merge-approval-confirm")).toBeNull();
    expect(setCharter).not.toHaveBeenCalled();

    // A confirm opened for alpha, while alpha is shown, still saves alpha.
    fireEvent.click(screen.getByRole("button", { name: "Pick Automatic" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Merge automatically" }));
    });
    await waitFor(() => expect(setCharter).toHaveBeenCalledTimes(1));
    expect(setCharter.mock.calls[0]![1].autonomy).toBe("full");
    await waitFor(() =>
      expect(useUndoToasts.getState().toasts.map((toast) => toast.title)).toEqual([
        "Workspace alpha now merges without asking",
      ]),
    );
  });

  it("drops a save's error when the draft moves to another workspace", async () => {
    const { setCharter } = await mount();
    setCharter.mockRejectedValueOnce(new Error("Synthetic save refused"));
    fireEvent.click(screen.getByRole("button", { name: "Pick Automatic" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Merge automatically" }));
    });
    expect((await screen.findByRole("alert")).textContent).toContain("Synthetic save refused");
    fireEvent.click(screen.getByRole("button", { name: "Show B" }));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show A" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
