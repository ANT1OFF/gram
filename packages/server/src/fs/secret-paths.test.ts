import { describe, expect, it } from "vitest";
import { secretPathsFrom } from "./secret-paths.ts";

describe.skipIf(process.platform === "win32")("a deployment's secret paths", () => {
  it("are each token, secret and TLS file it names, the folders holding them, and those listed", () => {
    const paths = secretPathsFrom(
      {
        GRAM_DECISION_HOOK_TOKEN_FILE: "/run/secrets/tokens/decision",
        GRAM_GITHUB_ROUTE_TOKEN_FILE: "/run/secrets/tokens/route",
        GRAM_PROVISIONED_TLS_KEY: "/run/secrets/tls/tls.key",
        GRAM_LOCAL_HOST_SECRET_FILE: "/data/host-secret",
        GRAM_SECRET_PATHS: "/run/backup",
        GRAM_EVENT_SINK_TOKEN_FILE: "relative/token",
        HOME: "/data/home",
      },
      "/data/state",
    );
    expect(paths.toSorted()).toEqual(
      [
        "/data/host-secret",
        "/run/backup",
        "/run/secrets/tls",
        "/run/secrets/tls/tls.key",
        "/run/secrets/tokens",
        "/run/secrets/tokens/decision",
        "/run/secrets/tokens/route",
      ].toSorted(),
    );
  });
});
