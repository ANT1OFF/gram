import type { HostedDeviceView } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import {
  autonomyNote,
  goesLines,
  movedLine,
  moveSteps,
  moveTargets,
  repositoryLine,
  runningNote,
  sentShare,
  sentText,
} from "./move-workspace-model";

const workspace = (id: string, readOnly = false) => ({
  id,
  name: id,
  organisation: "Example Co",
  policy: "on" as const,
  lending: "off" as const,
  readOnly,
  folders: [],
  connected: false,
});

const view = (servers: HostedDeviceView["servers"]): HostedDeviceView => ({ servers });

describe("moveTargets", () => {
  it("lists the workspaces of servers signed in to, by the server's host", () => {
    expect(
      moveTargets(
        view([
          {
            origin: "https://gram.example.com",
            name: "Example",
            signedIn: true,
            paused: false,
            workspaces: [workspace("Platform"), workspace("Audit", true)],
          },
          {
            origin: "https://out.example",
            name: "Out",
            signedIn: false,
            paused: false,
            workspaces: [workspace("Other")],
          },
          {
            origin: "https://held.example",
            name: "Held",
            signedIn: true,
            paused: true,
            workspaces: [workspace("Held")],
          },
        ]),
      ),
    ).toEqual([
      {
        origin: "https://gram.example.com",
        host: "gram.example.com",
        workspace: "Platform",
        name: "Platform",
        organisation: "Example Co",
      },
    ]);
  });

  it("has none without a sign-in", () => {
    expect(moveTargets(null)).toEqual([]);
    expect(moveTargets(undefined)).toEqual([]);
  });
});

describe("what the sheet says before a move", () => {
  it("counts the workers whose history goes", () => {
    expect(goesLines({ workers: 38 }).at(-1)).toBe("The Board's cards and 38 workers' history");
    expect(goesLines({ workers: 1 }).at(-1)).toBe("The Board's cards and 1 worker's history");
    expect(goesLines({ workers: 0 }).at(-1)).toBe("The Board's cards");
  });

  it("says what becomes of workers at work", () => {
    expect(runningNote(0)).toBeUndefined();
    expect(runningNote(2)).toEqual({
      title: "2 workers are running",
      line: "They finish their step, push their branches and stop. The server's orchestrator is told where each got to.",
    });
    expect(runningNote(1)?.title).toBe("1 worker is running");
  });

  it("says when the organisation allows less autonomy, and only then", () => {
    expect(
      autonomyNote(
        "full",
        { ok: true, repositories: [], autonomyCeiling: "publish" },
        "Example Co",
      ),
    ).toEqual({
      title: "Autonomy becomes Publish",
      line: "It is Full here. Example Co allows Publish at most.",
    });
    expect(
      autonomyNote("publish", { ok: true, repositories: [], autonomyCeiling: "publish" }, "X"),
    ).toBeUndefined();
    expect(autonomyNote("full", { ok: true, repositories: [] }, "X")).toBeUndefined();
    expect(autonomyNote("full", undefined, "X")).toBeUndefined();
  });

  it("says of a repository whether the server reaches it", () => {
    expect(repositoryLine(true, "Example Co")).toBe("The server reaches it");
    expect(repositoryLine(false, "Example Co")).toBe(
      "Not in Example Co's GitHub access there. The workspace moves without it.",
    );
  });
});

describe("a move under way", () => {
  const MB = 1024 * 1024;

  it("says how much the server has", () => {
    expect(sentText({ stage: "sending", sentBytes: 31 * MB, totalBytes: 50 * MB })).toBe(
      "31 MB of 50 MB",
    );
    expect(sentText({ stage: "sending" })).toBeUndefined();
    expect(sentText({ stage: "stopping" })).toBeUndefined();
    expect(sentShare({ stage: "sending", sentBytes: 25, totalBytes: 50 })).toBe(0.5);
    expect(sentShare({ stage: "settingUp" })).toBe(1);
    expect(sentShare(undefined)).toBe(0);
  });

  it("marks each step done, under way or to come", () => {
    expect(moveSteps(undefined, 2).map((step) => [step.words, step.state])).toEqual([
      ["Stopping 2 workers", "now"],
      ["Sending the workspace", "next"],
      ["The server sets it up and its orchestrator reads in", "next"],
    ]);
    expect(moveSteps({ stage: "sending" }, 2).map((step) => [step.words, step.state])).toEqual([
      ["Workers stopped, 2 branches pushed", "done"],
      ["Sending the workspace", "now"],
      ["The server sets it up and its orchestrator reads in", "next"],
    ]);
    expect(moveSteps({ stage: "settingUp" }, 0).map((step) => step.state)).toEqual([
      "done",
      "done",
      "now",
    ]);
    expect(moveSteps({ stage: "sending" }, 0)[0]?.words).toBe("Workspace paused here");
  });
});

describe("movedLine", () => {
  const at = Date.UTC(2026, 10, 13, 9, 48);

  it("says where and when, on a 24-hour clock, and what did not come", () => {
    expect(
      movedLine(
        {
          ok: true,
          movedAt: at,
          left: ["2 worktrees with uncommitted changes", "example-co/fixtures"],
        },
        { host: "gram.example.com" },
        { timeZone: "UTC" },
      ),
    ).toBe(
      "Moved to gram.example.com at 09:48. Its orchestrator there has the conversation, memory and Board, and was told what didn't come: 2 worktrees with uncommitted changes and example-co/fixtures.",
    );
    expect(
      movedLine({ ok: true, movedAt: at, left: [] }, { host: "h.example" }, { timeZone: "UTC" }),
    ).toBe(
      "Moved to h.example at 09:48. Its orchestrator there has the conversation, memory and Board.",
    );
  });
});
