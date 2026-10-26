// @vitest-environment happy-dom
import type { AgentKind, AgentSessionList } from "@gram/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Api } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";

import { ResumeSessions } from "./resume-sessions";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const ROOT = "/repo";

const claude: AgentSessionList = {
  supported: true,
  sessions: [
    { agentSessionId: "s-new", title: "Speed up tests", updatedAt: Date.now() - 60_000 },
    { agentSessionId: "s-old", title: "Tracing", updatedAt: Date.now() - 3_600_000 },
  ],
};

const api = (previewSession: Api["previewSession"]): Partial<Api> => ({
  listModels: async () => ({ models: [] }),
  listProfiles: async () => [],
  listSessions: vi.fn(async (agent: AgentKind): Promise<AgentSessionList> =>
    agent === "claude" ? claude : { supported: false, sessions: [] },
  ),
  previewSession,
});

const rows = () => screen.getAllByTestId("past-session");

afterEach(cleanup);

describe("ResumeSessions preview", () => {
  it("reads only the hovered or focused session and shows its first prompt and last reply", async () => {
    const previewSession = vi.fn(async (_agent: AgentKind, _root: string, id: string) =>
      id === "s-new"
        ? {
            firstPrompt: "The tests take 40 s, make them fast.",
            lastReply: "Swapped in fake timers.",
          }
        : {},
    );
    renderWithApi(<ResumeSessions projectRoot={ROOT} />, api(previewSession));

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(previewSession).not.toHaveBeenCalled();

    fireEvent.mouseEnter(rows()[0]!);
    const note = await screen.findByTestId("session-preview");
    expect(note.textContent).toContain("YouThe tests take 40 s, make them fast.");
    expect(note.textContent).toContain("Last replySwapped in fake timers.");
    expect(rows()[0]!.getAttribute("aria-describedby")).toBe(note.id);
    expect(previewSession).toHaveBeenCalledOnce();
    expect(previewSession).toHaveBeenCalledWith("claude", ROOT, "s-new");

    fireEvent.focus(rows()[1]!);
    await waitFor(() => expect(previewSession).toHaveBeenCalledWith("claude", ROOT, "s-old"));
    await waitFor(() => expect(screen.queryByTestId("session-preview")).toBeNull());

    fireEvent.mouseEnter(rows()[0]!);
    expect(await screen.findByTestId("session-preview")).toBeTruthy();
    expect(previewSession).toHaveBeenCalledTimes(2);
  });
});
