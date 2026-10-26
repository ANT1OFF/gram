// @vitest-environment happy-dom
import {
  DEFAULT_SETTINGS,
  type ProjectId,
  type TaskModelSelection,
  type Thread,
  type TaskWorkerChoice,
} from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockApi } from "@/api/mock";
import { useTaskDraftStore } from "@/orchestration/task-draft-store";
import { taskTargetKey } from "@/orchestration/task-model";
import { renderWithApi } from "@/panels/test-utils";
import { useServerSettings } from "@/settings-sync/store";

import { NewTaskDraft } from "./new-task-draft";
import { workerChoiceKey } from "./worker-choice";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

const projectId = "synthetic-project" as ProjectId;
const target = { kind: "repo", projectId } as const;
const targetKey = taskTargetKey(target);
const orchestrator = { agent: "claude", model: "synthetic-orchestrator" } as const;

const opus: TaskWorkerChoice = {
  model: { agent: "claude", model: "synthetic-large", variant: "high" },
  useFor: "implementation, anything cross-cutting",
  default: true,
};
const haiku: TaskWorkerChoice = {
  model: { agent: "claude", model: "synthetic-small" },
  useFor: "simple tasks",
};
const sol: TaskWorkerChoice = {
  model: { agent: "codex", model: "synthetic-codex", variant: "high" },
  useFor: "reviews and audits",
};

afterEach(() => {
  cleanup();
  useServerSettings.setState({ settings: undefined });
  useTaskDraftStore.setState({
    last: undefined,
    autonomy: undefined,
    entry: undefined,
    workers: {},
  });
});

const setup = (choices: TaskWorkerChoice[], workers: Record<string, string> = {}) => {
  const api = createMockApi({ speed: 0, autoplay: false, persist: false });
  vi.spyOn(api, "listWorkspaces").mockResolvedValue([]);
  vi.spyOn(api, "listProjects").mockResolvedValue([
    { id: projectId, name: "Synthetic", root: "/synthetic/repo", bookmarked: true },
  ]);
  vi.spyOn(api, "listModels").mockResolvedValue({
    models: [{ id: "synthetic-large", displayName: "Synthetic", supportsEffort: false }],
  });
  const standing = choices.find((choice) => choice.default === true);
  const preview = vi.spyOn(api, "taskPreflight").mockResolvedValue({
    orchestrator,
    ...(standing?.unavailable === undefined && standing !== undefined
      ? { worker: standing.model }
      : {}),
    workerChoices: choices,
  } satisfies TaskModelSelection);
  const start = vi.spyOn(api, "startTask").mockRejectedValue(new Error("Synthetic start boundary"));
  vi.spyOn(api, "agentSupport").mockImplementation(async (model) => ({
    model,
    checkedAt: 1,
    support: {
      orchestrator: { state: "supported", evidence: "Synthetic task policy" },
      worker: { state: "supported", evidence: "Synthetic task policy" },
    },
    availability: { state: "available" },
  }));
  useServerSettings.setState({ settings: DEFAULT_SETTINGS });
  useTaskDraftStore.setState({ last: target, autonomy: undefined, entry: undefined, workers });
  renderWithApi(<NewTaskDraft initialWay="direct" />, api);
  return { preview, start };
};

const startButton = () =>
  screen.getByRole("button", { name: /Start workspace and worker/ }) as HTMLButtonElement;

const send = async (refused = true) => {
  fireEvent.change(screen.getByLabelText("What needs doing"), {
    target: { value: "Synthetic direct task" },
  });
  await waitFor(() => expect(startButton().disabled).toBe(false));
  fireEvent.submit(screen.getByRole("form", { name: "New task" }));
  if (refused) await screen.findByText("Synthetic start boundary");
};

