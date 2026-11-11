// A small hosted server for tests: discovery, sign-in, tokens bound to the device key, devices
// and workspaces. Test support only; nothing ships it.

import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { deviceRegistrationBytes } from "@gram/contracts";
import { dpopTarget, dpopThumbprint } from "./dpop.ts";
import { deviceIdOf, generateDeviceKey } from "./keys.ts";

/** Checks a DPoP proof as a server would, and answers with its claims, or undefined. */
export const checkProof = (proof: string | undefined, method: string, url: string) => {
  if (proof === undefined) return undefined;
  const [head, body, signature] = proof.split(".");
  if (head === undefined || body === undefined || signature === undefined) return undefined;
  const header = JSON.parse(Buffer.from(head, "base64url").toString()) as {
    typ: string;
    alg: string;
    jwk: { kty: string; crv: string; x: string };
  };
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
  if (header.typ !== "dpop+jwt" || header.alg !== "EdDSA") return undefined;
  const key = createPublicKey({ key: header.jwk, format: "jwk" });
  if (!verify(null, Buffer.from(`${head}.${body}`), key, Buffer.from(signature, "base64url")))
    return undefined;
  if (claims.htm !== method || claims.htu !== dpopTarget(url)) return undefined;
  return { claims, thumbprint: dpopThumbprint(key) };
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const parts: Array<Buffer> = [];
  for await (const part of request) parts.push(part as Buffer);
  return Buffer.concat(parts).toString();
};

const json = (status: number, value: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(value),
});

