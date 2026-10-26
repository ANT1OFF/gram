// @vitest-environment happy-dom
import type { PendingRequest, RequestId, ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { installKeyboard } from "@/keyboard/registry";

import {
  ApprovalCard,
  ApprovalInput,
  CompactRequestCards,
  PlanCard,
  QuestionCard,
  RequestCards,
} from "./request-cards";
import { StatePill } from "./orchestration-cards";
import { presentState, type StateTone } from "./orchestration-model";
import {
  appToolSummary,
  approvalDetails,
  approvalExtras,
  mustReadDetails,
  settingsProposal,
  workspaceProposal,
} from "./request-model";

const T = "t1" as ThreadId;

const fakeApi = () => {
  const respond = vi.fn(async () => {});
  return { api: { respond } as unknown as Api, respond };
};

const approval: Extract<PendingRequest, { kind: "approval" }> = {
  kind: "approval",
  id: "r1" as RequestId,
  toolName: "Bash",
  displayName: "Bash",
  input: { command: "git push origin main" },
  suggestions: [
    {
      type: "addRules",
      rules: [{ toolName: "Bash" }],
      behavior: "allow",
      destination: "localSettings",
    },
  ],
};

const BRIEF =
  'Add a percentage discount to the cart.\n\n**Not markdown**: keep "quotes" and <tags> as written.';
const spawn: Extract<PendingRequest, { kind: "approval" }> = {
  kind: "approval",
  id: "r-spawn" as RequestId,
  toolName: "mcp__gram__spawn_worker",
  displayName: "spawn_worker",
  input: {
    project: "shop-web",
    alsoIn: ["shop-api"],
    feature: "percentage-discount",
    group: "0.4.0",
    title: "Percentage discount",
    brief: BRIEF,
    branch: "feat/percentage-discount",
    model: "claude:opus",
    effort: "high",
    scope: ["src/cart", "src/pricing/discount.ts"],
    clientRequestId: "c-1",
  },
  description:
    'Add shop-web to the "shop-api" workspace, and spawn a worker there for percentage-discount: Percentage discount',
  suggestions: [],
  scopes: ["once"],
};

const ISSUE_BODY = "It froze.\n\n---\n\n**Diagnostics**\n\n- Gram 0.6.0";
const issue: Extract<PendingRequest, { kind: "approval" }> = {
  kind: "approval",
  id: "r-issue" as RequestId,
  toolName: "mcp__gram__report_issue",
  displayName: "report_issue",
  input: {
    repo: "ANT1OFF/gram",
    labels: ["bug", "web"],
    title: "Terminal freezes",
    body: ISSUE_BODY,
  },
  description: "File “Terminal freezes” on ANT1OFF/gram (bug, web)",
  suggestions: [],
  scopes: ["once"],
};

let uninstall: () => void;
beforeEach(() => {
  uninstall = installKeyboard();
});
afterEach(() => {
  cleanup();
  uninstall();
});

const settingsChange: Extract<PendingRequest, { kind: "approval" }> = {
  kind: "approval",
  id: "r-settings" as RequestId,
  toolName: "mcp__gram__settings_propose",
  displayName: "Change settings",
  input: {
    scope: "workspace",
    workspace: { id: "w1", name: "shop" },
    reason: "The user asked for a cheaper reviewer.",
    rows: [
      {
        key: "workspace.maxConcurrentWorkers",
        label: "Max concurrent workers",
        before: "10",
        after: "4",
      },
      {
        key: "workspace.workerModels",
        label: "Worker model claude:haiku",
        before: null,
        after: "claude:haiku · medium — reviews",
      },
      {
        key: "workspace.workerModels",
        label: "Worker model codex:gpt-6.1-sol",
        before: "codex:gpt-6.1-sol · high",
        after: null,
      },
    ],
    notes: ["<b>Not markup</b>"],
  },
  description: "Change 3 settings in the workspace “shop”.",
  suggestions: [],
  scopes: ["once"],
};

const workspaceCreate: Extract<PendingRequest, { kind: "approval" }> = {
  kind: "approval",
  id: "r-ws-create" as RequestId,
  toolName: "mcp__gram__workspace_create",
  displayName: "Create workspace",
  input: {
    action: "create",
    workspace: { name: "platform" },
    projects: [
      { root: "/repos/shop", name: "shop", change: "added", home: true },
      { root: "/repos/warehouse", name: "warehouse", change: "added", unregistered: true },
    ],
    rows: [
      { key: "workspace.autonomy", label: "Autonomy", before: null, after: "Supervised" },
      { key: "workspace.workerMode", label: "Worker mode", before: null, after: "Auto" },
    ],
  },
  description: "Create the workspace “platform” with 2 projects.",
  suggestions: [],
  scopes: ["once"],
};

const workspaceUpdate: Extract<PendingRequest, { kind: "approval" }> = {
  ...workspaceCreate,
  id: "r-ws-update" as RequestId,
  toolName: "mcp__gram__workspace_update",
  displayName: "Change workspace",
  input: {
    action: "update",
    workspace: { id: "w1", name: "shop" },
    reason: "You asked for the warehouse repo.",
    projects: [
      { root: "/repos/shop", name: "shop", change: "kept", home: true },
      { root: "/repos/old", name: "old", change: "removed" },
      { root: "/repos/warehouse", name: "warehouse", change: "added", unregistered: true },
    ],
    rows: [{ key: "workspace.autonomy", label: "Autonomy", before: "Full", after: "Publish" }],
  },
  description: "Change 3 things in the workspace “shop”.",
};

describe("RequestCards", () => {
  const second = {
    ...approval,
    id: "r-second" as RequestId,
    displayName: "Read",
    input: { file: "README.md" },
  };
  const third = { ...approval, id: "r-third" as RequestId, displayName: "Edit" };

  it("pages approvals with buttons and gives shortcuts only to the selected card", async () => {
    const { api, respond } = fakeApi();
    render(
      <ApiProvider api={api}>
        <RequestCards threadId={T} requests={[approval, second, third]} focused />
      </ApiProvider>,
    );
    const next = screen.getByRole("button", { name: "Next approval" });
    const previous = screen.getByRole("button", { name: "Previous approval" });
    expect((previous as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("1/3").textContent).toContain("1/3");
    expect(screen.queryByRole("region", { name: "Allow Read?" })).toBeNull();
    next.focus();
    fireEvent.click(next);
    expect(document.activeElement).toBe(next);
    expect(screen.getByText("2/3")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Allow Read?" })).toBeTruthy();
    fireEvent.click(next);
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(previous);
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, second.id, {
        kind: "approval",
        decision: "allow",
        scope: "once",
      }),
    );
    expect(respond).toHaveBeenCalledTimes(1);
    // Revisiting an answer still in flight cannot send it twice.
    fireEvent.click(previous);
    fireEvent.click(next);
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("keeps the selected approval through arrivals and removals, then clamps when it is resolved", () => {
    const { api } = fakeApi();
    const cards = (requests: readonly PendingRequest[]) => (
      <ApiProvider api={api}>
        <RequestCards threadId={T} requests={requests} focused />
      </ApiProvider>
    );
    const { rerender } = render(cards([approval, second]));
    fireEvent.click(screen.getByRole("button", { name: "Next approval" }));
    rerender(cards([approval, second, third]));
    expect(screen.getByText("2/3")).toBeTruthy();
    rerender(cards([second, third]));
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Allow Read?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next approval" }));
    rerender(cards([second]));
    expect(screen.queryByRole("navigation", { name: "Approval navigation" })).toBeNull();
    expect(screen.getByRole("region", { name: "Allow Read?" })).toBeTruthy();
    rerender(cards([]));
    expect(screen.queryByTestId("approval-card")).toBeNull();
  });

  it.each([
    { kind: "plan", id: "plan" as RequestId, plan: "Make the change" },
    { kind: "question", id: "question" as RequestId, questions: [] },
  ] satisfies PendingRequest[])(
    "answers the selected approval when a $kind comes first",
    async (preceding) => {
      const { api, respond } = fakeApi();
      const cards = (requests: readonly PendingRequest[]) => (
        <ApiProvider api={api}>
          <RequestCards threadId={T} requests={requests} focused />
        </ApiProvider>
      );
      const { rerender } = render(cards([preceding, approval, second]));
      fireEvent.click(screen.getByRole("button", { name: "Next approval" }));
      fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
      await waitFor(() =>
        expect(respond).toHaveBeenCalledWith(T, second.id, {
          kind: "approval",
          decision: "allow",
          scope: "once",
        }),
      );
      rerender(cards([preceding, approval]));
      fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
      await waitFor(() =>
        expect(respond).toHaveBeenCalledWith(T, approval.id, {
          kind: "approval",
          decision: "deny",
          scope: "once",
        }),
      );
      expect(respond).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId(`${preceding.kind}-card`)).toBeTruthy();
    },
  );

  it("leaves questions and plans visible and ignores shortcuts in an unfocused pane", () => {
    const { api, respond } = fakeApi();
    render(
      <ApiProvider api={api}>
        <RequestCards
          threadId={T}
          focused={false}
          requests={[
            { kind: "plan", id: "plan" as RequestId, plan: "Make the change" },
            approval,
            second,
            { kind: "question", id: "question" as RequestId, questions: [] },
          ]}
        />
      </ApiProvider>,
    );
    expect(screen.getByTestId("plan-card")).toBeTruthy();
    expect(screen.getByTestId("question-card")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next approval" }));
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    expect(respond).not.toHaveBeenCalled();
  });

  it("names the role of an orchestrator or a worker on the card, and nothing on a plain thread", () => {
    const { api } = fakeApi();
    const cards = (thread?: Parameters<typeof RequestCards>[0]["thread"]) => (
      <ApiProvider api={api}>
        <RequestCards threadId={T} requests={[approval]} focused={false} thread={thread} />
      </ApiProvider>
    );
    const view = render(cards({}));
    expect(screen.queryByTestId("request-role")).toBeNull();
    view.rerender(cards({ role: "orchestrator" }));
    expect(screen.getByTestId("request-role").textContent).toBe("Orchestrator");
    view.rerender(cards({ spawnedBy: { threadId: "t-o" as ThreadId, feature: "rate-limits" } }));
    expect(screen.getByTestId("request-role").textContent).toBe("Worker · rate-limits");
    // The chip sits in the heading, while the card's accessible name stays the question asked.
    expect(screen.getByTestId("approval-card").getAttribute("aria-label")).toBe("Allow Bash?");
  });
});

describe("ApprovalCard", () => {
  it("shows the command and allows once on click", async () => {
    const { api, respond } = fakeApi();
    render(
      <ApiProvider api={api}>
        <ApprovalCard threadId={T} request={approval} active={false} />
      </ApiProvider>,
    );
    expect(screen.getByTestId("approval-card").textContent).toContain("git push origin main");
    fireEvent.click(screen.getByTestId("approval-allow"));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, "r1", {
        kind: "approval",
        decision: "allow",
        scope: "once",
      }),
    );
  });

  it.each([
    [
      { key: "Enter", code: "Enter" },
      { decision: "allow", scope: "once" },
    ],
    [
      { key: "Enter", code: "Enter", altKey: true },
      { decision: "allow", scope: "always" },
    ],
    [
      { key: "Escape", code: "Escape" },
      { decision: "deny", scope: "once" },
    ],
  ])("answers from the keyboard (%o)", async (keys, expected) => {
    const { api, respond } = fakeApi();
    render(
      <ApiProvider api={api}>
        <ApprovalCard threadId={T} request={approval} active />
      </ApiProvider>,
    );
    fireEvent.keyDown(window, keys);
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, "r1", { kind: "approval", ...expected }),
    );
  });

  it("ignores the keyboard when not active and hides Allow always without suggestions", () => {
    const { api, respond } = fakeApi();
    render(
      <ApiProvider api={api}>
        <ApprovalCard threadId={T} request={{ ...approval, suggestions: [] }} active={false} />
      </ApiProvider>,
    );
    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    expect(respond).not.toHaveBeenCalled();
    expect(screen.queryByTestId("approval-always")).toBeNull();
  });

  it("offers a browse card's host for always, with no suggestions, and only when it may", async () => {
    const { api, respond } = fakeApi();
    const browse = {
      ...approval,
      toolName: "mcp__gram__browser_navigate",
      displayName: "browser_navigate",
      input: { url: "https://docs.example.com/" },
      suggestions: [],
      scopes: ["once", "always"] as const,
      browseHost: "docs.example.com",
    };
    const view = render(
      <ApiProvider api={api}>
        <ApprovalCard threadId={T} request={browse} active={false} />
      </ApiProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Always for docs\.example\.com/ }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, "r1", {
        kind: "approval",
        decision: "allow",
        scope: "always",
      }),
    );
    view.rerender(
      <ApiProvider api={api}>
        <ApprovalCard threadId={T} request={{ ...browse, scopes: ["once"] }} active={false} />
      </ApiProvider>,
    );
    expect(screen.queryByTestId("approval-always")).toBeNull();
  });

  it("shows the arguments beside the command, short, with the whole input under Details", () => {
    const request = {
      ...approval,
      input: {
        command: "git push origin main",
        description: "Publish the branch",
        timeout: 600_000,
        note: `${"x".repeat(100)}\nend`,
      },
      description: "Publish the branch",
    };
    // The description the card already shows is left out; a long value is cut short.
    expect(approvalExtras(request)).toEqual([
      { label: "timeout", value: "600000" },
      { label: "note", value: `${"x".repeat(79)}…` },
    ]);
    expect(approvalExtras(approval)).toEqual([]);
    expect(approvalExtras({ ...approval, input: { query: "x" } })).toEqual([]);
    const { api } = fakeApi();
    render(
      <ApiProvider api={api}>
        <CompactRequestCards>
          <ApprovalCard threadId={T} request={request} active={false} />
        </CompactRequestCards>
      </ApiProvider>,
    );
    expect(screen.getByTestId("approval-extras").textContent).toContain("timeout: 600000");
    fireEvent.click(screen.getByTestId("approval-details"));
    expect(screen.getByTestId("approval-details-body").textContent).toContain('"timeout": 600000');
  });

  it("shows a description the input carries, and the whole input, on a grouped card too", () => {
    const request = {
      ...approval,
      input: { command: "git push origin main", description: "Publish the branch" },
      description: "Publish the branch",
    };
    render(<ApprovalInput request={request} />);
    expect(screen.queryByTestId("approval-extras")).toBeNull();
    expect(screen.getByText("Publish the branch")).toBeTruthy();
    fireEvent.click(screen.getByTestId("approval-details"));
    expect(screen.getByTestId("approval-details-body").textContent).toContain("Publish the branch");
  });

  it("shows no arguments line or Details for a command alone", () => {
    const { api } = fakeApi();
    render(
      <ApiProvider api={api}>
        <ApprovalCard threadId={T} request={approval} active={false} />
      </ApiProvider>,
    );
    expect(screen.queryByTestId("approval-extras")).toBeNull();
    expect(screen.queryByTestId("approval-details")).toBeNull();
  });
});

