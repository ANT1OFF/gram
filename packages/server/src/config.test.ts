import { describe, expect, it } from "vitest";

import { appLabelOf, ServerConfig } from "./config.ts";

describe("ServerConfig.fromEnv", () => {
  it("keeps remote access off by default and validates the explicit origin", () => {
    expect(ServerConfig.fromEnv({})).not.toHaveProperty("remoteOrigin");
    expect(
      ServerConfig.fromEnv({ GRAM_REMOTE_ORIGIN: "https://device.tail123.ts.net:9443" })
        .remoteOrigin,
    ).toBe("https://device.tail123.ts.net:9443");
    expect(() => ServerConfig.fromEnv({ GRAM_REMOTE_ORIGIN: "" })).toThrow("GRAM_REMOTE_ORIGIN");
  });

  it("listens beyond loopback only inside a container, and only on all interfaces", () => {
    expect(ServerConfig.fromEnv({})).not.toHaveProperty("listenHost");
    expect(ServerConfig.fromEnv({ GRAM_LISTEN_HOST: "0.0.0.0" })).not.toHaveProperty("listenHost");
    expect(
      ServerConfig.fromEnv({ GRAM_CONTAINER: "1", GRAM_LISTEN_HOST: "0.0.0.0" }).listenHost,
    ).toBe("0.0.0.0");
    expect(
      ServerConfig.fromEnv({ GRAM_CONTAINER: "1", GRAM_LISTEN_HOST: "192.168.1.5" }),
    ).not.toHaveProperty("listenHost");
  });

  it("takes the hosted features setting from GRAM_EMBEDDING only as 1 or 0", () => {
    expect(ServerConfig.fromEnv({ GRAM_EMBEDDING: "1" }).embedding).toBe(true);
    expect(ServerConfig.fromEnv({ GRAM_EMBEDDING: "0" }).embedding).toBe(false);
    expect(ServerConfig.fromEnv({ GRAM_EMBEDDING: "true" })).not.toHaveProperty("embedding");
    expect(ServerConfig.fromEnv({})).not.toHaveProperty("embedding");
  });

  it("takes the hook's and the sink's token from a file named from the root, never with a token", () => {
    const hook = "https://hooks.example.test/decide";
    expect(
      ServerConfig.fromEnv({
        GRAM_DECISION_HOOK_URL: hook,
        GRAM_DECISION_HOOK_TOKEN_FILE: "/var/run/tokens/hook",
      }).decisionHook,
    ).toEqual({ url: hook, tokenFile: "/var/run/tokens/hook" });
    expect(
      ServerConfig.fromEnv({
        GRAM_EVENT_SINK_URL: "https://sink.example.test/events",
        GRAM_EVENT_SINK_TOKEN_FILE: "tokens/sink",
      }).eventSink,
    ).toBe("unusable");
    expect(
      ServerConfig.fromEnv({
        GRAM_DECISION_HOOK_URL: hook,
        GRAM_DECISION_HOOK_TOKEN: "abc",
        GRAM_DECISION_HOOK_TOKEN_FILE: "/var/run/tokens/hook",
      }).decisionHook,
    ).toBe("unusable");
  });

  it("sends the sink messages only for GRAM_EVENT_SINK_MESSAGES=1", () => {
    const sink = { GRAM_EVENT_SINK_URL: "https://sink.example.test/events" };
    expect(ServerConfig.fromEnv(sink).eventSinkMessages).toBeUndefined();
    expect("eventSinkMessages" in ServerConfig.fromEnv(sink)).toBe(false);
    expect(
      ServerConfig.fromEnv({ ...sink, GRAM_EVENT_SINK_MESSAGES: "true" }).eventSinkMessages,
    ).toBeUndefined();
    expect(ServerConfig.fromEnv({ ...sink, GRAM_EVENT_SINK_MESSAGES: "1" }).eventSinkMessages).toBe(
      true,
    );
  });

  it("is headless only for GRAM_HEADLESS=1", () => {
    expect(ServerConfig.fromEnv({ GRAM_HEADLESS: "1" }).headless).toBe(true);
    expect(ServerConfig.fromEnv({ GRAM_HEADLESS: "0" })).not.toHaveProperty("headless");
    expect(ServerConfig.fromEnv({})).not.toHaveProperty("headless");
  });

  it("flags the fake agent only for GRAM_FAKE_AGENT=1", () => {
    expect(ServerConfig.fromEnv({ GRAM_FAKE_AGENT: "1" }).fakeAgent).toBe(true);
    expect(ServerConfig.fromEnv({ GRAM_FAKE_AGENT: "0" })).not.toHaveProperty("fakeAgent");
    expect(ServerConfig.fromEnv({})).not.toHaveProperty("fakeAgent");
  });

  it("names the running app's version and build, and ignores a build that isn't one", () => {
    const sha = "1a2b3c4d".repeat(5);
    const packaged = ServerConfig.fromEnv({ GRAM_APP_VERSION: "0.4.0", GRAM_APP_BUILD: sha });
    expect(packaged).toMatchObject({ appVersion: "0.4.0", appBuild: sha });
    expect(appLabelOf(packaged)).toBe("0.4.0 (1a2b3c4)");
    expect(
      appLabelOf(ServerConfig.fromEnv({ GRAM_APP_VERSION: "0.4.0", GRAM_APP_BUILD: "dev" })),
    ).toBe("0.4.0 (dev)");
    const odd = ServerConfig.fromEnv({ GRAM_APP_VERSION: "0.4.0", GRAM_APP_BUILD: "x; y" });
    expect(odd).not.toHaveProperty("appBuild");
    expect(appLabelOf(odd)).toBe("0.4.0");
    expect(appLabelOf(ServerConfig.fromEnv({ GRAM_APP_BUILD: sha }))).toBeUndefined();
  });
});