/** A small hosted server: discovery, sign-in, tokens bound to the device key, and devices. */
export const fakeServer = () => {
  const state = {
    codes: new Map<string, { challenge: string; redirect: string }>(),
    refresh: new Set<string>(),
    access: new Map<string, { scope: string; jkt: string }>(),
    challenges: new Set<string>(),
    nonce: "n-" + randomBytes(8).toString("hex"),
    askNonceOnce: true,
    issuer: "",
    sub: "person-ada",
    expiresIn: 900,
    registeredKey: undefined as string | undefined,
    lieAboutId: false,
    forgotten: [] as Array<string>,
    refreshes: 0,
    tokenType: "DPoP",
    giveRefresh: true,
    code: "",
    resourceNonce: undefined as string | undefined,
    workspacesStatus: 200,
    /** The workspaces listed, when not the one default. */
    workspaces: undefined as Array<Record<string, string>> | undefined,
    /** Ask for the token endpoint's own nonce on every call whose proof lacks it. */
    alwaysTokenNonce: false,
    tokenNonceErrors: 0,
    names: [] as Array<string>,
  };
  let origin = "";
  const handle = async (request: IncomingMessage) => {
    const url = new URL(request.url ?? "/", origin);
    const full = `${origin}${url.pathname}`;
    if (url.pathname === "/.well-known/gram-hosted")
      return json(200, {
        version: 1,
        issuer: state.issuer || origin,
        name: "Example",
        client_id: "gram-desktop",
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        workspaces_endpoint: `${origin}/api/workspaces`,
        devices_endpoint: `${origin}/api/devices`,
        device_connect: `${origin.replace("http:", "ws:")}/device/connect`,
      });
    if (url.pathname === "/oauth/authorize") {
      const code = state.code || randomBytes(12).toString("hex");
      const redirect = url.searchParams.get("redirect_uri") ?? "";
      state.codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirect });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      back.searchParams.set("iss", state.issuer || origin);
      return { status: 302, headers: { location: back.href }, body: "" };
    }
    if (url.pathname === "/oauth/token") {
      const proof = checkProof(request.headers.dpop as string | undefined, "POST", full);
      if (proof === undefined) return json(400, { error: "invalid_dpop_proof" });
      if ((state.askNonceOnce || state.alwaysTokenNonce) && proof.claims.nonce !== state.nonce) {
        state.askNonceOnce = false;
        state.tokenNonceErrors += 1;
        return json(400, { error: "use_dpop_nonce" }, { "dpop-nonce": state.nonce });
      }
      const form = new URLSearchParams(await readBody(request));
      let scope = "workspaces device:register device:connect";
      if (form.get("grant_type") === "authorization_code") {
        const code = state.codes.get(form.get("code") ?? "");
        state.codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (
          code === undefined ||
          code.redirect !== form.get("redirect_uri") ||
          createHash("sha256").update(verifier).digest("base64url") !== code.challenge
        )
          return json(400, { error: "invalid_grant" });
      } else if (form.get("grant_type") === "refresh_token") {
        state.refreshes += 1;
        if (!state.refresh.delete(form.get("refresh_token") ?? ""))
          return json(400, { error: "invalid_grant" });
        scope = form.get("scope") ?? scope;
      } else return json(400, { error: "unsupported_grant_type" });
      const access = randomBytes(16).toString("hex");
      const refresh = randomBytes(16).toString("hex");
      state.access.set(access, { scope, jkt: proof.thumbprint });
      state.refresh.add(refresh);
      return json(200, {
        access_token: access,
        token_type: state.tokenType,
        expires_in: state.expiresIn,
        ...(state.giveRefresh ? { refresh_token: refresh } : {}),
        scope,
        sub: state.sub,
      });
    }
    // Everything else needs a token bound to the key that proves the call.
    const auth = (request.headers.authorization ?? "").replace(/^DPoP /, "");
    const held = state.access.get(auth);
    const proof = checkProof(
      request.headers.dpop as string | undefined,
      request.method ?? "",
      full,
    );
    if (
      held === undefined ||
      proof === undefined ||
      proof.thumbprint !== held.jkt ||
      proof.claims.ath !== createHash("sha256").update(auth).digest("base64url")
    )
      return json(401, { error: "invalid_token" });
    if (state.resourceNonce !== undefined && proof.claims.nonce !== state.resourceNonce)
      return json(
        401,
        { error: "use_dpop_nonce" },
        {
          "dpop-nonce": state.resourceNonce,
          "www-authenticate": 'DPoP error="use_dpop_nonce"',
        },
      );
    if (url.pathname === "/api/workspaces" && state.workspacesStatus !== 200)
      return json(state.workspacesStatus, { error: "down" });
    if (url.pathname === "/api/workspaces" && held.scope === "workspaces")
      return json(
        200,
        state.workspaces ?? [
          { id: "w1", name: "Platform", organisation: "Example", role: "member", devices: "on" },
        ],
      );
    if (url.pathname === "/api/devices/challenge" && held.scope === "device:register") {
      const challenge = randomBytes(24).toString("base64url");
      state.challenges.add(challenge);
      return json(200, { challenge });
    }
    if (url.pathname === "/api/devices" && held.scope === "device:register") {
      const asked = JSON.parse(await readBody(request)) as {
        publicKey: string;
        challenge: string;
        signature: string;
        name: string;
      };
      state.names.push(asked.name);
      if (!state.challenges.delete(asked.challenge)) return json(400, { error: "bad challenge" });
      const key = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: asked.publicKey },
        format: "jwk",
      });
      const signed = deviceRegistrationBytes({
        origin,
        subject: state.sub,
        publicKey: asked.publicKey,
        challenge: asked.challenge,
      });
      if (!verify(null, signed, key, Buffer.from(asked.signature, "base64url")))
        return json(400, { error: "bad signature" });
      state.registeredKey = asked.publicKey;
      const other = generateDeviceKey().publicKey;
      return json(201, { deviceId: deviceIdOf(state.lieAboutId ? other : asked.publicKey) });
    }
    if (url.pathname.startsWith("/api/devices/") && request.method === "DELETE") {
      state.forgotten.push(decodeURIComponent(url.pathname.slice("/api/devices/".length)));
      return { status: 204, headers: {}, body: "" };
    }
    return json(404, { error: "not found" });
  };
  const server: Server = createServer((request, response) => {
    void handle(request).then((answer) => {
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body);
    });
  });
  return {
    state,
    server,
    start: () =>
      new Promise<string>((done) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
          done(origin);
        });
      }),
  };
};

/** The person's browser: follows the server's redirect back to the app. */
export const browser = async (url: string) => {
  const first = await fetch(url, { redirect: "manual" });
  const location = first.headers.get("location");
  if (location !== null) await (await fetch(location)).text();
};
