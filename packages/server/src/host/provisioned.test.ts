import { describe, expect, it } from "vitest";
import { provisionedHostsFrom, provisionedOrigin } from "./provisioned.ts";

describe("the provisioned-host address", () => {
  it("is one canonical https origin, never plain http or a tailnet address", () => {
    for (const ok of [
      "https://gram.internal:8443",
      "https://gram.cell.svc.cluster.local",
      "https://10.0.0.7:9443",
    ])
      expect(provisionedOrigin(ok)).toBe(ok);
    for (const bad of [
      "http://gram.internal:8443",
      "wss://gram.internal:8443",
      "https://gram.internal:8443/",
      "https://gram.internal:8443/host/connect",
      "https://user@gram.internal",
      "https://GRAM.internal",
      "https://gram.internal:443",
      "gram.internal:8443",
      "",
    ])
      expect(() => provisionedOrigin(bad), bad).toThrow();
    expect(() => provisionedOrigin("https://device.tail123.ts.net")).toThrow("tailnet");
  });
});

describe("the provisioned-host listener's config", () => {
  const full = {
    GRAM_PROVISIONED_ORIGIN: "https://gram.internal:8443",
    GRAM_PROVISIONED_TLS_CERT: "/tls/tls.crt",
    GRAM_PROVISIONED_TLS_KEY: "/tls/tls.key",
  };

  it("is absent unless set, and whole or refused when it is", () => {
    expect(provisionedHostsFrom({})).toBeUndefined();
    expect(provisionedHostsFrom({ GRAM_PROVISIONED_ORIGIN: "" })).toBeUndefined();
    expect(provisionedHostsFrom(full)).toEqual({
      origin: "https://gram.internal:8443",
      port: 8443,
      listenHost: "0.0.0.0",
      certFile: "/tls/tls.crt",
      keyFile: "/tls/tls.key",
    });
    // The origin's port by default (443 when it names none), or the one a mapping forwards to.
    expect(
      provisionedHostsFrom({
        ...full,
        GRAM_PROVISIONED_ORIGIN: "https://gram.internal",
      })?.port,
    ).toBe(443);
    expect(
      provisionedHostsFrom({
        ...full,
        GRAM_PROVISIONED_PORT: "9443",
        GRAM_PROVISIONED_LISTEN_HOST: "::",
      }),
    ).toMatchObject({ port: 9443, listenHost: "::" });
    for (const partial of [
      { GRAM_PROVISIONED_ORIGIN: full.GRAM_PROVISIONED_ORIGIN },
      {
        GRAM_PROVISIONED_TLS_CERT: "/tls/tls.crt",
        GRAM_PROVISIONED_TLS_KEY: "/tls/tls.key",
      },
      { GRAM_PROVISIONED_PORT: "8443" },
      { ...full, GRAM_PROVISIONED_TLS_KEY: undefined },
      { ...full, GRAM_PROVISIONED_ORIGIN: "http://gram.internal:8443" },
      { ...full, GRAM_PROVISIONED_PORT: "0" },
      { ...full, GRAM_PROVISIONED_PORT: "70000" },
      { ...full, GRAM_PROVISIONED_PORT: "https" },
      { ...full, GRAM_PROVISIONED_LISTEN_HOST: "gram.internal" },
    ])
      expect(() => provisionedHostsFrom(partial), JSON.stringify(partial)).toThrow();
  });
});
