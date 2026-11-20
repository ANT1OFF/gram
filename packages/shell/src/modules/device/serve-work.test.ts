import { describe, expect, it } from "vitest";

import type { HostedDevice, HostedServerState } from "./hosted-device.ts";
import { answerSentWork, serveSentWorkMessage } from "./serve-work.ts";

const server = (over: Partial<HostedServerState>): HostedServerState => ({
  origin: "https://a.example.com",
  name: "A",
  signedIn: true,
  paused: false,
  takesThreads: true,
  givesThreads: true,
  runsWork: true,
  workspaces: [
    {
      id: "w1",
      name: "Platform",
      organisation: "Example Co",
      policy: undefined as never,
      lending: "off",
      readOnly: false,
      folders: [],
      connected: false,
    },
  ],
  ...over,
});

/** A device that records what it was asked to do. */
const deviceOf = (servers: ReadonlyArray<HostedServerState>) => {
  const calls: Array<{ op: string; args: ReadonlyArray<unknown> }> = [];
  const record =
    (op: string) =>
    async (...args: ReadonlyArray<unknown>) => {
      calls.push({ op, args });
      if (op === "sendWork") return { ok: true, threadId: "t-1" };
      if (op === "messageWork") return { ok: true, queued: false };
      return { ok: true };
    };
  const device = {
    state: () => ({ servers }),
    sendWork: record("sendWork"),
    checkWork: record("checkWork"),
    waitWork: record("waitWork"),
    messageWork: record("messageWork"),
    stopWork: record("stopWork"),
    machineWork: record("machineWork"),
  } as unknown as HostedDevice;
  return { device, calls };
};

const send = {
  type: "work.request",
  id: "r1",
  op: "send",
  origin: "https://a.example.com",
  workspaceId: "w1",
  work: { repositories: ["acme/shop"], text: "Do it.", clientKey: "k1" },
};

describe("the app answering its server's sent work", () => {
  it("lists only servers signed in to, not paused, that run work", async () => {
    const { device } = deviceOf([
      server({}),
      server({ origin: "https://b.example.com", paused: true }),
      server({ origin: "https://c.example.com", signedIn: false }),
      server({ origin: "https://d.example.com", runsWork: false }),
    ]);
    const answer = await answerSentWork({ type: "work.request", id: "r0", op: "targets" }, device);
    expect(answer?.result).toEqual({
      ok: true,
      targets: [
        {
          origin: "https://a.example.com",
          server: "A",
          workspaceId: "w1",
          workspace: "Platform",
          organisation: "Example Co",
        },
      ],
    });
  });

  it("sends a well-formed request, and refuses one that isn't without calling out", async () => {
    const { device, calls } = deviceOf([server({})]);
    expect((await answerSentWork(send, device))?.result).toEqual({ ok: true, threadId: "t-1" });
    expect(calls).toHaveLength(1);
    for (const bad of [
      { ...send, work: { ...send.work, repositories: ["-x\nrm"] } },
      { ...send, work: { ...send.work, clientKey: "has space" } },
      { ...send, origin: undefined },
      { ...send, op: "stop", threadId: "../other" },
      { ...send, op: "message", threadId: "t-1", text: "", clientKey: "k" },
      { ...send, op: "delete" },
      { ...send, op: "check", repositories: ["-x\nrm"] },
      { ...send, op: "check", repositories: [] },
      // A machine is read or started, never stopped or anything else.
      { ...send, op: "machine", action: "stop" },
      { ...send, op: "machine" },
    ]) {
      expect((await answerSentWork(bad, device))?.result.ok).toBe(false);
    }
    expect(calls).toHaveLength(1);
    await answerSentWork({ ...send, op: "check", repositories: ["acme/shop"] }, device);
    expect(calls.at(-1)).toEqual({
      op: "checkWork",
      args: ["https://a.example.com", "w1", ["acme/shop"]],
    });
    await answerSentWork({ ...send, op: "machine", action: "start" }, device);
    expect(calls.at(-1)).toEqual({
      op: "machineWork",
      args: ["https://a.example.com", "w1", "start"],
    });
  });

  it("answers no other message, and answers when the call throws", async () => {
    const { device } = deviceOf([server({})]);
    expect(await answerSentWork({ type: "pane.request", id: "x" }, device)).toBeUndefined();
    const broken = { ...device, stopWork: () => Promise.reject(new Error("boom")) } as HostedDevice;
    const replied = await new Promise<unknown>((resolve) =>
      serveSentWorkMessage({ ...send, op: "stop", threadId: "t-1" }, broken, resolve),
    );
    expect(replied).toMatchObject({ type: "work.response", id: "r1", result: { ok: false } });
    expect((await answerSentWork(send, undefined))?.result.ok).toBe(false);
  });
});
