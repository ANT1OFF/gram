import { describe, expect, it } from "@effect/vitest";
import {
  authorize,
  contentSecurityPolicy,
  makeLaunchToken,
  tokenCookieName,
  tokensEqual,
  type AuthRequest,
} from "./auth.ts";

const PORT = 4321;
const TOKEN = "a".repeat(64);
const OPTIONS = { port: PORT, token: TOKEN };

const request = (overrides: Partial<AuthRequest> = {}): AuthRequest => ({
  method: "GET",
  url: "/",
  headers: { host: `127.0.0.1:${PORT}` },
  cookies: {},
  ...overrides,
});

describe("authorize", () => {
  it("rejects a foreign Host, even with a valid cookie (DNS rebinding)", () => {
    const decision = authorize(
      OPTIONS,
      request({
        headers: { host: `evil.example:${PORT}` },
        cookies: { [tokenCookieName(PORT)]: TOKEN },
      }),
    );
    expect(decision).toMatchObject({ kind: "reject", status: 403 });
  });

  it("refuses proxied requests with a spoofed loopback Host before boot, cookie or bearer auth", () => {
    for (const name of [
      "forwarded",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-for",
      "tailscale-user-login",
      "tailscale-funnel-request",
    ]) {
      const headers = {
        host: `127.0.0.1:${PORT}`,
        [name]: "synthetic",
        authorization: "Bearer synthetic",
      };
      for (const url of ["/", `/?boot=${TOKEN}`, "/mcp", "/remote/pair"])
        expect(
          authorize(
            OPTIONS,
            request({ url, headers, cookies: { [tokenCookieName(PORT)]: TOKEN } }),
          ),
        ).toMatchObject({ status: 403 });
    }
  });

  it("rejects the right host on another port", () => {
    expect(authorize(OPTIONS, request({ headers: { host: "127.0.0.1:1" } }))).toMatchObject({
      status: 403,
    });
  });

  it("rejects a cross-origin request", () => {
    const decision = authorize(
      OPTIONS,
      request({
        headers: { host: `127.0.0.1:${PORT}`, origin: "https://evil.example" },
        cookies: { [tokenCookieName(PORT)]: TOKEN },
      }),
    );
    expect(decision).toMatchObject({ kind: "reject", status: 403 });
  });

  it("allows configured extra origins", () => {
    const decision = authorize(
      { ...OPTIONS, extraOrigins: ["http://localhost:5173"] },
      request({
        headers: { host: `localhost:${PORT}`, origin: "http://localhost:5173" },
        cookies: { [tokenCookieName(PORT)]: TOKEN },
      }),
    );
    expect(decision.kind).toBe("pass");
  });

  it("exchanges a valid boot token on the root navigation only", () => {
    expect(authorize(OPTIONS, request({ url: `/?boot=${TOKEN}` })).kind).toBe("boot");
    expect(authorize(OPTIONS, request({ url: `/assets/x.js?boot=${TOKEN}` })).kind).toBe("reject");
    expect(authorize(OPTIONS, request({ method: "POST", url: `/?boot=${TOKEN}` })).kind).toBe(
      "reject",
    );
    expect(authorize(OPTIONS, request({ url: "/?boot=wrong" }))).toMatchObject({ status: 401 });
  });

  it("requires the per-port cookie on every other route", () => {
    expect(authorize(OPTIONS, request({ url: "/ws" }))).toMatchObject({ status: 401 });
    expect(authorize(OPTIONS, request({ url: "/index.html" }))).toMatchObject({ status: 401 });
    expect(
      authorize(OPTIONS, request({ url: "/ws", cookies: { sb_token_9999: TOKEN } })),
    ).toMatchObject({ status: 401 });
    expect(
      authorize(OPTIONS, request({ url: "/ws", cookies: { [tokenCookieName(PORT)]: TOKEN } })).kind,
    ).toBe("pass");
  });

  describe("/mcp", () => {
    const bearer = "b".repeat(64);

    it("hands a bearer token to the caller to resolve", () => {
      expect(
        authorize(
          OPTIONS,
          request({
            method: "POST",
            url: "/mcp",
            headers: {
              host: `127.0.0.1:${PORT}`,
              authorization: `Bearer ${bearer}`,
            },
          }),
        ),
      ).toEqual({ kind: "bearer", token: bearer });
    });

    it("rejects a missing or non-bearer Authorization with 401, and ignores the cookie", () => {
      const cookies = { [tokenCookieName(PORT)]: TOKEN };
      expect(authorize(OPTIONS, request({ method: "POST", url: "/mcp", cookies }))).toMatchObject({
        kind: "reject",
        status: 401,
      });
      expect(
        authorize(
          OPTIONS,
          request({
            method: "POST",
            url: "/mcp",
            headers: { host: `127.0.0.1:${PORT}`, authorization: `Basic ${bearer}` },
          }),
        ),
      ).toMatchObject({ status: 401 });
    });

    it("keeps the Host and Origin checks ahead of the bearer", () => {
      const authorization = `Bearer ${bearer}`;
      expect(
        authorize(
          OPTIONS,
          request({ url: "/mcp", headers: { host: `evil.example:${PORT}`, authorization } }),
        ),
      ).toMatchObject({ kind: "reject", status: 403 });
      expect(
        authorize(
          OPTIONS,
          request({
            url: "/mcp",
            headers: { host: `127.0.0.1:${PORT}`, origin: "https://evil.example", authorization },
          }),
        ),
      ).toMatchObject({ kind: "reject", status: 403 });
    });
  });
});

describe("launch token", () => {
  it("is 64 hex characters and differs per launch", () => {
    const token = makeLaunchToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(makeLaunchToken()).not.toBe(token);
  });

  it("compares by value without leaking length mismatches as throws", () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
    expect(tokensEqual(TOKEN, "a")).toBe(false);
    expect(tokensEqual(TOKEN, "b".repeat(64))).toBe(false);
  });
});

describe("contentSecurityPolicy", () => {
  const directives = new Map(
    contentSecurityPolicy(PORT)
      .split("; ")
      .map((directive) => directive.split(" "))
      .map(([name, ...sources]) => [name!, sources] as const),
  );

  it("allows only same-origin scripts and this port's WebSocket", () => {
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("connect-src")).toEqual([
      "'self'",
      `ws://127.0.0.1:${PORT}`,
      `ws://localhost:${PORT}`,
    ]);
  });

  it("adds exactly the configured remote WSS source to one connect directive", () => {
    const policy = contentSecurityPolicy(PORT, "https://device.tail123.ts.net:9443");
    expect(policy.split("connect-src")).toHaveLength(2);
    expect(policy).toContain("wss://device.tail123.ts.net:9443");
    expect(policy).not.toContain("wss://*");
    expect(policy).not.toContain("ws://127.0.0.1");
  });

  it("lets the terminal emulator's WebAssembly compile, and gives away nothing else for it", () => {
    // Exactly these two. `'wasm-unsafe-eval'` contains the text "unsafe-eval", so a substring check
    // can't tell it from the keyword that would allow `eval`; compare whole sources.
    expect(directives.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    const sources = [...directives.values()].flat();
    expect(sources).not.toContain("'unsafe-eval'");
    // The module can only come from this origin: nothing a script or a fetch may load is remote,
    // `data:` or `blob:`.
    for (const name of ["default-src", "script-src", "connect-src"]) {
      for (const source of directives.get(name)!) {
        expect(source).toMatch(/^('self'|'wasm-unsafe-eval'|ws:\/\/(127\.0\.0\.1|localhost):\d+)$/);
      }
    }
  });
});
