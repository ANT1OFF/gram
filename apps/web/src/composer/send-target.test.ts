import { describe, expect, it } from "vitest";

import { type SendCheck, sendCheckRows, sendTargetsOf } from "./send-target";

const target = {
  origin: "https://gram.example.com",
  server: "Example",
  host: "gram.example.com",
  workspaceId: "w1",
  workspace: "Platform",
  organisation: "Example Co",
};

const clean: SendCheck = {
  repository: "example/app",
  orchestrator: true,
  local: {
    current: "main",
    base: { branch: "main", sha: "4be1c09" },
    ahead: 0,
    uncommitted: { count: 0 },
  },
  reach: { reach: "yes" },
};

const states = (check: SendCheck) =>
  Object.fromEntries(
    sendCheckRows(check, target, "this computer").map((row) => [row.id, row.state]),
  );

const server = (over: object) => ({
  origin: "https://a.example.com",
  name: "A",
  signedIn: true,
  paused: false,
  runsWork: true,
  workspaces: [
    {
      id: "w1",
      name: "One",
      organisation: "Org",
      policy: "on" as const,
      lending: "off" as const,
      readOnly: false,
      folders: [],
      connected: false,
    },
  ],
  ...over,
});

describe("New task's checks before it sends a task to a server", () => {
  it("lets a pushed, reachable repository go, and only warns of what stays here", () => {
    expect(states(clean)).toEqual({ reach: "ok", base: "ok" });
    expect(
      states({
        ...clean,
        reach: { reach: "unknown" },
        local: {
          ...clean.local,
          current: "feat/x",
          ahead: 2,
          uncommitted: { count: 3, first: "a.ts" },
        },
      }),
    ).toEqual({ reach: "warn", base: "warn", uncommitted: "warn" });
  });

  it("says nothing of a reach the server couldn't be asked, and never stops the send for it", () => {
    const { reach: _reach, ...unasked } = clean;
    expect(states(unasked)).toEqual({ base: "ok" });
  });

  it("says a send starts the person's machine there only when the server offers it and it's down", () => {
    expect(states({ ...clean, machine: { phase: "none" } }).machine).toBe("ok");
    expect(states({ ...clean, machine: { phase: "running", starting: true } }).machine).toBe("ok");
    expect(states({ ...clean, machine: { phase: "running" } }).machine).toBeUndefined();
    expect(states({ ...clean, machine: "unoffered" }).machine).toBeUndefined();
  });

  it("blocks what the server couldn't start from, or report back", () => {
    expect(states({ ...clean, reach: { reach: "no", reason: "No access." } }).reach).toBe("block");
    expect(states({ orchestrator: true, local: clean.local }).reach).toBe("block");
    expect(states({ ...clean, local: { ...clean.local, ahead: 1 } }).base).toBe("block");
    expect(states({ ...clean, local: { ahead: 0, uncommitted: { count: 0 } } }).base).toBe("block");
    expect(states({ ...clean, orchestrator: false }).orchestrator).toBe("block");
  });

  it("offers only workspaces of servers signed in to, not paused, that run sent work", () => {
    expect(
      sendTargetsOf({
        servers: [
          server({}),
          server({ paused: true }),
          server({ signedIn: false }),
          server({ runsWork: undefined }),
        ],
      }).map((each) => each.workspaceId),
    ).toEqual(["w1"]);
  });
});
