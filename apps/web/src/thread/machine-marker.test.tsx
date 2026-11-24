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
  useThreadsStore.setState({ byId: {} });
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

  it("marks a worker sent to a server by the workspace there, and says when it asks or isn't heard", () => {
    const sentTo = {
      origin: "https://gram.example.com",
      server: "Example",
      workspaceId: "w1",
      workspace: "Platform",
      threadId: "t-1",
      at: 1,
      state: "running",
    };
    const sentThread = (over: object) =>
      useThreadsStore.setState({
        byId: {
          [THERE]: {
            thread: {
              id: THERE,
              checkout: { kind: "main", path: "/r" },
              sentTo: { ...sentTo, ...over },
            },
          },
        } as never,
      });
    sentThread({});
    const view = render(<ThreadMachineMarker threadId={THERE} hover="none" />);
    const marker = () => view.getByTestId("machine-marker");
    expect(marker().textContent).toBe("Platform");
    expect(marker().getAttribute("aria-label")).toBe("Runs on Platform · gram.example.com");
    act(() => sentThread({ state: "waiting" }));
    expect(marker().dataset["machineState"]).toBe("asks you");
    act(() => sentThread({ unheard: "Sign in to the server first." }));
    expect(marker().dataset["machineState"]).toBe("signed out");
    act(() => sentThread({ unheard: "The desktop app didn't answer." }));
    expect(marker().dataset["machineState"]).toBe("not heard");
  });
});

describe("a hosted server's worker machine", () => {
  const WORKER = HostId.make("m-fedcba987654321001234567");
  const LOGO = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`;
  const worker = (hosted: NonNullable<MachineState["hosted"]>, online = true): MachineState => ({
    id: WORKER,
    name: "worker-827d7eaf1e",
    kind: "provisioned",
    ...(online ? { onlineSince: 1 } : { offline: { kind: "never" } }),
    hosted,
  });

  it("shows the server's first letter in the machine's place, and names the server", () => {
    useMachines.setState({ machines: [worker({ name: "example cloud" })] });
    const { getByTestId } = render(<MachineMarker hostId={WORKER} hover="title" />);
    const marker = getByTestId("machine-marker");
    expect(marker.textContent).toBe("E");
    expect(getByTestId("hosted-mark").dataset["mark"]).toBe("letter");
    expect(marker.getAttribute("aria-label")).toBe("Runs on example cloud's machine");
    expect(marker.title.split("\n")[0]).toBe("Runs on example cloud's machine");
  });

  it("shows the server's own image where it gave one", () => {
    useMachines.setState({ machines: [worker({ name: "Example Cloud", logo: LOGO })] });
    const { getByTestId } = render(<MachineMarker hostId={WORKER} hover="none" />);
    const mark = getByTestId("hosted-mark");
    expect(mark.tagName).toBe("IMG");
    expect(mark.getAttribute("src")).toBe(LOGO);
    expect(getByTestId("machine-marker").textContent).toBe("");
  });

  it("says offline by the struck glyph and its word, never the machine's id", () => {
    useMachines.setState({ machines: [worker({ name: "Example Cloud", logo: LOGO }, false)] });
    const { getByTestId, queryByTestId } = render(<MachineMarker hostId={WORKER} hover="none" />);
    expect(queryByTestId("hosted-mark")).toBeNull();
    expect(getByTestId("machine-marker").textContent).toBe("offline");
  });
});
