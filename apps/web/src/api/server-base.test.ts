import { afterEach, describe, expect, it } from "vitest";

import { serverBaseOf, serverUrl, setServerBase, socketUrl } from "./server-base";

afterEach(() => setServerBase(undefined));

const page = { protocol: "https:", host: "app.example" };

describe("the server's base", () => {
  it("is the page's own origin unless one is set", () => {
    expect(serverUrl("/machines/join")).toBe("/machines/join");
    expect(serverUrl("/?boot=0")).toBe("/?boot=0");
    expect(socketUrl(page)).toBe("wss://app.example/ws");
    expect(socketUrl({ protocol: "http:", host: "127.0.0.1:5173" })).toBe("ws://127.0.0.1:5173/ws");
  });

  it("puts the socket and every HTTP call under a path", () => {
    setServerBase("/cells/acme");
    expect(serverUrl("/machines/join")).toBe("/cells/acme/machines/join");
    expect(serverUrl("/?boot=0")).toBe("/cells/acme/?boot=0");
    expect(socketUrl(page)).toBe("wss://app.example/cells/acme/ws");
  });

  it("takes a whole URL, and dials its socket there", () => {
    setServerBase("https://cells.example/acme/");
    expect(serverUrl("/remote/status")).toBe("https://cells.example/acme/remote/status");
    expect(socketUrl(page)).toBe("wss://cells.example/acme/ws");
    setServerBase("http://127.0.0.1:4000");
    expect(socketUrl(page)).toBe("ws://127.0.0.1:4000/ws");
  });

  it("refuses what isn't a path or an http(s) URL", () => {
    expect(serverBaseOf(undefined)).toBe("/");
    expect(serverBaseOf("/")).toBe("/");
    expect(() => serverBaseOf("cells/acme")).toThrow(/path or an http/);
    expect(() => serverBaseOf("//cells.example/acme")).toThrow(/scheme/);
    expect(() => serverBaseOf("javascript:alert(1)")).toThrow(/path or an http/);
    expect(() => serverBaseOf("/cells/acme?x=1")).toThrow(/query/);
  });
});