describe("New task's direct worker picker", () => {
  it("starts on the roster's default and sends exactly that worker to the server", async () => {
    const { preview, start } = setup([opus, haiku, sol]);
    const model = await screen.findByLabelText("Worker model");
    expect(model.textContent).toContain("synthetic-large · high");
    expect(screen.getByLabelText("Worker agent").textContent).toContain("Claude Code");
    expect(preview.mock.calls[0]?.[0]).toEqual({
      target: { projectId },
      direct: { projectId },
    });
    await send();
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        direct: { projectId, worker: opus.model },
        selection: { orchestrator, worker: opus.model },
      }),
    );
  });

  it("sends the model picked, and remembers it for the next draft on the same target", async () => {
    const { start } = setup([opus, haiku, sol]);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Worker model"));
    // Each model says what it is for.
    expect(screen.getByRole("option", { name: /synthetic-small/ }).textContent).toContain(
      "simple tasks",
    );
    await user.click(screen.getByRole("option", { name: /synthetic-small/ }));
    expect(screen.getByLabelText("Worker model").textContent).toContain("synthetic-small");
    start.mockResolvedValueOnce({ id: "synthetic-worker" } as Thread);
    await send(false);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        direct: { projectId, worker: haiku.model },
        selection: { orchestrator, worker: haiku.model },
      }),
    );
    await waitFor(() =>
      expect(useTaskDraftStore.getState().workers).toEqual({
        [targetKey]: workerChoiceKey(haiku.model),
      }),
    );
  });

  it("opens on the model remembered for the target", async () => {
    const { start } = setup([opus, haiku, sol], { [targetKey]: workerChoiceKey(sol.model) });
    const model = await screen.findByLabelText("Worker model");
    expect(model.textContent).toContain("synthetic-codex · high");
    expect(screen.getByLabelText("Worker agent").textContent).toContain("Codex");
    await send();
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ direct: { projectId, worker: sol.model } }),
    );
  });

  it("falls back to the default when the remembered model is no longer on the roster", async () => {
    setup([opus, haiku], { [targetKey]: workerChoiceKey(sol.model) });
    expect((await screen.findByLabelText("Worker model")).textContent).toContain("synthetic-large");
  });

  it("filters the models by the agent picked", async () => {
    const { start } = setup([opus, haiku, sol]);
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("Worker model"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("synthetic-large"),
      expect.stringContaining("synthetic-small"),
    ]);
    await user.keyboard("{Escape}");
    await user.click(screen.getByLabelText("Worker agent"));
    await user.click(screen.getByRole("option", { name: /Codex/ }));
    expect(screen.getByLabelText("Worker model").textContent).toContain("synthetic-codex");
    await user.click(screen.getByLabelText("Worker model"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("synthetic-codex"),
    ]);
    await user.keyboard("{Escape}");
    await send();
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ direct: { projectId, worker: sol.model } }),
    );
  });

  it("shows an unavailable model disabled with its reason, and can't send on it", async () => {
    const reason = "Codex couldn't list local models; install its CLI, sign in locally";
    const { start } = setup([
      { ...opus, unavailable: reason },
      haiku,
      { ...sol, unavailable: reason },
    ]);
    const user = userEvent.setup();
    // The default can't run: it is shown, said why, and blocks sending until another is picked.
    await screen.findByLabelText("Worker model");
    expect(screen.getByRole("alert").textContent).toContain(`can't run here: ${reason}`);
    fireEvent.change(screen.getByLabelText("What needs doing"), {
      target: { value: "Synthetic direct task" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "New task" }));
    expect(start).not.toHaveBeenCalled();
    expect(startButton().disabled).toBe(true);

    await user.click(screen.getByLabelText("Worker model"));
    const large = screen.getByRole("option", { name: /synthetic-large/ });
    expect(large.getAttribute("aria-disabled")).toBe("true");
    expect(large.textContent).toContain(`Unavailable: ${reason}`);
    await user.click(screen.getByRole("option", { name: /synthetic-small/ }));
    expect(screen.queryByRole("alert")).toBeNull();

    // No Codex entry can run, so the agent can't be switched to it.
    await user.click(screen.getByLabelText("Worker agent"));
    expect(screen.getByRole("option", { name: /Codex/ }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    await user.keyboard("{Escape}");
    await send();
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ direct: { projectId, worker: haiku.model } }),
    );
  });
});
