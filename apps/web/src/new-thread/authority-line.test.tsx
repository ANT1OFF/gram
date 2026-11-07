// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { ChatAuthorityLine, TaskAuthorityLine, chatAuthority, taskSummary } from "./authority-line";

afterEach(cleanup);

describe("taskSummary", () => {
  it("says where it runs and whom it reports to, and apart from that who approves a merge", () => {
    expect(
      taskSummary({ way: "direct", workspace: "billing-api", autonomy: "publish", hold: false }),
    ).toEqual({
      where: "Runs in billing-api",
      who: "Reports to the billing-api orchestrator",
      approval: "Ask",
      merge: "Opens its pull request; merging waits for you",
    });
    expect(
      taskSummary({ way: "direct", workspace: "billing-api", autonomy: "full", hold: true }),
    ).toEqual({
      where: "Runs in billing-api",
      who: "You direct it until you hand it to the billing-api orchestrator",
      approval: "Automatic",
      merge: "Merges its pull request without asking you",
    });
    expect(
      taskSummary({ way: "plan", workspace: "api", autonomy: "supervised", hold: false }),
    ).toEqual({
      where: "Runs in api",
      who: "Planned by the api orchestrator",
      approval: "Ask",
      merge: "Asks before a push, a pull request or a merge",
    });
  });

  it("never says supervision and merging in one breath", () => {
    for (const autonomy of ["supervised", "publish", "full"]) {
      const { who } = taskSummary({ way: "direct", workspace: "api", autonomy, hold: false });
      expect(who).toBe("Reports to the api orchestrator");
      expect(who).not.toMatch(/supervis|merge/i);
    }
  });

  it("names the workspace a start makes, and holds only a direct worker", () => {
    const made = taskSummary({
      way: "plan",
      workspace: "api",
      makesOne: true,
      autonomy: "full",
      hold: true,
    });
    expect(made.where).toBe("Runs in a new api workspace");
    expect(made.who).toBe("Planned by the api orchestrator");
    expect(made.approval).toBe("Automatic");
    expect(made.merge).toBe("Merges pull requests without asking you");
  });

  it("falls back to the level's own words for a level this build doesn't know", () => {
    const unknown = taskSummary({
      way: "direct",
      workspace: "api",
      autonomy: "someday",
      hold: false,
    });
    expect(unknown.merge).toBe("This version of Gram doesn't know this level");
  });
});

describe("TaskAuthorityLine", () => {
  it("says where it runs, whom it reports to and merge approval on lines of their own", () => {
    render(
      <TooltipProvider>
        <TaskAuthorityLine
          way="direct"
          workspace="api"
          places={["api", "New worktree, new branch"]}
          autonomy="full"
          hold={false}
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("task-destination").textContent).toBe(
      "Runs in api · api · New worktree, new branch",
    );
    expect(screen.getByTestId("task-owner").textContent).toBe("Reports to the api orchestrator");
    const merge = screen.getByTestId("task-merge-approval");
    expect(merge.textContent).toBe(
      "Merge approvalAutomaticMerges its pull request without asking you.",
    );
    expect(merge.querySelector("span.text-warning")?.textContent).toBe("Automatic");
    expect(screen.queryByTestId("task-destination-remembered")).toBeNull();
  });

  it("is calm below Full", () => {
    render(<TaskAuthorityLine way="plan" workspace="api" autonomy="publish" hold={false} />);
    expect(screen.getByTestId("task-owner").textContent).toBe("Planned by the api orchestrator");
    expect(screen.getByTestId("task-merge-approval").textContent).toMatch(/^Merge approvalAsk/);
    expect(screen.getByTestId("task-authority").querySelector(".text-warning")).toBeNull();
  });

  it("marks a remembered place and changes it in one click", () => {
    const onChangeWhere = vi.fn();
    render(
      <TooltipProvider>
        <TaskAuthorityLine
          way="direct"
          workspace="billing-api"
          autonomy="full"
          hold={false}
          remembered
          onChangeWhere={onChangeWhere}
          changeWhereHint="⌘⇧L"
        />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("task-destination").dataset.remembered).toBe("true");
    expect(screen.getByTestId("task-destination-remembered").textContent).toBe("Remembered");
    fireEvent.click(screen.getByRole("button", { name: "Change where it runs (⌘⇧L)" }));
    expect(onChangeWhere).toHaveBeenCalledOnce();
  });

  it("offers merge approval as Ask or Automatic, named as the workspace's setting", () => {
    const onPick = vi.fn();
    render(
      <TooltipProvider>
        <TaskAuthorityLine
          way="direct"
          workspace="api"
          autonomy="full"
          hold={false}
          approval={{ label: "Merge approval for api, a workspace setting", onPick }}
        />
      </TooltipProvider>,
    );
    // The scope is in words beside the choice, not only on hover.
    expect(screen.getByTestId("task-merge-approval-scope").textContent).toBe(
      "Merge approval for api",
    );
    const group = screen.getByRole("radiogroup", {
      name: "Merge approval for api, a workspace setting",
    });
    const automatic = within(group).getByRole("radio", { name: "Automatic" });
    expect(automatic.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(automatic);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole("radio", { name: "Ask" }));
    expect(onPick).toHaveBeenCalledWith("ask");
  });
});

describe("chat authority", () => {
  it("is the user and one agent, with what the mode asks first", () => {
    expect(chatAuthority("default")).toEqual({
      label: "Ask",
      line: "You direct one agent in this folder, with no orchestrator. Asks before each file edit and command.",
    });
  });

  it("warns at Bypass", () => {
    render(<ChatAuthorityLine mode="bypassPermissions" />);
    const line = screen.getByTestId("chat-authority");
    expect(line.textContent).toMatch(/^Bypass · You direct one agent/);
    expect(line.querySelector("span.text-warning")?.textContent).toBe("Bypass");
  });
});
