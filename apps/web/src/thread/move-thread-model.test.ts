import type { HostedDeviceView } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { SIGN_IN_FIRST, threadMoveRefusal, threadMoveTargets } from "./move-thread-model";

const workspace = {
  id: "w1",
  name: "Platform",
  organisation: "Example Co",
  policy: "on" as const,
  lending: "off" as const,
  readOnly: false,
  folders: [],
  connected: false,
};
const server = (more: Partial<HostedDeviceView["servers"][number]> = {}) => ({
  origin: "https://gram.example.com",
  name: "Example",
  signedIn: true,
  paused: false,
  takesThreads: true,
  workspaces: [workspace],
  ...more,
});
const plain = {};

describe("moving a thread", () => {
  it("goes only to a server signed in to that takes threads", () => {
    expect(threadMoveTargets({ servers: [server()] }).map((each) => each.workspace)).toEqual([
      "w1",
    ]);
    // A shell or server older than thread moves offers none.
    expect(threadMoveTargets({ servers: [{ ...server(), takesThreads: false }] })).toEqual([]);
    expect(threadMoveTargets({ servers: [server({ signedIn: false })] })).toEqual([]);
  });

  it("is greyed with the reason it can't go", () => {
    expect(threadMoveRefusal(plain, { servers: [server()] })).toBeUndefined();
    expect(threadMoveRefusal(plain, { servers: [] })).toBe(SIGN_IN_FIRST);
    expect(threadMoveRefusal(plain, { servers: [server({ takesThreads: false })] })).toContain(
      "don't take threads",
    );
    // A workspace's thread moves with its workspace, and a moved one from where it went.
    expect(threadMoveRefusal({ workspaceId: "ws" as never }, { servers: [server()] })).toContain(
      "moves with its workspace",
    );
    expect(
      threadMoveRefusal({ transferredTo: { name: "Platform", at: 1 } }, { servers: [server()] }),
    ).toContain("moved to Platform already");
  });
});
