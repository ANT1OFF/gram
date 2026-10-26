import type { TerminalId, TerminalInfo, ThreadId } from "@gram/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeTerminal,
  openTerminalIn,
  restartTerminal,
  resetTerminals,
  useTerminalsStore,
  type TerminalApi,
} from "./terminals-store";

const T = "t-1" as ThreadId;

/** A terminal API that spawns `term-N` where it is asked to, or in `/launch` when it isn't. */
const fakeApi = (live: TerminalInfo[] = []) => {
  let opened = live.length;
  const terminalOpen = vi.fn(async ({ cwd }: { cwd?: string }) => {
    const info: TerminalInfo = {
      terminalId: `term-${(opened += 1)}` as TerminalId,
      threadId: T,
      // The server reports the resolved path, not the one it was given.
      cwd: cwd === undefined ? "/launch" : `/private${cwd}`,
      shell: "/bin/zsh",
      alive: true,
    };
    live.push(info);
    return info;
  });
  const terminalClose = async (id: TerminalId) => {
    const at = live.findIndex((t) => t.terminalId === id);
    if (at !== -1) live.splice(at, 1);
  };
  const api = {
    terminalOpen,
    terminalClose,
    terminalList: async () => live,
  } as unknown as TerminalApi;
  return { api, terminalOpen };
};

const active = () => useTerminalsStore.getState().byThread[T]?.active;

afterEach(resetTerminals);

describe("openTerminalIn", () => {
  it("opens a new tab in the folder when the thread's terminal started somewhere else", async () => {
    const { api, terminalOpen } = fakeApi([
      {
        terminalId: "term-1" as TerminalId,
        threadId: T,
        cwd: "/launch",
        shell: "zsh",
        alive: true,
      },
    ]);
    const opened = await openTerminalIn(api, T, "/worktree");
    expect(terminalOpen).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/worktree" }));
    expect(active()).toBe(opened);
    expect(useTerminalsStore.getState().byThread[T]?.ids).toEqual(["term-1", opened]);
  });

  it("returns to the terminal already in that folder instead of opening another", async () => {
    const { api, terminalOpen } = fakeApi([
      {
        terminalId: "term-1" as TerminalId,
        threadId: T,
        cwd: "/launch",
        shell: "zsh",
        alive: true,
      },
    ]);
    const first = await openTerminalIn(api, T, "/worktree");
    useTerminalsStore.getState().setActive(T, "term-1" as TerminalId);
    expect(await openTerminalIn(api, T, "/worktree")).toBe(first);
    expect(active()).toBe(first);
    expect(terminalOpen).toHaveBeenCalledTimes(1);

    expect(await openTerminalIn(api, T, "/launch")).toBe("term-1");
    expect(terminalOpen).toHaveBeenCalledTimes(1);
  });

  it("starts a thread's first terminal in the folder, once", async () => {
    const { api, terminalOpen } = fakeApi();
    await openTerminalIn(api, T, "/worktree");
    expect(terminalOpen).toHaveBeenCalledTimes(1);
    expect(terminalOpen).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/worktree" }));
    expect(active()).toBe("term-1");
  });

  it("still finds the folder's terminal after another tab closes", async () => {
    const { api, terminalOpen } = fakeApi([
      {
        terminalId: "term-1" as TerminalId,
        threadId: T,
        cwd: "/launch",
        shell: "zsh",
        alive: true,
      },
    ]);
    const first = await openTerminalIn(api, T, "/worktree");
    await closeTerminal(api, T, "term-1" as TerminalId);
    expect(await openTerminalIn(api, T, "/worktree")).toBe(first);
    expect(terminalOpen).toHaveBeenCalledTimes(1);
  });

  it("restarts a folder's terminal in that folder and keeps finding it", async () => {
    const { api, terminalOpen } = fakeApi([
      {
        terminalId: "term-1" as TerminalId,
        threadId: T,
        cwd: "/launch",
        shell: "zsh",
        alive: true,
      },
    ]);
    const first = await openTerminalIn(api, T, "/worktree");
    await restartTerminal(api, T, first);
    expect(terminalOpen).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "/worktree" }));
    const again = await openTerminalIn(api, T, "/worktree");
    expect(again).not.toBe(first);
    expect(terminalOpen).toHaveBeenCalledTimes(2);
    expect(useTerminalsStore.getState().byThread[T]?.folders).toEqual({ [again]: "/worktree" });
  });
});
