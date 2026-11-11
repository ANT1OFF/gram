// @vitest-environment happy-dom
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  type DesktopBridge,
  type HostedDeviceActivity,
  type HostedDeviceView,
} from "@gram/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useServerSettings } from "@/settings-sync/store";

import { HostedDeviceSection } from "./hosted-device-section";

const ORIGIN = "https://hosted.example";
const view = (lending: "off" | "on" | "resume", paused = false): HostedDeviceView => ({
  servers: [
    {
      origin: ORIGIN,
      name: "Example",
      signedIn: true,
      paused,
      workspaces: [
        {
          id: "w1",
          name: "Platform",
          organisation: "Example Org",
          policy: "on",
          lending,
          readOnly: false,
          folders: lending === "off" ? [] : [{ id: "f-1", label: "app", path: "/work/app" }],
          connected: false,
        },
      ],
    },
  ],
});

type Bridge = NonNullable<DesktopBridge["hostedDevice"]>;
const ok = async () => ({ ok: true as const });
const bridgeWith = (state: HostedDeviceView | null): Bridge & { calls: Array<string> } => {
  const calls: Array<string> = [];
  return {
    calls,
    state: async () => state,
    signIn: async (server) => {
      calls.push(`signIn ${server}`);
      return { ok: false, why: "Gram couldn't reach this server." };
    },
    signOut: async (origin) => {
      calls.push(`signOut ${origin}`);
    },
    refresh: ok,
    lend: async (origin, workspace) => {
      calls.push(`lend ${origin} ${workspace}`);
      return { ok: false, why: "Cancelled." };
    },
    resume: async (origin, workspace) => {
      calls.push(`resume ${origin} ${workspace}`);
      return ok();
    },
    stop: async (origin, workspace) => {
      calls.push(`stop ${origin} ${workspace}`);
    },
    liftPause: async (origin) => {
      calls.push(`liftPause ${origin}`);
      return ok();
    },
    startAfresh: ok,
    activity: async () => activity,
    onChange: () => () => undefined,
  };
};

let activity: HostedDeviceActivity | null = {
  kept: true,
  intact: true,
  setAside: false,
  entries: [],
  more: false,
};

const withHosted = (on: boolean, bridge: Bridge | undefined) => {
  useServerSettings.setState({
    settings: applySettingsPatch(DEFAULT_SETTINGS, { experimental: { embedding: on } }),
  });
  const target = window as { gram?: Partial<DesktopBridge> };
  if (bridge === undefined) delete target.gram;
  else target.gram = { platform: "darwin", hostedDevice: bridge };
};

afterEach(() => {
  cleanup();
  delete (window as { gram?: unknown }).gram;
  vi.restoreAllMocks();
});

describe("Settings → Machines → lending this computer", () => {
  it("shows nothing with hosted features off, or outside the desktop app", () => {
    withHosted(false, bridgeWith(view("off")));
    const { container, rerender } = render(<HostedDeviceSection />);
    expect(container.innerHTML).toBe("");
    withHosted(true, undefined);
    rerender(<HostedDeviceSection />);
    expect(container.innerHTML).toBe("");
  });

  it("opens the app's own decision to lend, and says why a sign-in failed", async () => {
    const bridge = bridgeWith(view("off"));
    withHosted(true, bridge);
    render(<HostedDeviceSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Lend this Mac…" }));
    await waitFor(() => expect(bridge.calls).toEqual([`lend ${ORIGIN} w1`]));
    // A cancelled decision says nothing.
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Server address"), {
      target: { value: "gram.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Gram couldn't reach this server.",
    );
  });

  it("offers resume and stop for what was lent, and lifting a pause", async () => {
    const bridge = bridgeWith(view("resume", true));
    withHosted(true, bridge);
    render(<HostedDeviceSection />);
    expect(await screen.findByText("/work/app")).toBeTruthy();
    for (const [name, call] of [
      ["Resume lending…", `resume ${ORIGIN} w1`],
      ["Stop lending", `stop ${ORIGIN} w1`],
      ["Lift the pause…", `liftPause ${ORIGIN}`],
    ] as const) {
      const button = screen.getByRole("button", { name });
      await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(button);
      await waitFor(() => expect(bridge.calls).toContain(call));
    }
  });

  it("lists what was asked here, its hidden codes as codes, and says when the record was edited", async () => {
    activity = {
      kept: true,
      intact: false,
      setAside: false,
      more: false,
      entries: [
        {
          time: Date.now(),
          origin: ORIGIN,
          workspace: "w1",
          threadTitle: "Fix the seed\u202e",
          folder: "/work/app",
          kind: "exec",
          what: "bun install\nrm -rf /",
          answer: "allowed",
          exitCode: 0,
        },
        {
          time: Date.now(),
          origin: ORIGIN,
          workspace: "w1",
          threadTitle: "Tidy \\u202e",
          folder: "/work/app",
          kind: "read",
          what: "/work/app/.env",
          answer: "credential-path",
        },
      ],
    };
    withHosted(true, bridgeWith(view("on")));
    render(<HostedDeviceSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Show" }));
    const rows = await screen.findAllByTestId("activity-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Platform · Fix the seed\\u202e"),
      expect.stringContaining(
        "Tidy \\u202e/work/appread /work/app/.envGram refusedholds credentials",
      ),
    ]);
    expect(rows[0]?.textContent).toContain("bun install⏎rm -rf /");
    expect(rows[0]?.textContent).toContain("You allowed itexit 0");
    expect(rows[0]?.textContent).not.toContain("\u202e");
    // The codes are set apart from the text, so typing them out can't pass for them.
    expect(
      [...(rows[0]?.querySelectorAll("[data-drawn]") ?? [])].map((span) => span.textContent),
    ).toEqual(["\\u202e", "⏎"]);
    expect(rows[1]?.querySelectorAll("[data-drawn]")).toHaveLength(0);
    expect(screen.getByTestId("activity-edited").textContent).toContain("changed outside Gram");
  });

  it("says when nothing has been asked, or no record is kept", async () => {
    activity = { kept: true, intact: true, setAside: false, entries: [], more: false };
    withHosted(true, bridgeWith(view("on")));
    const { unmount } = render(<HostedDeviceSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Show" }));
    expect((await screen.findByTestId("hosted-activity")).textContent).toContain(
      "Nothing has been asked of this Mac",
    );
    unmount();
    activity = { kept: false, intact: true, setAside: false, entries: [], more: false };
    render(<HostedDeviceSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Show" }));
    await waitFor(() =>
      expect(screen.getByTestId("hosted-activity").textContent).toContain("No record is kept"),
    );
  });

  it("says why lending isn't available", async () => {
    withHosted(true, bridgeWith({ unavailable: "no-keyring", servers: [] }));
    render(<HostedDeviceSection />);
    expect((await screen.findByTestId("hosted-unavailable")).textContent).toContain(
      "no system keyring",
    );
  });
});
