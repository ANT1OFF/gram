// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBindingsStore } from "@/keyboard/bindings-store";
import { installKeyboard } from "@/keyboard/registry";
import { useThreadsStore } from "@/stores/threads";

import { useBackToOrchestrator } from "./worker-header";

// Esc on a worker goes back to its orchestrator, except where Deny is bound to Esc and an approval
// waits: then Esc is Deny's, however the binding spells it.

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<object>()),
  useNavigate: () => navigate,
}));

const WORKER = "t-worker" as ThreadId;
const ORCHESTRATOR = "t-orchestrator" as ThreadId;

function Worker() {
  useBackToOrchestrator(WORKER, true);
  return null;
}

let uninstall: () => void;
beforeEach(() => {
  uninstall = installKeyboard();
  useThreadsStore.setState({
    byId: {
      [WORKER]: {
        thread: { id: WORKER, spawnedBy: { threadId: ORCHESTRATOR } },
        status: "needsApproval",
        pendingRequests: [{ kind: "approval", id: "r1" }],
      },
    } as never,
  });
});
afterEach(() => {
  cleanup();
  uninstall();
  navigate.mockReset();
  useBindingsStore.setState({ overrides: {} });
  useThreadsStore.setState({ byId: {} as never });
});

const pressEsc = () => fireEvent.keyDown(window, { key: "Escape", code: "Escape" });

describe("Esc on a worker with an approval waiting", () => {
  it("goes back while Deny is its default, 3", () => {
    render(<Worker />);
    pressEsc();
    expect(navigate).toHaveBeenCalledWith({
      to: "/t/$threadId",
      params: { threadId: ORCHESTRATOR },
    });
  });

  it.each(["escape", "esc", "Escape", "Esc"])(
    "stays put, the approval's to deny, with Deny bound to %s from mount",
    (keys) => {
      useBindingsStore.setState({ overrides: { "approval.deny": keys } });
      render(<Worker />);
      pressEsc();
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("goes back with Deny bound to Esc once no approval waits", () => {
    useBindingsStore.setState({ overrides: { "approval.deny": "esc" } });
    useThreadsStore.setState({
      byId: {
        [WORKER]: {
          thread: { id: WORKER, spawnedBy: { threadId: ORCHESTRATOR } },
          status: "running",
          pendingRequests: [],
        },
      } as never,
    });
    render(<Worker />);
    pressEsc();
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
