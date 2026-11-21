import { describe, expect, it } from "@effect/vitest";
import {
  authorize,
  contentSecurityPolicy,
  makeLaunchToken,
  ORIGIN_KEY_HEADER,
  ORIGIN_KEY_PROTOCOL,
  tokenCookieName,
  tokensEqual,
  type AuthRequest,
} from "./auth.ts";

const PORT = 4321;
const TOKEN = "a".repeat(64);
const KEY = "b".repeat(64);
const COOKIE = "c".repeat(64);
const OPTIONS = { port: PORT, token: TOKEN, cookie: COOKIE, originKey: KEY };

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
        cookies: { [tokenCookieName(PORT)]: COOKIE },
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
            request({ url, headers, cookies: { [tokenCookieName(PORT)]: COOKIE } }),
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
        cookies: { [tokenCookieName(PORT)]: COOKIE },
      }),
    );
    expect(decision).toMatchObject({ kind: "reject", status: 403 });
  });

  it("allows configured extra origins", () => {
    const decision = authorize(
      { ...OPTIONS, extraOrigins: ["http://localhost:5173"] },
      request({
        headers: {
          host: `localhost:${PORT}`,
          origin: "http://localhost:5173",
          [ORIGIN_KEY_HEADER]: KEY,
        },
        cookies: { [tokenCookieName(PORT)]: COOKIE },
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
      authorize(OPTIONS, request({ url: "/ws", cookies: { sb_token_9999: COOKIE } })),
    ).toMatchObject({ status: 401 });
  });

  // A server on another loopback port the browser visits is sent the cookie, and replays it.
  describe("the cookie another port saw, without the key only Gram's origin holds", () => {
    const cookies = { [tokenCookieName(PORT)]: COOKIE };
    const host = `127.0.0.1:${PORT}`;

    it("opens no socket and reaches no route", () => {
      for (const [method, url] of [
        ["GET", "/ws"],
        ["POST", "/workspace/export"],
        ["POST", "/machines/join"],
        ["GET", "/?boot=0"],
      ] as const)
        expect(authorize(OPTIONS, request({ method, url, cookies }))).toMatchObject({
          kind: "reject",
          status: 401,
        });
      const wrong = { host, [ORIGIN_KEY_HEADER]: "d".repeat(64) };
      expect(authorize(OPTIONS, request({ url: "/ws", headers: wrong, cookies }))).toMatchObject({
        status: 401,
      });
    });

    it("gets the web app's own files and nothing else", () => {
      expect(authorize(OPTIONS, request({ url: "/", cookies })).kind).toBe("shell");
      expect(authorize(OPTIONS, request({ url: "/settings/machines", cookies })).kind).toBe(
        "shell",
      );
    });

    it("with the key, as a header or as the socket's subprotocol, passes", () => {
      expect(
        authorize(
          OPTIONS,
          request({
            method: "POST",
            url: "/workspace/export",
            headers: { host, [ORIGIN_KEY_HEADER]: KEY },
            cookies,
          }),
        ).kind,
      ).toBe("pass");
      expect(
        authorize(
          OPTIONS,
          request({
            url: "/ws",
            headers: { host, "sec-websocket-protocol": `other, ${ORIGIN_KEY_PROTOCOL}${KEY}` },
            cookies,
          }),
        ).kind,
      ).toBe("pass");
    });

    // The boot answers with the key, so the cookie's value must never also be the boot token.
    it("is no boot token: replayed as `?boot=`, with or without the cookie, it boots nothing", () => {
      for (const withCookies of [{}, cookies])
        expect(
          authorize(OPTIONS, request({ url: `/?boot=${COOKIE}`, cookies: withCookies })),
        ).toMatchObject({ kind: "reject", status: 401 });
    });

    it("and the key without the cookie passes nothing", () => {
      expect(
        authorize(OPTIONS, request({ url: "/ws", headers: { host, [ORIGIN_KEY_HEADER]: KEY } })),
      ).toMatchObject({ status: 401 });
    });
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
      const cookies = { [tokenCookieName(PORT)]: COOKIE };
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
