import { WORKSPACE_MACHINE_NOT_RUNNING } from "@gram/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { onItsMachine, startWorkspaceMachine } from "./workspace-machine";

afterEach(() => vi.unstubAllGlobals());

describe("a workspace's own machine", () => {
  it("is started, and the orchestrator opened again, only when that is what it lacked", async () => {
    const start = vi.fn(async () => {});
    let tries = 0;
    const open = vi.fn(async () => {
      tries += 1;
      if (tries === 1) throw new Error(`${WORKSPACE_MACHINE_NOT_RUNNING}. Start it.`);
      return "t-1";
    });
    expect(await onItsMachine("w-1", open, start)).toBe("t-1");
    expect(start).toHaveBeenCalledWith("w-1");
    expect(open).toHaveBeenCalledTimes(2);

    const other = vi.fn(async () => {
      throw new Error("Workspace already has an orchestrator");
    });
    await expect(onItsMachine("w-1", other, start)).rejects.toThrow("already has");
    // Without a workspace to start it for, the refusal stands.
    const refused = vi.fn(async () => {
      throw new Error(WORKSPACE_MACHINE_NOT_RUNNING);
    });
    await expect(onItsMachine(undefined, refused, start)).rejects.toThrow();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("starts it as the person, and waits for that workspace's machine, not theirs", async () => {
    const calls: string[] = [];
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)} ${String(init?.body ?? "")}`);
        if (init?.method === "POST") return Response.json({ progress: { phase: "starting" } });
        reads += 1;
        return Response.json(
          reads < 2
            ? { available: true, progress: { hostKey: "k", phase: "booting", at: 1 } }
            : { available: true, machine: { id: "h-1", name: "workspace-x", online: true } },
        );
      }),
    );
    await startWorkspaceMachine("w-1", async () => {});
    expect(calls).toEqual([
      expect.stringMatching(/^POST .*\/machines\/on-demand\/start \{"workspace":"w-1"/),
      expect.stringMatching(/^GET .*\/machines\/on-demand\/status\?workspace=w-1 $/),
      expect.stringMatching(/^GET .*\/machines\/on-demand\/status\?workspace=w-1 $/),
    ]);
  });

  it("says why when its start failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({})
          : Response.json({
              available: true,
              progress: { hostKey: "k", phase: "failed", message: "No room.", at: 1 },
            }),
      ),
    );
    await expect(startWorkspaceMachine("w-1", async () => {})).rejects.toThrow("No room.");
  });
});
