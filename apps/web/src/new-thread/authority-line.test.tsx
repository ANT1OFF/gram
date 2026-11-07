// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatAuthorityLine, TaskAuthorityLine, chatAuthority, taskSummary } from "./authority-line";

afterEach(cleanup);

describe("taskSummary", () => {
  it("says where it runs and whom it reports to, and apart from that who approves a merge", () => {
    expect(
      taskSummary({ way: "direct", workspace: "billing-api", autonomy: "publish", hold: false }),
    ).toEqual({
      where: "Runs in billing-api",
      who: "Reports to the billing-api orchestrator",
      approval: "Asks you",
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
      approval: "Asks you",
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
  it("puts ownership and merge approval on separate lines, the approval amber at Full", () => {
    render(<TaskAuthorityLine way="direct" workspace="api" autonomy="full" hold={false} />);
    expect(screen.getByTestId("task-owner").textContent).toBe(
      "Runs in api · Reports to the api orchestrator",
    );
    const merge = screen.getByTestId("task-merge-approval");
    expect(merge.textContent).toBe(
      "Merge approval Automatic · Merges its pull request without asking you.",
    );
    expect(merge.querySelector("span.text-warning")?.textContent).toBe("Automatic");
  });

  it("is calm below Full", () => {
    render(<TaskAuthorityLine way="plan" workspace="api" autonomy="publish" hold={false} />);
    expect(screen.getByTestId("task-owner").textContent).toBe(
      "Runs in api · Planned by the api orchestrator",
    );
    expect(screen.getByTestId("task-merge-approval").textContent).toMatch(
      /^Merge approval Asks you · /,
    );
    expect(screen.getByTestId("task-authority").querySelector(".text-warning")).toBeNull();
  });

  it("opens the controls that change it from the approval's value", () => {
    const onChange = vi.fn();
    render(
      <TaskAuthorityLine
        way="direct"
        workspace="api"
        autonomy="publish"
        hold={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge approval: Asks you. Change" }));
    expect(onChange).toHaveBeenCalledOnce();
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
