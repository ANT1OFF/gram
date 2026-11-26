// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useBindingsStore } from "@/keyboard/bindings-store";
import { installKeyboard } from "@/keyboard/registry";
import { renderInRouter } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { useBackToOrchestrator } from "./worker-header";

// Esc on a worker goes back to its orchestrator, except where Deny is bound to Esc and an approval
// waits: then Esc is Deny's, however the binding spells it.

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
  useBindingsStore.setState({ overrides: {} });
  useThreadsStore.setState({ byId: {} });
});

const pressEsc = () => fireEvent.keyDown(window, { key: "Escape", code: "Escape" });

describe("Esc on a worker with an approval waiting", () => {
  it("goes back while Deny is its default, 3", async () => {
    const { router } = await renderInRouter(<Worker />);
    pressEsc();
    expect(router.state.location.pathname).toBe(`/t/${ORCHESTRATOR}`);
  });

  it.each(["escape", "esc", "Escape", "Esc"])(
    "stays put, the approval's to deny, with Deny bound to %s from mount",
    async (keys) => {
      useBindingsStore.setState({ overrides: { "approval.deny": keys } });
      const { router } = await renderInRouter(<Worker />);
      pressEsc();
      expect(router.state.location.pathname).toBe("/");
    },
  );

  it("goes back with Deny bound to Esc once no approval waits", async () => {
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
    const { router } = await renderInRouter(<Worker />);
    pressEsc();
    expect(router.state.location.pathname).toBe(`/t/${ORCHESTRATOR}`);
    // Once: the one entry it started on, and the orchestrator's.
    expect(router.history.length).toBe(2);
  });
});