describe("an app tool's approval", () => {
  it("reads a spawn as fields, scope and brief, and any other app tool as indented JSON", () => {
    expect(appToolSummary(spawn)).toBe(spawn.description);
    expect(appToolSummary(approval)).toBeUndefined();
    expect(appToolSummary({ ...approval, description: "Runs a command" })).toBeUndefined();
    expect(appToolSummary({ ...spawn, description: "  " })).toBeUndefined();

    expect(approvalDetails(spawn)).toEqual({
      kind: "spawn",
      fields: [
        { label: "Projects", value: "shop-web, shop-api" },
        { label: "Feature", value: "percentage-discount" },
        { label: "Group", value: "0.4.0" },
        { label: "Title", value: "Percentage discount" },
        { label: "Branch", value: "feat/percentage-discount" },
        { label: "Model", value: "claude:opus · high" },
      ],
      scope: ["src/cart", "src/pricing/discount.ts"],
      brief: BRIEF,
    });
    const bare = { ...spawn, input: { project: "shop-web", feature: "f", title: "t", brief: "b" } };
    expect(approvalDetails(bare)).toEqual({
      kind: "spawn",
      fields: [
        { label: "Project", value: "shop-web" },
        { label: "Feature", value: "f" },
        { label: "Title", value: "t" },
      ],
      scope: [],
      brief: "b",
    });
    // A spawn that isn't shaped like one, and every other app tool, keep the whole input.
    const odd = { ...spawn, input: { project: 7, brief: BRIEF } };
    expect(approvalDetails(odd)).toEqual({
      kind: "json",
      text: JSON.stringify(odd.input, null, 2),
    });
    const send = {
      ...spawn,
      toolName: "mcp__gram__send_message",
      input: { threadId: "t2", text: "hello" },
    };
    expect(approvalDetails(send)).toEqual({
      kind: "json",
      text: '{\n  "threadId": "t2",\n  "text": "hello"\n}',
    });
  });

  it("leads with the description, folds the input under Details, and keeps the shortcuts", async () => {
    const { api, respond } = fakeApi();
    render(
      <ApiProvider api={api}>
        <ApprovalCard threadId={T} request={spawn} active />
      </ApiProvider>,
    );
    const card = screen.getByTestId("approval-card");
    expect(screen.getByTestId("approval-summary").textContent).toBe(spawn.description);
    expect(card.textContent).not.toContain("Not markdown");
    expect(card.textContent).not.toContain('"project"');

    fireEvent.click(screen.getByTestId("approval-details"));
    const brief = await screen.findByTestId("approval-brief");
    // The agent's text, as written: no markdown, no markup.
    expect(brief.textContent).toBe(BRIEF);
    expect(brief.querySelector("strong, tags")).toBeNull();
    const body = screen.getByTestId("approval-details-body").textContent;
    expect(body).toContain("shop-web, shop-api");
    expect(body).toContain("src/pricing/discount.ts");
    expect(body).not.toContain("c-1");

    fireEvent.keyDown(window, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, "r-spawn", {
        kind: "approval",
        decision: "allow",
        scope: "once",
      }),
    );
  });

  it("shows an issue's final text open, not folded, as fields and the body as posted", () => {
    expect(approvalDetails(issue)).toEqual({
      kind: "issue",
      fields: [
        { label: "Repo", value: "ANT1OFF/gram" },
        { label: "Labels", value: "bug, web" },
        { label: "Title", value: "Terminal freezes" },
      ],
      body: ISSUE_BODY,
    });
    expect(approvalDetails({ ...issue, input: { title: "t" } }).kind).toBe("json");
    const { api } = fakeApi();
    render(
      <ApiProvider api={api}>
        <ApprovalCard threadId={T} request={issue} active={false} />
      </ApiProvider>,
    );
    expect(screen.getByTestId("approval-summary").textContent).toBe(issue.description);
    expect(screen.getByTestId("approval-issue-body").textContent).toBe(ISSUE_BODY);
    expect(screen.queryByTestId("approval-always")).toBeNull();
  });

  it("shows a settings change as before and after, all of it, and applies it on Apply changes", async () => {
    expect(mustReadDetails(settingsChange)).toBe(true);
    expect(settingsProposal({ ...settingsChange, input: { rows: "nope" } })).toBeUndefined();
    const { api, respond } = fakeApi();
    render(
      <ApiProvider api={api}>
        <ApprovalCard threadId={T} request={settingsChange} active />
      </ApiProvider>,
    );
    const card = screen.getByTestId("approval-card");
    expect(card.textContent).toContain("Change Gram settings?");
    expect(screen.getByTestId("approval-summary").textContent).toBe(settingsChange.description);
    expect(screen.getByTestId("settings-reason").textContent).toBe(
      "Why: The user asked for a cheaper reviewer.",
    );
    const rows = screen.getAllByTestId("settings-diff-row").map((row) => row.textContent);
    expect(rows).toEqual([
      "Max concurrent workers104",
      "Worker model claude:haikuNot thereclaude:haiku · medium — reviews",
      "Worker model codex:gpt-6.1-solcodex:gpt-6.1-sol · highRemoved",
    ]);
    // The server's and the agent's words are text, never markup.
    expect(screen.getByTestId("settings-notes").querySelector("b")).toBeNull();
    expect(screen.queryByTestId("approval-always")).toBeNull();
    expect(screen.getByTestId("approval-allow").textContent).toContain("Apply changes");

    fireEvent.click(screen.getByTestId("approval-allow"));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, "r-settings", {
        kind: "approval",
        decision: "allow",
        scope: "once",
      }),
    );
  });

  it("shows a new workspace whole: its projects, marking the new ones, then its settings", async () => {
    expect(mustReadDetails(workspaceCreate)).toBe(true);
    expect(mustReadDetails(workspaceUpdate)).toBe(true);
    expect(workspaceProposal({ ...workspaceCreate, input: { action: "nope" } })).toBeUndefined();
    // Only the workspace tools' cards read as one.
    expect(workspaceProposal({ ...workspaceCreate, toolName: "mcp__gram__other" })).toBeUndefined();
    const { api, respond } = fakeApi();
    render(
      <ApiProvider api={api}>
        <ApprovalCard threadId={T} request={workspaceCreate} active />
      </ApiProvider>,
    );
    expect(screen.getByTestId("approval-card").textContent).toContain(
      "Create workspace “platform”?",
    );
    expect(screen.getAllByTestId("workspace-project").map((row) => row.textContent)).toEqual([
      "/repos/shopshop · home",
      "/repos/warehousewarehouse · new to Gram, added as a project",
    ]);
    // A new workspace lists what it will have: no "Now" column.
    expect(screen.queryByText("Now")).toBeNull();
    expect(screen.getAllByTestId("settings-diff-row").map((row) => row.textContent)).toEqual([
      "AutonomySupervised",
      "Worker modeAuto",
    ]);
    expect(screen.queryByTestId("approval-always")).toBeNull();
    expect(screen.getByTestId("approval-allow").textContent).toContain("Create workspace");
    fireEvent.click(screen.getByTestId("approval-allow"));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, "r-ws-create", {
        kind: "approval",
        decision: "allow",
        scope: "once",
      }),
    );
  });

  it("shows a workspace change as projects kept, removed and added, and settings before → after", () => {
    const { api } = fakeApi();
    render(
      <ApiProvider api={api}>
        <CompactRequestCards>
          <ApprovalCard threadId={T} request={workspaceUpdate} active={false} />
        </CompactRequestCards>
      </ApiProvider>,
    );
    expect(screen.getByTestId("approval-card").textContent).toContain("Change workspace “shop”?");
    expect(screen.getByTestId("settings-reason").textContent).toBe(
      "Why: You asked for the warehouse repo.",
    );
    expect(screen.getAllByTestId("workspace-project").map((row) => row.textContent)).toEqual([
      "Keeps/repos/shopshop · home",
      "Removes/repos/oldold",
      "Adds/repos/warehousewarehouse · new to Gram, added as a project",
    ]);
    expect(screen.getAllByTestId("settings-diff-row").map((row) => row.textContent)).toEqual([
      "AutonomyFullPublish",
    ]);
    expect(screen.getByTestId("approval-allow").textContent).toContain("Apply changes");
  });

  it("scrolls a card's body in the thread and keeps its buttons outside it", () => {
    const { api } = fakeApi();
    render(
      <ApiProvider api={api}>
        <ApprovalCard threadId={T} request={workspaceUpdate} active={false} />
      </ApiProvider>,
    );
    const body = screen.getByTestId("request-card-body");
    expect(body.className).toContain("overflow-y-auto");
    expect(body.contains(screen.getByTestId("workspace-diff"))).toBe(true);
    expect(body.contains(screen.getByTestId("approval-allow"))).toBe(false);
    expect(body.contains(screen.getByTestId("approval-deny"))).toBe(false);
  });

  it("shows a settings change whole in the inbox's compact card too", () => {
    const { api } = fakeApi();
    render(
      <ApiProvider api={api}>
        <CompactRequestCards>
          <ApprovalCard threadId={T} request={settingsChange} active={false} />
        </CompactRequestCards>
      </ApiProvider>,
    );
    expect(screen.getAllByTestId("settings-diff-row")).toHaveLength(3);
  });

  it("shows an issue's body in the inbox's compact card too", () => {
    const { api } = fakeApi();
    render(
      <ApiProvider api={api}>
        <CompactRequestCards>
          <ApprovalCard threadId={T} request={issue} active={false} />
        </CompactRequestCards>
      </ApiProvider>,
    );
    expect(screen.getByTestId("approval-issue-body").textContent).toBe(ISSUE_BODY);
  });

  it("shows every request a browser submission sends, opened, in the compact card too", () => {
    const { api } = fakeApi();
    const requests = [
      "https://a.example/1",
      "https://a.example/2",
      "https://a.example/3",
      "https://a.example/4",
    ];
    render(
      <ApiProvider api={api}>
        <CompactRequestCards>
          <ApprovalCard
            threadId={T}
            request={{
              ...approval,
              toolName: "mcp__gram__browser_click",
              displayName: "browser_click",
              description: "Let the agent submit to a public site?",
              input: { url: requests.join(", "), control: "4 requests the page sent", requests },
              suggestions: [],
              scopes: ["once"],
            }}
            active={false}
          />
        </CompactRequestCards>
      </ApiProvider>,
    );
    const body = screen.getByTestId("approval-details-body").textContent ?? "";
    for (const url of requests) expect(body).toContain(url);
  });

  it("shows the description alone in the inbox's compact card", () => {
    const { api } = fakeApi();
    render(
      <ApiProvider api={api}>
        <CompactRequestCards>
          <ApprovalCard threadId={T} request={spawn} active={false} />
        </CompactRequestCards>
      </ApiProvider>,
    );
    expect(screen.getByTestId("approval-summary").textContent).toBe(spawn.description);
    expect(screen.queryByTestId("approval-details")).toBeNull();
    expect(screen.getByTestId("approval-allow")).toBeTruthy();
  });
});

