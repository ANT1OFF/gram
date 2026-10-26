// @vitest-environment happy-dom
import type {
  AgentKind,
  AgentSessionList,
  GatewayProfile,
  ProfileId,
  ProjectId,
  Thread,
  ThreadId,
} from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installKeyboard, registerShortcut } from "@/keyboard/registry";
import { renderWithApi } from "@/panels/test-utils";
import { EMPTY_GRID, useLayoutStore } from "@/stores/layout";

import { ContinueLatest, resumeModel, ResumeSessions } from "./resume-sessions";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const ROOT = "/repo";

const claude: AgentSessionList = {
  supported: true,
  sessions: [
    {
      agentSessionId: "s-new",
      title: "Speed up tests",
      updatedAt: Date.now() - 60_000,
      gitBranch: "fix/speed",
    },
    {
      agentSessionId: "s-open",
      title: "Tracing",
      updatedAt: Date.now() - 3_600_000,
      threadId: "t9" as ThreadId,
    },
  ],
};

const codex: AgentSessionList = {
  supported: true,
  sessions: [{ agentSessionId: "ses_1", title: "Tidy auth", updatedAt: Date.now() - 600_000 }],
};

const profile = {
  id: "litellm",
  name: "LiteLLM",
  default: true,
  models: [{ id: "gpt-5.5", name: "GPT-5.5" }],
} as unknown as GatewayProfile;

const thread = {
  id: "t1" as ThreadId,
  projectId: "p" as ProjectId,
  title: "Speed up tests",
} as Thread;

/** Claude and Codex are both available; `lists` answers `sessions.list` per agent. */
const twoAgents = (lists: Partial<Record<AgentKind, () => Promise<AgentSessionList>>>) => ({
  listModels: async () => ({ models: [] }),
  listProfiles: async () => [profile],
  listSessions: vi.fn(async (agent: AgentKind) => {
    const list = lists[agent];
    return list ? list() : { supported: false, sessions: [] };
  }),
});

const rows = () => screen.getAllByTestId("past-session");

afterEach(() => {
  cleanup();
  navigate.mockReset();
  useLayoutStore.setState({ grid: EMPTY_GRID });
});

describe("ResumeSessions", () => {
  it("lists every agent's sessions newest first, labelled, and resumes a Claude one", async () => {
    const createThread = vi.fn(async () => thread);
    renderWithApi(<ResumeSessions projectRoot={ROOT} />, {
      ...twoAgents({ claude: async () => claude, codex: async () => codex }),
      createThread,
    });

    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().map((row) => row.dataset["agent"])).toEqual(["claude", "codex", "claude"]);
    expect(rows()[0]!.textContent).toContain("Claude Code");
    expect(rows()[0]!.textContent).toContain("fix/speed");
    expect(rows()[1]!.textContent).toContain("Codex");
    expect(rows()[2]!.textContent).toContain("Open");

    fireEvent.click(rows()[0]!);
    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith({
        projectRoot: ROOT,
        checkout: { kind: "current" },
        model: { agent: "claude", model: "default" },
        title: "Speed up tests",
        resumeSessionId: "s-new",
      }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/t/$threadId", params: { threadId: "t1" } }),
    );
  });

  it("opens the thread already showing a session instead of creating another", async () => {
    const createThread = vi.fn();
    renderWithApi(<ResumeSessions projectRoot={ROOT} />, {
      listSessions: async (agent) =>
        agent === "claude" ? claude : { supported: false, sessions: [] },
      createThread,
    });
    fireEvent.click((await screen.findAllByTestId("past-session"))[1]!);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/t/$threadId", params: { threadId: "t9" } }),
    );
    expect(createThread).not.toHaveBeenCalled();
  });

  it("keeps the other agents' sessions when one listing fails", async () => {
    renderWithApi(
      <ResumeSessions projectRoot={ROOT} />,
      twoAgents({
        claude: async () => claude,
        codex: async () => {
          throw new Error("codex serve didn't start");
        },
      }),
    );
    expect(
      await screen.findByText("Couldn't list Codex sessions: codex serve didn't start"),
    ).toBeTruthy();
    expect(rows()).toHaveLength(2);
  });

  it("says when no agent can list sessions, or there are none", async () => {
    renderWithApi(<ResumeSessions projectRoot={ROOT} />, {
      listSessions: async () => ({ supported: false, sessions: [] }),
    });
    expect(await screen.findByText("No agent here can list its past sessions.")).toBeTruthy();
    cleanup();
    renderWithApi(<ResumeSessions projectRoot={ROOT} />, {
      listSessions: async () => ({ supported: true, sessions: [] }),
    });
    expect(await screen.findByText("No past sessions in this folder.")).toBeTruthy();
  });
});

