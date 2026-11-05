// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatAuthorityLine, TaskAuthorityLine, chatAuthority, taskSummary } from "./authority-line";

afterEach(cleanup);

describe("taskSummary", () => {
  it("says where it runs, which orchestrator supervises it and whether it may merge", () => {
    expect(
      taskSummary({ way: "direct", workspace: "billing-api", autonomy: "publish", hold: false }),
    ).toEqual({
      where: "Runs in billing-api",
      who: "Supervised by the billing-api orchestrator",
      merge: "Opens its pull request; merging waits for you",
    });
    expect(
      taskSummary({ way: "direct", workspace: "billing-api", autonomy: "full", hold: true }),
    ).toEqual({
      where: "Runs in billing-api",
      who: "You direct it until you hand it to the billing-api orchestrator",
      merge: "Merges its pull request without asking you",
    });
    expect(
      taskSummary({ way: "plan", workspace: "api", autonomy: "supervised", hold: false }),
    ).toEqual({
      where: "Runs in api",
      who: "Planned by the api orchestrator",
      merge: "Asks you before a push, a pull request or a merge",
    });
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
    expect(made.merge).toBe("Merges pull requests without asking you");
  });

  it("falls back to the level's own words for a level this build doesn't know", () => {
    expect(
      taskSummary({ way: "direct", workspace: "api", autonomy: "someday", hold: false }).merge,
    ).toBe("This version of Gram doesn't know this level");
  });
});

describe("TaskAuthorityLine", () => {
  it("is one line, the merge part amber at Full", () => {
    render(<TaskAuthorityLine way="direct" workspace="api" autonomy="full" hold={false} />);
    const line = screen.getByTestId("task-authority");
    expect(line.textContent).toBe(
      "Runs in api · Supervised by the api orchestrator · Merges its pull request without asking you.",
    );
    expect(line.querySelector("span.text-warning")?.textContent).toBe(
      "Merges its pull request without asking you",
    );
  });

  it("is calm below Full", () => {
    render(<TaskAuthorityLine way="plan" workspace="api" autonomy="publish" hold={false} />);
    const line = screen.getByTestId("task-authority");
    expect(line.textContent).toMatch(/^Runs in api · Planned by the api orchestrator · /);
    expect(line.querySelector(".text-warning")).toBeNull();
  });

  it("opens the controls that change it from its merge part", () => {
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
    fireEvent.click(screen.getByRole("button", { name: /merging waits for you/ }));
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
