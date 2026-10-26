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
