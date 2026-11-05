// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ChatAuthorityLine,
  TaskAuthorityLine,
  chatAuthority,
  taskAuthority,
} from "./authority-line";

afterEach(cleanup);

describe("taskAuthority", () => {
  it("says who directs the work, then what the autonomy publishes unasked", () => {
    expect(taskAuthority({ way: "direct", autonomy: "publish", hold: false })).toBe(
      "The orchestrator directs this worker. It pushes and opens a pull request on its own; merging waits for you.",
    );
    expect(taskAuthority({ way: "direct", autonomy: "full", hold: true })).toBe(
      "You direct this worker until you hand it back. It pushes, opens and merges its pull request without asking you.",
    );
    expect(taskAuthority({ way: "plan", autonomy: "supervised", hold: false })).toBe(
      "The orchestrator plans it and briefs workers. Workers ask you before a push, a pull request or a merge.",
    );
  });

  it("holds only a direct worker", () => {
    expect(taskAuthority({ way: "plan", autonomy: "full", hold: true })).toMatch(
      /^The orchestrator plans it/,
    );
  });

  it("falls back to the level's own words for a level this build doesn't know", () => {
    expect(taskAuthority({ way: "direct", autonomy: "someday", hold: false })).toBe(
      "The orchestrator directs this worker. This version of Gram doesn't know this level.",
    );
  });
});

describe("TaskAuthorityLine", () => {
  it("names the level, amber at Full", () => {
    render(<TaskAuthorityLine way="direct" autonomy="full" hold={false} />);
    const line = screen.getByTestId("task-authority");
    expect(line.textContent).toBe(
      "Full autonomy · The orchestrator directs this worker. It pushes, opens and merges its pull request without asking you.",
    );
    expect(line.querySelector("span.text-warning")?.textContent).toBe("Full autonomy");
  });

  it("is calm below Full", () => {
    render(<TaskAuthorityLine way="plan" autonomy="publish" hold={false} />);
    const line = screen.getByTestId("task-authority");
    expect(line.textContent).toMatch(/^Publish autonomy · /);
    expect(line.querySelector(".text-warning")).toBeNull();
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