describe("ResumeSessions delete", () => {
  it("deletes a session after an inline confirm, never one a thread shows", async () => {
    let list = claude;
    const deleteSession = vi.fn(async () => {});
    renderWithApi(<ResumeSessions projectRoot={ROOT} />, {
      listSessions: async (agent) =>
        agent === "claude" ? list : { supported: false, sessions: [] },
      deleteSession,
    });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByLabelText("Delete “Tracing”")).toBeNull();

    fireEvent.click(screen.getByLabelText("Delete “Speed up tests”"));
    fireEvent.click(
      within(screen.getByTestId("confirm-delete")).getByRole("button", { name: "Cancel" }),
    );
    expect(rows()).toHaveLength(2);
    expect(deleteSession).not.toHaveBeenCalled();

    // Escape cancels the confirmation and nothing else bound to Escape.
    const escapeShortcut = vi.fn();
    const uninstall = installKeyboard(window);
    const unregister = registerShortcut({
      id: "approval.deny",
      keys: "escape",
      label: "Deny",
      group: "Thread",
      run: escapeShortcut,
    });
    fireEvent.click(screen.getByLabelText("Delete “Speed up tests”"));
    fireEvent.keyDown(
      within(screen.getByTestId("confirm-delete")).getByRole("button", { name: "Cancel" }),
      { key: "Escape" },
    );
    unregister();
    uninstall();
    expect(screen.queryByTestId("confirm-delete")).toBeNull();
    expect(escapeShortcut).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Delete “Speed up tests”"));
    const confirm = screen.getByTestId("confirm-delete");
    expect(confirm.textContent).toContain("can't be undone");
    list = { supported: true, sessions: claude.sessions.slice(1) };
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith("claude", ROOT, "s-new"));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByTestId("confirm-delete")).toBeNull();
  });

  it("shows why a delete failed and keeps the confirm open", async () => {
    renderWithApi(<ResumeSessions projectRoot={ROOT} />, {
      listSessions: async (agent) =>
        agent === "claude" ? claude : { supported: false, sessions: [] },
      deleteSession: async () => {
        throw new Error("Session not found");
      },
    });
    fireEvent.click(await screen.findByLabelText("Delete “Speed up tests”"));
    fireEvent.click(
      within(screen.getByTestId("confirm-delete")).getByRole("button", { name: "Delete" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't delete: Session not found",
    );
    expect(screen.getByTestId("confirm-delete")).toBeTruthy();
  });

  it("resumes on the draft's model when the session is that agent's", async () => {
    const createThread = vi.fn(async () => thread);
    renderWithApi(
      <ResumeSessions
        projectRoot={ROOT}
        model={{ agent: "claude", model: "opus", variant: "high" }}
      />,
      {
        listSessions: async (agent) =>
          agent === "claude" ? claude : { supported: false, sessions: [] },
        createThread,
      },
    );
    fireEvent.click((await screen.findAllByTestId("past-session"))[0]!);
    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith(
        expect.objectContaining({
          model: { agent: "claude", model: "opus", variant: "high" },
          resumeSessionId: "s-new",
        }),
      ),
    );
  });
});

describe("ContinueLatest", () => {
  it("resumes the agent's newest session on the chosen model and effort", async () => {
    const createThread = vi.fn(async () => thread);
    const listSessions = vi.fn(async () => claude);
    renderWithApi(
      <ContinueLatest
        projectRoot={ROOT}
        model={{ agent: "claude", model: "opus", variant: "high" }}
      />,
      { listSessions, createThread },
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue latest session" }));
    await waitFor(() =>
      expect(createThread).toHaveBeenCalledWith({
        projectRoot: ROOT,
        checkout: { kind: "current" },
        model: { agent: "claude", model: "opus", variant: "high" },
        title: "Speed up tests",
        resumeSessionId: "s-new",
      }),
    );
    expect(listSessions).toHaveBeenCalledWith("claude", ROOT, 1);
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/t/$threadId", params: { threadId: "t1" } }),
    );
  });

  it("says when the agent has nothing to continue", async () => {
    renderWithApi(
      <ContinueLatest
        projectRoot={ROOT}
        model={{ agent: "codex", model: "gpt-5.5", profileId: "litellm" as ProfileId }}
      />,
      { listSessions: async () => ({ supported: true, sessions: [] }) },
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue latest session" }));
    expect(await screen.findByText("No past Codex sessions in this folder.")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("resumeModel", () => {
  it.each(["claude", "codex"] as const)(
    "resumes %s with local authentication instead of assigning a gateway",
    (agent) => {
      expect(resumeModel(agent, undefined)).toEqual({ agent, model: "default" });
    },
  );
  it("honors a matching explicitly selected default without borrowing another agent's gateway", () => {
    expect(resumeModel("claude", { agent: "claude", model: "opus" })).toEqual({
      agent: "claude",
      model: "opus",
    });
    expect(resumeModel("codex", { agent: "claude", model: "opus", profileId: profile.id })).toEqual(
      { agent: "codex", model: "default" },
    );
    const selected = { agent: "codex" as const, model: "gateway-model", profileId: profile.id };
    expect(resumeModel("codex", selected)).toEqual(selected);
  });
});