describe("StatePill", () => {
  it("draws a state or a tone this build doesn't know as neutral instead of throwing", () => {
    render(
      <>
        <StatePill state={presentState("shipped")} testId="unknown-state" />
        <StatePill state={{ label: "Odd", tone: "odd" as StateTone }} testId="unknown-tone" />
        <StatePill state={presentState("delivered")} testId="delivered" iconOnly />
      </>,
    );
    expect(screen.getByTestId("unknown-state").textContent).toBe("shipped");
    expect(screen.getByTestId("unknown-state").querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("unknown-tone").className).toContain("text-muted-foreground");
    // Icon-only still says the word to a screen reader.
    expect(screen.getByTestId("delivered").querySelector(".sr-only")?.textContent).toBe(
      "Delivered",
    );
  });
});

describe("QuestionCard", () => {
  const question: Extract<PendingRequest, { kind: "question" }> = {
    kind: "question",
    id: "r2" as RequestId,
    questions: [
      {
        question: "Which library?",
        header: "Library",
        multiSelect: false,
        options: [
          { label: "date-fns", description: "" },
          { label: "dayjs", description: "" },
        ],
      },
      {
        question: "Which locales?",
        header: "Locales",
        multiSelect: true,
        options: [
          { label: "en-GB", description: "" },
          { label: "nb-NO", description: "" },
        ],
      },
    ],
  };

  it("pages through the questions and collects the answers keyed by question", async () => {
    const { api, respond } = fakeApi();
    render(
      <ApiProvider api={api}>
        <QuestionCard threadId={T} request={question} />
      </ApiProvider>,
    );
    expect(screen.queryByText("Which locales?")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
    expect((screen.getByTestId("question-previous") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("date-fns"));
    fireEvent.click(screen.getByLabelText("dayjs"));
    fireEvent.click(screen.getByTestId("question-next"));
    expect(screen.queryByText("Which library?")).toBeNull();
    const send = screen.getByRole("button", { name: "Send answers" });
    expect((send as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("question-previous"));
    expect((screen.getByLabelText("dayjs") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Locales" }));
    fireEvent.click(screen.getByLabelText("en-GB"));
    fireEvent.click(screen.getByLabelText("nb-NO"));
    fireEvent.change(screen.getByLabelText("Other answer: Which locales?"), {
      target: { value: "de-DE" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));

    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, "r2", {
        kind: "question",
        answers: { "Which library?": ["dayjs"], "Which locales?": ["en-GB", "nb-NO", "de-DE"] },
      }),
    );
  });
  const renderOne = (index: number) => {
    const { api, respond } = fakeApi();
    const one = { ...question, questions: [question.questions[index]!] };
    render(
      <ApiProvider api={api}>
        <QuestionCard threadId={T} request={one} />
      </ApiProvider>,
    );
    return respond;
  };

  it("sends the Other text instead of the picked option on a single-select question", async () => {
    const respond = renderOne(0);
    const other = screen.getByLabelText("Other answer: Which library?");
    const otherRadio = screen.getByRole("radio", { name: "Other" }) as HTMLInputElement;
    const send = screen.getByRole("button", { name: "Send answers" }) as HTMLButtonElement;

    // Focus alone picks Other, and an Other with nothing typed isn't an answer.
    fireEvent.focus(other);
    expect(otherRadio.checked).toBe(true);
    expect(send.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("date-fns"));
    expect(otherRadio.checked).toBe(false);
    fireEvent.change(other, { target: { value: "luxon" } });
    expect(otherRadio.checked).toBe(true);
    expect((screen.getByLabelText("date-fns") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(send);
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, "r2", {
        kind: "question",
        answers: { "Which library?": ["luxon"] },
      }),
    );
  });

  it("keeps the Other text but stops sending it once an option is picked again", async () => {
    const respond = renderOne(0);
    const other = screen.getByLabelText("Other answer: Which library?") as HTMLInputElement;
    fireEvent.change(other, { target: { value: "luxon" } });
    fireEvent.click(screen.getByLabelText("dayjs"));
    expect((screen.getByRole("radio", { name: "Other" }) as HTMLInputElement).checked).toBe(false);
    expect(other.value).toBe("luxon");
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, "r2", {
        kind: "question",
        answers: { "Which library?": ["dayjs"] },
      }),
    );
  });

  it("ticks Other on a multi-select question when typed into, and sends it beside the options", async () => {
    const respond = renderOne(1);
    const otherBox = screen.getByRole("checkbox", { name: "Other" }) as HTMLInputElement;
    const other = screen.getByLabelText("Other answer: Which locales?");
    fireEvent.click(screen.getByLabelText("en-GB"));
    fireEvent.change(other, { target: { value: "de-DE" } });
    expect(otherBox.checked).toBe(true);
    fireEvent.click(otherBox);
    expect(otherBox.checked).toBe(false);
    fireEvent.change(other, { target: { value: "de-AT" } });
    expect(otherBox.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, "r2", {
        kind: "question",
        answers: { "Which locales?": ["en-GB", "de-AT"] },
      }),
    );
  });

  it("steps from the Other field back into the options with the arrow keys", () => {
    renderOne(0);
    fireEvent.click(screen.getByRole("radio", { name: "Other" }));
    const other = screen.getByLabelText("Other answer: Which library?");
    expect(document.activeElement).toBe(other);
    fireEvent.keyDown(other, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByLabelText("dayjs"));
    expect((screen.getByLabelText("dayjs") as HTMLInputElement).checked).toBe(true);
  });
});

describe("PlanCard", () => {
  const plan: Extract<PendingRequest, { kind: "plan" }> = {
    kind: "plan",
    id: "r3" as RequestId,
    plan: "1. Do the thing",
  };

  it("approves with the chosen mode", async () => {
    const { api, respond } = fakeApi();
    render(
      <ApiProvider api={api}>
        <PlanCard threadId={T} request={plan} />
      </ApiProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve…" }));
    fireEvent.click(screen.getByRole("radio", { name: /^Auto/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start in Auto" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, "r3", {
        kind: "plan",
        decision: "approve",
        mode: "auto",
      }),
    );
  });

  it("rejects with a message", async () => {
    const { api, respond } = fakeApi();
    render(
      <ApiProvider api={api}>
        <PlanCard threadId={T} request={plan} />
      </ApiProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reject…" }));
    fireEvent.change(screen.getByLabelText("What should change?"), {
      target: { value: "Smaller steps" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith(T, "r3", {
        kind: "plan",
        decision: "reject",
        message: "Smaller steps",
      }),
    );
  });
});
