// @vitest-environment happy-dom
import {
  DEFAULT_SETTINGS,
  type ProjectId,
  type SelectedHarnessSupport,
  type TaskModelSelection,
} from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
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
  useTaskDraftStore.setState({ last: undefined, autonomy: undefined, entry: undefined });
});
const projectId = "synthetic-project" as ProjectId;
const setup = (
  selection: () => Promise<TaskModelSelection>,
  observation: (agent: string) => Partial<SelectedHarnessSupport> = () => ({}),
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
  useTaskDraftStore.setState({ last: undefined, autonomy: undefined, entry: undefined });
  renderWithApi(<NewTaskDraft />, api);
  return { api, preview, start };
};

/** The model a new workspace's orchestrator starts on, as the line beside Start names it. */
const plannedOn = (model: string | RegExp) =>
  waitFor(() =>
    expect(screen.getByTestId("task-destination").textContent).toMatch(
      typeof model === "string" ? `planned by its orchestrator on ${model}` : model,
    ),
  );

describe("new-task authoritative preflight", () => {
  it("shows server-selected Codex for an unset default and pins exactly that selection on submit", async () => {
    const selection: TaskModelSelection = {
      orchestrator: { agent: "codex", model: "synthetic-model" },
    };
    const { start } = setup(async () => selection);
    await plannedOn("synthetic-model");
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
    // Always the orchestrator's: New starts no worker of its own.
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty("direct");
  });

  it("asks only between the orchestrator and one agent", async () => {
    setup(async () => ({ orchestrator: { agent: "claude", model: "synthetic-model" } }));
    const who = await screen.findByRole("radiogroup", { name: "Who does it" });
    expect(
      within(who)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-label")),
    ).toEqual(["Team", "Chat"]);
    expect(screen.getByRole("radio", { name: "Team" }).getAttribute("aria-checked")).toBe("true");
    // No worker model, repository, checkout or hold of a worker's own.
    expect(screen.queryByRole("group", { name: "Worker" })).toBeNull();
    expect(screen.queryByTestId("task-checkout")).toBeNull();
    expect(screen.queryByTestId("task-hold")).toBeNull();
  });

  it("picks the orchestrator's agent in the prompt box, previews the pick and starts on it", async () => {
    const { api, preview, start } = setup(async (input?: unknown) => {
      const picked = (input as { orchestrator?: TaskModelSelection["orchestrator"] }).orchestrator;
      return { orchestrator: picked ?? { agent: "claude", model: "synthetic-model" } };
    });
    // Each agent names its default, which a new pick of the agent opens on.
    vi.spyOn(api, "listModels").mockResolvedValue({
      models: [
        {
          id: "synthetic-model",
          displayName: "Synthetic",
          supportsEffort: false,
          isDefault: true,
        },
      ],
    });
    await plannedOn(/planned by its orchestrator on /);
    const fields = screen.getByTestId("task-orchestrator-fields");
    expect(fields.textContent).toContain("Orchestrator");
    const user = userEvent.setup();
    await user.click(await within(fields).findByLabelText("Agent"));
    await user.click(await screen.findByRole("option", { name: "Codex" }));
    await plannedOn("Synthetic");
    expect(preview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        orchestrator: { agent: "codex", model: "synthetic-model", speed: "standard" },
      }),
    );
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
      expect.objectContaining({
        orchestrator: { agent: "codex", model: "synthetic-model", speed: "standard" },
        selection: {
          orchestrator: { agent: "codex", model: "synthetic-model", speed: "standard" },
        },
      }),
    );
  });

  it("says when the task moves a running orchestrator to the pick", async () => {
    setup(async () => ({
      orchestrator: { agent: "codex", model: "synthetic-model" },
      orchestratorFrom: { agent: "claude", model: "synthetic-model" },
    }));
    await screen.findByText(
      "The orchestrator moves from Claude Code · synthetic-model to Codex · synthetic-model as the task starts.",
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
    await plannedOn("synthetic-model");
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /Start workspace and send/ }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });
});

describe("an orchestrator slot that can't run here", () => {
  it("says why beside what opens instead, and starts on the selection alone", async () => {
    const selection: TaskModelSelection = {
      orchestrator: { agent: "claude", model: "synthetic-model" },
      orchestratorNote:
        "The orchestrator's model can't run here: nothing here fills the Top tier. It opens on claude:synthetic-model instead.",
    };
    const { start } = setup(async () => selection);
    const note = await screen.findByTestId("task-orchestrator-note");
    expect(note.textContent).toContain("nothing here fills the Top tier");
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
      expect.objectContaining({ selection: { orchestrator: selection.orchestrator } }),
    );
  });
});

describe("Start while the check runs", () => {
  it("cannot send a draft while authoritative selection is loading", async () => {
    const { start, preview } = setup(() => new Promise(() => {}));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("What needs doing"), {
      target: { value: "Synthetic pending draft" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "New task" }));
    expect(start).not.toHaveBeenCalled();
    // Start says what it waits on, on the button itself, keeping its action as its name.
    const button = screen.getByRole("button", {
      name: "Start workspace and send, Checking agents…",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Checking agents…");
    expect(screen.queryByText(/Checking the task's selected harness/)).toBeNull();
  });

  it("enables Start, in its own words, once the check passes", async () => {
    setup(async () => ({ orchestrator: { agent: "claude", model: "synthetic-model" } }));
    fireEvent.change(screen.getByLabelText("What needs doing"), {
      target: { value: "Synthetic task" },
    });
    await waitFor(() => {
      const button = screen.getByTestId("task-submit") as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.hasAttribute("data-checking")).toBe(false);
      expect(button.textContent).toMatch(/^Start workspace and send/);
    });
  });
});
