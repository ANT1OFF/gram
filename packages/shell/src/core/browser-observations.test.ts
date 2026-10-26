import { describe, expect, it } from "vitest";
import { browserObservations, networkOrigin } from "./browser-observations.ts";
import type { Cdp } from "./page-driver.ts";

describe("bounded browser observations", () => {
  it("omits credentials under arbitrary URL names and every raw console argument", () => {
    const listeners = new Map<string, (p: unknown) => void>();
    const cdp: Cdp = {
      send: async () => ({}),
      on: (event, fn) => {
        listeners.set(event, fn);
        return () => listeners.delete(event);
      },
    };
    const observations = browserObservations(cdp, null);
    const emit = (event: string, p: unknown) => listeners.get(event)!(p);
    for (let i = 0; i < 110; i++)
      emit("Runtime.consoleAPICalled", {
        type: "error",
        args: [{ value: { body: "secret-body", authorization: "opaque-credential" } }],
      });
    for (let i = 0; i < 60; i++) {
      emit("Network.requestWillBeSent", {
        requestId: String(i),
        timestamp: 1,
        request: {
          url: "https://user:password@example.org/opaque-path?anything=secret-query#secret-fragment",
          headers: { Cookie: "secret-cookie" },
          postData: "secret-body",
        },
      });
      emit("Network.responseReceived", {
        requestId: String(i),
        response: { status: 503, headers: { authorization: "secret-header" } },
      });
      emit("Network.loadingFinished", { requestId: String(i), timestamp: 1.125 });
    }
    const result = observations.diagnostics();
    expect(result.console).toHaveLength(100);
    expect(result.network).toHaveLength(50);
    expect(result.droppedConsole).toBe(10);
    expect(result.droppedNetwork).toBe(10);
    expect(result.network[0]).toMatchObject({
      url: "https://example.org",
      status: 503,
      durationMs: 125,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /opaque-|secret-|password|anything|Cookie|authorization|postData/,
    );
    observations.dispose();
    expect(listeners.size).toBe(0);
  });
  it("does not invent elapsed time and drops in-flight/unreadable-page observations", () => {
    const listeners = new Map<string, (p: unknown) => void>();
    const cdp: Cdp = {
      send: async () => ({}),
      on: (event, fn) => {
        listeners.set(event, fn);
        return () => {};
      },
    };
    const observations = browserObservations(cdp, null);
    const emit = (event: string, p: unknown) => listeners.get(event)!(p);
    emit("Network.requestWillBeSent", {
      requestId: "1",
      timestamp: 1,
      request: { url: "file:///private/secret" },
    });
    emit("Network.loadingFailed", { requestId: "1", errorText: "raw secret" });
    expect(observations.diagnostics().network[0]).toMatchObject({
      url: "(URL omitted)",
      kind: "transport",
    });
    expect(observations.diagnostics().network[0]?.durationMs).toBeUndefined();
    emit("Network.requestWillBeSent", {
      requestId: "2",
      timestamp: 1,
      request: { url: "https://example.org" },
    });
    observations.hold(0);
    emit("Network.loadingFailed", { requestId: "2", timestamp: 2 });
    emit("Runtime.consoleAPICalled", { args: [{ value: "private file contents" }] });
    expect(observations.diagnostics().network).toEqual([]);
    expect(observations.console(false)).toEqual([]);
    observations.hold(null);
    emit("Network.loadingFailed", { requestId: "2", timestamp: 3 });
    expect(observations.diagnostics().network).toEqual([]);
    expect(networkOrigin("data:text/plain,secret")).toBe("(URL omitted)");
  });
});
