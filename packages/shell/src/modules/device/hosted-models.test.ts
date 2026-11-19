import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  request as httpRequest,
  type Server,
} from "node:http";
import type { HostedDiscovery } from "@gram/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkProof } from "./hosted-fake.ts";
import type { TokenFor, TokenKeeper } from "./hosted.ts";
import { type HostedModelRoute, startHostedModelRoute } from "./hosted-models.ts";
import { devicePrivateKeyFrom, generateDeviceKey } from "./keys.ts";

// A CLI's model calls, forwarded from loopback to a hosted server with the person's sign-in. The
// server here checks what a real one would: a DPoP token, a proof of this call by the device key,
// and nothing of the CLI's own key.

const key = devicePrivateKeyFrom(generateDeviceKey().privateKeyPem);
const ACCESS = "at-models";

let upstream: Server;
let upstreamUrl = "";
let seen: Array<{ url: string; headers: IncomingHttpHeaders; body: string; proof?: unknown }> = [];
let askNonce = false;
let route: HostedModelRoute | undefined;
let tokenFor: TokenFor;
let asked: string[] = [];

const keeper = (): TokenKeeper => ({
  subject: "person-ada",
  token: async (scope) => {
    asked.push(scope);
    return tokenFor;
  },
  fresh: async () => tokenFor,
  nonce: {},
  signedOut: () => false,
  signOut: async () => undefined,
  unsaved: () => false,
});

beforeEach(async () => {
  seen = [];
  asked = [];
  askNonce = false;
  tokenFor = {
    ok: true,
    token: {
      accessToken: ACCESS,
      tokenType: "DPoP",
      subject: "person-ada",
      expiresAt: Date.now() + 60_000,
    },
  };
  upstream = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      const url = `${upstreamUrl}${request.url ?? ""}`;
      const proof = checkProof(
        request.headers.dpop as string | undefined,
        request.method ?? "",
        url,
      );
      seen.push({ url, headers: request.headers, body: Buffer.concat(parts).toString(), proof });
      if (askNonce && proof?.claims.nonce !== "server-nonce") {
        response
          .writeHead(401, {
            "www-authenticate": 'DPoP error="use_dpop_nonce"',
            "dpop-nonce": "server-nonce",
          })
          .end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_1" });
      response.write("event: a\n\n");
      setTimeout(() => response.end("event: b\n\n"), 5);
    });
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  const address = upstream.address();
  upstreamUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  await route?.close();
  route = undefined;
  upstream.closeAllConnections();
  await new Promise<void>((done) => upstream.close(() => done()));
});

const start = async () => {
  route = await startHostedModelRoute({
    discovery: { models_endpoint: `${upstreamUrl}/desktop/models` } as HostedDiscovery,
    keeper: keeper(),
    key,
    fetch: (input, init) => fetch(input, init),
  });
  return route;
};

const send = (started: HostedModelRoute, headers: Record<string, string>, path = "/v1/messages") =>
  fetch(`${started.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
    body: JSON.stringify({ model: "m", messages: [] }),
  });

describe("a CLI's model call through this machine", () => {
  it("goes on with the sign-in and a proof of the call, never the CLI's key", async () => {
    const started = await start();
    const answer = await send(started, { "x-api-key": started.apiKey }, "/v1/messages?beta=true");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("request-id")).toBe("req_1");
    expect(await answer.text()).toBe("event: a\n\nevent: b\n\n");
    expect(asked).toEqual(["models"]);
    const [call] = seen;
    expect(call?.url).toBe(`${upstreamUrl}/desktop/models/v1/messages?beta=true`);
    expect(call?.headers.authorization).toBe(`DPoP ${ACCESS}`);
    expect(call?.headers["x-api-key"]).toBeUndefined();
    expect(call?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call?.body).toBe('{"model":"m","messages":[]}');
    const proof = call?.proof as { claims: Record<string, unknown> } | undefined;
    expect(proof?.claims.ath).toBe(createHash("sha256").update(ACCESS).digest("base64url"));
  });

  it("takes an OpenAI client's bearer key, and asks again once for the server's nonce", async () => {
    askNonce = true;
    const started = await start();
    const answer = await send(
      started,
      { authorization: `Bearer ${started.apiKey}` },
      "/openai/v1/responses",
    );
    expect(answer.status).toBe(200);
    await answer.text();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.headers.authorization).toBe(`DPoP ${ACCESS}`);
  });

  it("is refused without its key, from a browser, or by another name, and goes nowhere", async () => {
    const started = await start();
    expect((await send(started, {})).status).toBe(401);
    expect((await send(started, { "x-api-key": "gram-local-guess" })).status).toBe(401);
    expect(
      (await send(started, { "x-api-key": started.apiKey, origin: "https://page.example" })).status,
    ).toBe(403);
    // A name that resolves to loopback, as a page rebinding its own name would use.
    const port = new URL(started.url).port;
    const status = await new Promise<number | undefined>((done) => {
      const sent = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/messages",
          method: "POST",
          headers: { host: `rebound.example:${port}`, "x-api-key": started.apiKey },
        },
        (response) => {
          response.resume();
          done(response.statusCode);
        },
      );
      sent.on("error", () => done(undefined));
      sent.end("{}");
    });
    expect(status).toBe(403);
    expect(seen).toEqual([]);
  });

  it("is refused once the sign-in has ended", async () => {
    tokenFor = { ok: false, why: "Signed out.", signedOut: true };
    const started = await start();
    const answer = await send(started, { "x-api-key": started.apiKey });
    expect(answer.status).toBe(401);
    expect(seen).toEqual([]);
  });
});
