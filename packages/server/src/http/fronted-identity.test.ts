import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { actorHeadersForTests, actorOf, ACTOR_HEADER } from "./actor.ts";
import {
  CLOCK_SKEW_SECONDS,
  frontedIdentityFrom,
  IDENTITY_ENV,
  MAX_LIFETIME_SECONDS,
  SERVICE_TYP,
  verifyIdentity,
} from "./fronted-identity.ts";
import { makeTestProxy, signStatement } from "./fronted-identity.testing.ts";

const NOW = 1_800_000_000_000;
const proxy = makeTestProxy({ now: () => NOW });
const check = (statement: string | undefined, now = NOW) =>
  verifyIdentity(proxy.config, statement, now);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("a fronting proxy's signed identity", () => {
  test("names the person and their role", () => {
    expect(check(proxy.statement())).toEqual({
      ok: true,
      actor: { id: "user-ada", name: "Ada", role: "member" },
    });
    expect(check(proxy.statement({ role: "viewer", name: undefined }))).toEqual({
      ok: true,
      actor: { id: "user-ada", name: "user-ada", role: "viewer" },
    });
  });

  test("names the platform itself apart from any person, by its header and for one path", () => {
    const service = { header: { typ: SERVICE_TYP } };
    const claims = { sub: "platform", name: undefined, role: "service", path: "/machines/list" };
    expect(check(proxy.statement(claims, service))).toEqual({
      ok: true,
      service: { id: "platform", name: "platform", path: "/machines/list" },
    });
    // The role alone, as a proxy copying it from a directory would state it, is nobody.
    expect(check(proxy.statement(claims))).toEqual({ ok: false, reason: "role" });
    expect(check(proxy.statement(claims, { header: { typ: "JWT" } }))).toEqual({
      ok: false,
      reason: "role",
    });
    // The header alone makes no person a service, and a service needs its path.
    for (const role of ["member", "viewer", undefined, "Service"])
      expect(check(proxy.statement({ ...claims, role }, service))).toEqual({
        ok: false,
        reason: "role",
      });
    for (const path of [undefined, "", "machines/list", "/machines/list?x", 7])
      expect(check(proxy.statement({ ...claims, path }, service))).toEqual({
        ok: false,
        reason: "role",
      });
    expect(check(proxy.statement({ ...claims, sub: undefined }, service))).toEqual({
      ok: false,
      reason: "subject",
    });
  });

  test("is refused when missing or not a statement", () => {
    expect(check(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(check("")).toEqual({ ok: false, reason: "missing" });
    expect(check("user-ada")).toEqual({ ok: false, reason: "malformed" });
    expect(check("a.b")).toEqual({ ok: false, reason: "malformed" });
    expect(check(`${proxy.statement()}.extra`)).toEqual({ ok: false, reason: "malformed" });
    // Two headers arrive joined: neither is believed.
    expect(check(`${proxy.statement()}, ${proxy.statement()}`)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(check(`${"a".repeat(5000)}.b.c`)).toEqual({ ok: false, reason: "malformed" });
  });

  test("is refused when signed by anyone else", () => {
    const stranger = generateKeyPairSync("ed25519").privateKey;
    expect(check(proxy.statement({}, { key: stranger }))).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(check(proxy.statement({}, { header: { kid: "other-key" } }))).toEqual({
      ok: false,
      reason: "key",
    });
  });

  test("is refused when its claims were changed after signing", () => {
    const [header, , signature] = proxy.statement({ role: "viewer" }).split(".");
    const iat = Math.floor(NOW / 1000);
    const forged = encode({
      iss: proxy.config.issuer,
      aud: proxy.config.audience,
      sub: "user-ada",
      role: "member",
      iat,
      exp: iat + 60,
    });
    expect(check(`${header}.${forged}.${signature}`)).toEqual({ ok: false, reason: "signature" });
  });

  test("takes one algorithm, whatever the statement names", () => {
    const claims = encode({ iss: proxy.config.issuer, aud: proxy.config.audience, sub: "x" });
    expect(check(`${encode({ alg: "none" })}.${claims}.AAAA`)).toEqual({
      ok: false,
      reason: "algorithm",
    });
    // An HMAC keyed with the public key, which anyone holds.
    const publicJwk = JSON.parse(proxy.jwks).keys[0] as { x: string };
    const input = `${encode({ alg: "HS256", kid: "test-key" })}.${claims}`;
    const mac = createHmac("sha256", Buffer.from(publicJwk.x, "base64url"))
      .update(input)
      .digest("base64url");
    expect(check(`${input}.${mac}`)).toEqual({ ok: false, reason: "algorithm" });
    expect(check(proxy.statement({}, { header: { crit: ["exp"] } }))).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  test("is refused when made for another server or by another issuer", () => {
    expect(check(proxy.statement({ aud: "another-gram" }))).toEqual({
      ok: false,
      reason: "audience",
    });
    expect(check(proxy.statement({ aud: [proxy.config.audience, "another-gram"] }))).toEqual({
      ok: false,
      reason: "audience",
    });
    expect(check(proxy.statement({ aud: undefined }))).toEqual({ ok: false, reason: "audience" });
    expect(check(proxy.statement({ iss: "https://elsewhere.test" }))).toEqual({
      ok: false,
      reason: "issuer",
    });
  });

  test("is refused once expired, before its time, or made to last", () => {
    const iat = Math.floor(NOW / 1000);
    const live = proxy.statement();
    expect(check(live, NOW + 59_000).ok).toBe(true);
    expect(check(live, NOW + (60 + CLOCK_SKEW_SECONDS - 1) * 1000).ok).toBe(true);
    expect(check(live, NOW + (60 + CLOCK_SKEW_SECONDS) * 1000)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(check(proxy.statement({ iat: iat + 3600, exp: iat + 3660 }))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(check(proxy.statement({ nbf: iat + 3600 }))).toEqual({ ok: false, reason: "expired" });
    expect(check(proxy.statement({ exp: iat + MAX_LIFETIME_SECONDS + 1 }))).toEqual({
      ok: false,
      reason: "lifetime",
    });
    expect(check(proxy.statement({ exp: undefined }))).toEqual({ ok: false, reason: "malformed" });
    expect(check(proxy.statement({ iat: undefined }))).toEqual({ ok: false, reason: "malformed" });
    expect(check(proxy.statement({ exp: "soon" }))).toEqual({ ok: false, reason: "malformed" });
  });

  test("is refused without a person or with a role it doesn't know", () => {
    expect(check(proxy.statement({ sub: undefined }))).toEqual({ ok: false, reason: "subject" });
    expect(check(proxy.statement({ sub: "" }))).toEqual({ ok: false, reason: "subject" });
    expect(check(proxy.statement({ sub: 7 }))).toEqual({ ok: false, reason: "subject" });
    expect(check(proxy.statement({ sub: "ada\nrole: member" }))).toEqual({
      ok: false,
      reason: "subject",
    });
    expect(check(proxy.statement({ name: "x".repeat(300) }))).toEqual({
      ok: false,
      reason: "subject",
    });
    for (const role of [undefined, "admin", "owner", "Member", ["member"], true])
      expect(check(proxy.statement({ role }))).toEqual({ ok: false, reason: "role" });
  });

  test("needs a kid only when there is more than one key", () => {
    const other = generateKeyPairSync("ed25519");
    const two = {
      ...proxy.config,
      keys: new Map([...proxy.config.keys, ["second", other.publicKey]]),
    };
    const iat = Math.floor(NOW / 1000);
    const claims = {
      iss: proxy.config.issuer,
      aud: proxy.config.audience,
      sub: "user-ada",
      role: "member",
      iat,
      exp: iat + 60,
    };
    const unnamed = signStatement(other.privateKey, { alg: "EdDSA" }, claims);
    expect(verifyIdentity(two, unnamed, NOW)).toEqual({ ok: false, reason: "key" });
    expect(
      verifyIdentity({ ...two, keys: new Map([["", other.publicKey]]) }, unnamed, NOW).ok,
    ).toBe(true);
    const named = signStatement(other.privateKey, { alg: "EdDSA", kid: "second" }, claims);
    expect(verifyIdentity(two, named, NOW).ok).toBe(true);
    // The right kid for the wrong key.
    const crossed = signStatement(other.privateKey, { alg: "EdDSA", kid: "test-key" }, claims);
    expect(verifyIdentity(two, crossed, NOW)).toEqual({ ok: false, reason: "signature" });
  });
});

const env = {
  [IDENTITY_ENV.keys]: proxy.jwks,
  [IDENTITY_ENV.issuer]: proxy.config.issuer,
  [IDENTITY_ENV.audience]: proxy.config.audience,
  [IDENTITY_ENV.origin]: proxy.config.origin,
};

const withKeys = (keys: unknown) =>
  frontedIdentityFrom({ ...env, [IDENTITY_ENV.keys]: JSON.stringify({ keys }) });
const withOrigin = (origin: string) =>
  frontedIdentityFrom({ ...env, [IDENTITY_ENV.origin]: origin });

describe("the fronted sign-in environment", () => {
  test("is nothing when unset and whole when set", () => {
    expect(frontedIdentityFrom({})).toBeUndefined();
    const config = frontedIdentityFrom(env)!;
    expect(config.issuer).toBe(proxy.config.issuer);
    expect(verifyIdentity(config, proxy.statement(), NOW).ok).toBe(true);
  });

  test("refuses to start half configured", () => {
    for (const name of Object.values(IDENTITY_ENV))
      expect(() => frontedIdentityFrom({ ...env, [name]: undefined })).toThrow(/must be set too/);
  });

  test("refuses keys that are private, of another kind, or ambiguous", () => {
    const pair = generateKeyPairSync("ed25519");
    expect(() => withKeys([pair.privateKey.export({ format: "jwk" })])).toThrow(/public keys only/);
    expect(() => withKeys([{ kty: "oct", k: "c2VjcmV0" }])).toThrow(/Ed25519 keys only/);
    expect(() => withKeys([{ kty: "OKP", crv: "Ed25519", x: "AAAA" }])).toThrow(/not a valid/);
    expect(() => withKeys([])).toThrow(/at least one key/);
    const jwk = pair.publicKey.export({ format: "jwk" });
    expect(() => withKeys([jwk, { ...jwk, kid: "b" }])).toThrow(/every key needs a kid/);
    expect(() =>
      withKeys([
        { ...jwk, kid: "a" },
        { ...jwk, kid: "a" },
      ]),
    ).toThrow(/share the kid/);
    expect(() => frontedIdentityFrom({ ...env, [IDENTITY_ENV.keys]: "not json" })).toThrow(
      /not JSON/,
    );
  });

  test("takes an https origin alone", () => {
    expect(() => withOrigin("http://gram.example.test")).toThrow(/https origin/);
    expect(() => withOrigin("https://gram.example.test/app")).toThrow(/origin alone/);
    expect(() => withOrigin("gram.example.test")).toThrow();
    expect(withOrigin("http://localhost:8080")?.origin).toBe("http://localhost:8080");
  });
});

describe("the actor a connection carries", () => {
  test("is read back only from this server's own seal", () => {
    const actor = { id: "user-ada", name: "Ada", role: "member" as const };
    const headers = actorHeadersForTests(actor);
    expect(actorOf(headers)).toEqual(actor);
    expect(actorOf(undefined)).toBeUndefined();
    expect(actorOf({})).toBeUndefined();
    const [body, seal] = headers[ACTOR_HEADER]!.split(".") as [string, string];
    const viewer = actorHeadersForTests({ ...actor, role: "viewer" })[ACTOR_HEADER]!;
    // A viewer's body under a member's seal, and a body with no seal.
    expect(actorOf({ [ACTOR_HEADER]: `${viewer.split(".")[0]}.${seal}` })).toBeUndefined();
    expect(actorOf({ [ACTOR_HEADER]: body })).toBeUndefined();
    expect(actorOf({ [ACTOR_HEADER]: `${body}.` })).toBeUndefined();
    expect(actorOf({ [ACTOR_HEADER]: `${encode(actor)}.${"0".repeat(43)}` })).toBeUndefined();
  });
});
