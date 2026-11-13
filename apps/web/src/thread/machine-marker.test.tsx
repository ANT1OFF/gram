// @vitest-environment happy-dom
import { HostId, type MachineState, type ThreadId } from "@gram/contracts";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useMachines } from "@/stores/machines";
import { useThreadsStore } from "@/stores/threads";

import { MachineMarker, ThreadMachineMarker } from "./machine-marker";

const ATLAS = HostId.make("m-0123456789abcdef01234567");
const STUDIO = HostId.make("m-89abcdef0123456701234567");
const HERE = "t-here" as ThreadId;
const THERE = "t-there" as ThreadId;

const machines: ReadonlyArray<MachineState> = [
  { id: ATLAS, name: "atlas", kind: "joined", onlineSince: 1 },
  { id: STUDIO, name: "studio", kind: "joined", offline: { kind: "never" } },
];

afterEach(() => {
  cleanup();
  useMachines.setState({ machines: undefined });
  useThreadsStore.setState({ byId: {} as never });
});

describe("a thread's machine marker", () => {
  it("shows nothing for a thread on this machine", () => {
    useMachines.setState({ machines });
    useThreadsStore.setState({
      byId: {
        [HERE]: { thread: { id: HERE, checkout: { kind: "worktree", path: "/w" } } },
      } as never,
    });
    const { container } = render(<ThreadMachineMarker threadId={HERE} hover="none" />);
    expect(container.innerHTML).toBe("");
  });

  it("names the machine a thread runs on, from the thread's own checkout", () => {
    useMachines.setState({ machines });
    useThreadsStore.setState({
      byId: {
        [THERE]: {
          thread: { id: THERE, checkout: { kind: "worktree", path: "/w", hostId: ATLAS } },
        },
      } as never,
    });
    const { getByTestId } = render(<ThreadMachineMarker threadId={THERE} hover="none" />);
    const marker = getByTestId("machine-marker");
    expect(marker.textContent).toBe("atlas");
    expect(marker.dataset["machineState"]).toBe("online");
    expect(marker.getAttribute("aria-label")).toBe("Runs on atlas");
  });

  it("says offline in words beside the name, and by its glyph alone beside a row's own words", () => {
    useMachines.setState({ machines });
    const named = render(<MachineMarker hostId={STUDIO} hover="title" />);
    const marker = named.getByTestId("machine-marker");
    expect(marker.textContent).toBe("studiooffline");
    expect(marker.dataset["machineState"]).toBe("offline");
    expect(marker.getAttribute("title")).toBe(
      "Runs on studio\nJoined machine · offline\nIt hasn't dialled in since Gram started.\nCheck gram-host status on studio.",
    );
    named.unmount();

    const glyph = render(<MachineMarker hostId={STUDIO} show="glyph" hover="none" />);
    const alone = glyph.getByTestId("machine-marker");
    expect(alone.textContent).toBe("");
    // The glyph alone still tells the two states apart, to the eye and to a screen reader.
    expect(alone.dataset["machineState"]).toBe("offline");
    expect(alone.getAttribute("aria-label")).toBe("Runs on studio, offline");
    expect(alone.querySelector("svg")?.classList.contains("lucide-server-off")).toBe(true);
  });

  it("follows the machines as the server sends them", () => {
    useMachines.setState({ machines });
    const { getByTestId } = render(<MachineMarker hostId={ATLAS} hover="none" />);
    expect(getByTestId("machine-marker").dataset["machineState"]).toBe("online");
    act(() =>
      useMachines
        .getState()
        .replace([{ id: ATLAS, name: "atlas", kind: "joined", offline: { kind: "lost", at: 2 } }]),
    );
    expect(getByTestId("machine-marker").dataset["machineState"]).toBe("offline");
    expect(getByTestId("machine-marker").textContent).toBe("atlasoffline");
    // Removed from this Gram: its threads say so rather than name a machine that isn't there.
    act(() => useMachines.getState().replace([]));
    expect(getByTestId("machine-marker").textContent).toBe("not joined");
  });
});
