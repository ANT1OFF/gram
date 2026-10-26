// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConnectionMonitor, probeSession } from "@/api/connection";
import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";

import { ConnectionBanner } from "./connection-banner";
import { SessionExpiredScreen } from "./session-expired";

afterEach(cleanup);

const status = (code: number) => vi.fn(async () => new Response(null, { status: code }));
const reply = (code: number, body: string) =>
  vi.fn(async () => new Response(body, { status: code }));

describe("SessionExpiredScreen", () => {
  it("replaces the reconnect banner once the session is rejected", () => {
    const connection = createConnectionMonitor();
    render(
      <ApiProvider api={{ connection } as unknown as Api}>
        <ConnectionBanner />
        <SessionExpiredScreen />
      </ApiProvider>,
    );
    const id = Symbol("feed");
    act(() => connection.failed(id, 1, Date.now() + 1000));
    expect(screen.getByTestId("connection-banner")).toBeTruthy();
    expect(screen.queryByTestId("session-expired")).toBeNull();

    act(() => connection.expire());
    expect(screen.getByTestId("session-expired").textContent).toContain("Session expired");
    expect(screen.queryByTestId("connection-banner")).toBeNull();

    // Later failures and reopened feeds don't bring the app back.
    act(() => connection.opened(id));
    expect(connection.get().status).toBe("expired");
  });
});

describe("ConnectionBanner", () => {
  it("says why the server is unavailable when the probe was told, and reconnects otherwise", () => {
    const connection = createConnectionMonitor();
    render(
      <ApiProvider api={{ connection } as unknown as Api}>
        <ConnectionBanner />
      </ApiProvider>,
    );
    const id = Symbol("feed");
    act(() => connection.failed(id, 1, Date.now() + 1000));
    expect(screen.getByTestId("connection-banner").textContent).toContain("Reconnecting");

    act(() =>
      connection.explain({
        message: "Moving your workspace to a fresh VM…",
        detail: "Saving your work. This takes about a minute.",
      }),
    );
    const banner = screen.getByTestId("connection-banner").textContent;
    expect(banner).toContain("Moving your workspace to a fresh VM…");
    expect(banner).toContain("This takes about a minute.");
    expect(banner).not.toContain("Reconnecting");
  });
});

describe("probeSession", () => {
  it("is rejected for a 401 only; a live session and a network failure aren't rejections", async () => {
    const unauthorized = status(401);
    expect(await probeSession(unauthorized)).toBe("rejected");
    expect(unauthorized).toHaveBeenCalledWith(
      "/?boot=0",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(await probeSession(status(200))).toBe("unknown");
    expect(await probeSession(status(404))).toBe("unknown");
    expect(
      await probeSession(
        vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }),
      ),
    ).toBe("unknown");
  });

  it("reads a 503's message and detail, and nothing from another status or body", async () => {
    const moving = JSON.stringify({
      error: "moving",
      message: "Restarting your workspace…",
      detail: "Saving your work.",
    });
    expect(await probeSession(reply(503, moving))).toEqual({
      message: "Restarting your workspace…",
      detail: "Saving your work.",
    });
    expect(await probeSession(reply(503, '{"error":"no-session","message":"Not yet."}'))).toEqual({
      message: "Not yet.",
    });
    expect(await probeSession(reply(503, "<html>Service Unavailable</html>"))).toBe("unknown");
    expect(await probeSession(reply(503, '{"error":"x"}'))).toBe("unknown");
    expect(await probeSession(reply(502, moving))).toBe("unknown");
  });
});
