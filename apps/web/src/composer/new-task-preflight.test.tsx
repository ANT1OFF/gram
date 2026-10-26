// @vitest-environment happy-dom
import {
  DEFAULT_SETTINGS,
  type ProjectId,
  type SelectedHarnessSupport,
  type TaskModelSelection,
} from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api/mock";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";
import { useTaskDraftStore } from "@/orchestration/task-draft-store";
import { NewTaskDraft } from "./new-task-draft";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));
afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
  useTaskDraftStore.setState({ last: undefined, autonomy: undefined, ways: {} });
});
const projectId = "synthetic-project" as ProjectId;
function EntryFixture({ initialWay }: { initialWay?: "direct" | undefined }) {
  const [entry, setEntry] = useState(initialWay);
  return (
    <>
      <button onClick={() => setEntry(undefined)}>Generic entry</button>
      <button onClick={() => setEntry("direct")}>Worker entry</button>
      <NewTaskDraft initialWay={entry} />
    </>
  );
}
const setup = (
  selection: () => Promise<TaskModelSelection>,
  observation: (agent: string) => Partial<SelectedHarnessSupport> = () => ({}),
  initialWay?: "direct",
) => {
  const api = createMockApi({ speed: 0, autoplay: false, persist: false });
  vi.spyOn(api, "listWorkspaces").mockResolvedValue([]);
  vi.spyOn(api, "listProjects").mockResolvedValue([
    { id: projectId, name: "Synthetic", root: "/synthetic/repo", bookmarked: true },
  ]);
  vi.spyOn(api, "listModels").mockResolvedValue({
    models: [{ id: "synthetic-model", displayName: "Synthetic", supportsEffort: false }],
  });
  const preview = vi.spyOn(api, "taskPreflight").mockImplementation(selection);
  const start = vi.spyOn(api, "startTask").mockRejectedValue(new Error("Synthetic start boundary"));
  vi.spyOn(api, "agentSupport").mockImplementation(async (model) => ({
    model,
    checkedAt: 1,
    support: {
      orchestrator: { state: "supported", evidence: "Synthetic task policy" },
      worker: { state: "supported", evidence: "Synthetic task policy" },
    },
    availability: { state: "available" },
    ...observation(model.agent),
  }));
  useServerSettings.setState({ settings: DEFAULT_SETTINGS });
  useTaskDraftStore.setState({ last: undefined, autonomy: undefined, ways: {} });
  renderWithApi(<EntryFixture initialWay={initialWay} />, api);
  return { api, preview, start };
};

describe("new-task authoritative preflight", () => {
  it("shows server-selected Codex for an unset default and pins exactly that selection on submit", async () => {
    const selection: TaskModelSelection = {
      orchestrator: { agent: "codex", model: "synthetic-model" },
    };
    const { start } = setup(async () => selection);
    await screen.findByText("Orchestrator: Codex · synthetic-model");
    fireEvent.change(screen.getByLabelText("What needs doing"), {
      target: { value: "Synthetic task" },
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /Start workspace and send/ }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.submit(screen.getByRole("form", { name: "New task" }));
    await screen.findByText("Synthetic start boundary");
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ selection, target: { projectId } }),
    );
  });

  it("blocks all submit paths for a precise server refusal and recovers on explicit retry", async () => {
    let refused = true;
    const { start } = setup(async () => {
      if (refused) throw new Error("Synthetic unavailable selected worker; choose explicitly.");
      return { orchestrator: { agent: "codex", model: "synthetic-model" } };
    });
    await screen.findByText(/Synthetic unavailable selected worker/);
    fireEvent.change(screen.getByLabelText("What needs doing"), {
      target: { value: "Synthetic task" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "New task" }));
    expect(start).not.toHaveBeenCalled();
    refused = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry task check" }));
    await screen.findByText("Orchestrator: Codex · synthetic-model");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /Start workspace and send/ }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });

  it("checks and shows the actual direct worker separately from its orchestrator", async () => {
    const selection: TaskModelSelection = {
      orchestrator: { agent: "claude", model: "synthetic-model" },
      worker: { agent: "codex", model: "synthetic-model" },
    };
    const { start } = setup(
      async () => selection,
      (agent) =>
        agent === "codex"
          ? { availability: { state: "signedOut", reason: "Synthetic worker needs codex login." } }
          : {},
    );
    fireEvent.click(await screen.findByText("Straight to a worker"));
    await screen.findByText("Worker: Codex · synthetic-model");
    await screen.findByText("Synthetic worker needs codex login.");
    fireEvent.change(screen.getByLabelText("What needs doing"), {
      target: { value: "Synthetic task" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "New task" }));
    expect(start).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: /Start workspace and worker/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("worker entry intent", () => {
  it("preflights direct mode immediately, preserves text on entry changes and submits the server selection", async () => {
    const selection: TaskModelSelection = {
      orchestrator: { agent: "claude", model: "synthetic-model" },
      worker: { agent: "codex", model: "synthetic-model" },
    };
    const { preview, start } = setup(async () => selection, undefined, "direct");
    await screen.findByText("Worker: Codex · synthetic-model");
    expect(preview.mock.calls[0]?.[0]).toMatchObject({ direct: { projectId } });
    fireEvent.change(screen.getByLabelText("What needs doing"), {
      target: { value: "Review this synthetic change" },
    });
    fireEvent.click(screen.getByText("Generic entry"));
    expect(
      screen.getByRole("radio", { name: "Orchestrator plans it" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByText("Worker entry"));
    expect((screen.getByLabelText("What needs doing") as HTMLTextAreaElement).value).toBe(
      "Review this synthetic change",
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /Start workspace and worker/ }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.submit(screen.getByRole("form", { name: "New task" }));
    await screen.findByText("Synthetic start boundary");
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ selection, direct: { projectId }, target: { projectId } }),
    );
  });

  it("cannot send an initial direct draft while authoritative selection is loading", async () => {
    const { start, preview } = setup(() => new Promise(() => {}), undefined, "direct");
    await waitFor(() => expect(preview).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("What needs doing"), {
      target: { value: "Synthetic pending draft" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "New task" }));
    expect(start).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("button", { name: /Start workspace and worker/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
