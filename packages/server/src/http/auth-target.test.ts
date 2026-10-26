import { describe, expect, it } from "vitest";
import { FindMyWay } from "../platform/unstable.ts";
import { authTarget } from "./auth-target.ts";
import { authorize, type AuthRequest } from "./auth.ts";
import { createRemoteAccess } from "./remote-access.ts";

const protectedPaths = [
  "/",
  "/ws",
  "/mcp",
  "/remote/pair",
  "/remote/connect",
  "/remote/claim",
] as const;

const request = (url: string, host: string): AuthRequest => ({
  method: "GET",
  url,
  headers: { host, authorization: "Bearer synthetic" },
  cookies: { sb_token_4321: "synthetic" },
});
describe("authentication targets agree with the actual router", () => {
  it("accepts canonical paths and ordinary encoded data, not credential endpoint aliases", () => {
    const router = FindMyWay.make<string>();
    for (const path of protectedPaths) router.all(path, path);
    for (const path of protectedPaths) {
      expect(authTarget(path)?.path).toBe(path);
      const aliases = [
        path.toUpperCase(),
        `${path}/`,
        `/${path}`,
        `${path};extra`,
        path.replace(/[a-z]/, (letter) => `%${letter.charCodeAt(0).toString(16)}`),
      ];
      for (const alias of aliases.filter((candidate) => candidate !== path)) {
        expect(router.find("GET", alias)?.handler).toBe(path);
        expect(authTarget(alias)).toBeUndefined();
      }
    }
    for (const path of [
      "/assets/file%20name.js",
      "/t/invented-thread",
      "/preview/%E2%9C%93",
      "/app.js?path=hello%2Fworld&name=two+words",
    ]) {
      expect(authTarget(path)).toBeDefined();
    }
    expect(authTarget("/?%62oot=synthetic")?.searchParams.get("boot")).toBe("synthetic");
  });

  it("refuses malformed escapes/UTF-8, non-origin forms and URL rewriting without throwing", () => {
    for (const path of [
      "/%",
      "/%GG",
      "/%00",
      "/%7f",
      "/%C0%AF",
      "/%E0%A4",
      "/ws?x=%GG",
      "/ws?x=%C0%AF",
      "http://localhost/ws",
      "//ws",
      "/remote/../",
      "/./",
      "/ws\\",
      "/ws#fragment",
      "/ws\n",
      "/%2e/?boot=synthetic",
      "/app.js?boot=synthetic",
    ]) {
      expect(authTarget(path)).toBeUndefined();
    }
  });

  it("applies the same refusal to local cookie/bearer/boot and remote cookie paths", () => {
    const remote = createRemoteAccess("https://device.tail123.ts.net:9443", 4321);

    for (const path of [
      "/MCP",
      "/ws/",
      "/REMOTE/PAIR",
      "/remote/%63laim",
      "/remote//connect",
      "/%GG",
      "/%2e/?boot=synthetic",
    ]) {
      expect(
        authorize({ port: 4321, token: "synthetic" }, request(path, "127.0.0.1:4321")),
      ).toMatchObject({ status: 403 });
      expect(remote.authorize(request(path, remote.host))).toMatchObject({ status: 403 });
    }
  });
});
