import { createServer, request, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ghConfig, ghThreadEnv, relayRequest, threadOfAuthorization } from "./github-relay.ts";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** The relay over a real HTTP listener, with the route stood in by `answer`. */
const relayed = async (
  endpoint: { url: string; token?: string; tokenFile?: string },
  call: {
    method?: string;
    path: string;
    host: string;
    headers?: Record<string, string>;
    body?: string;
  },
  answer: (sent: Sent) => Response = () => Response.json({ ok: true }),
) => {
  const sent: Sent[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    const record: Sent = {
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? "" : Buffer.from(init.body as Uint8Array).toString("utf8"),
    };
    sent.push(record);
    return answer(record);
  }) as unknown as typeof fetch;
  const server = createServer((req, res) => void relayRequest(endpoint, fake)(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: call.method ?? "GET",
        path: call.path,
        headers: { host: call.host, ...call.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end(call.body);
  });
  return { sent, reply };
};

describe("the GitHub relay", () => {
  it("sends a read to the route's api part with the route's token, never gh's", async () => {
    const { sent, reply } = await relayed(
      { url: "https://route.example.invalid/github/", token: "route-token" },
      {
        path: "/repos/acme/widgets/pulls?state=open",
        host: "api.github.com",
        headers: { authorization: "token gram-relay", accept: "application/vnd.github+json" },
      },
    );
    expect(reply.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(
      "https://route.example.invalid/github/api/repos/acme/widgets/pulls?state=open",
    );
    expect(sent[0]!.headers["authorization"]).toBe("Bearer route-token");
    expect(sent[0]!.headers["x-gram-upstream-host"]).toBe("api.github.com");
    expect(sent[0]!.headers["accept"]).toBe("application/vnd.github+json");
    expect(sent[0]!.headers["x-gram-thread"]).toBeUndefined();
  });

  it("names the thread a call was made for, and sends its body on", async () => {
    const { sent } = await relayed(
      { url: "https://route.example.invalid", token: "route-token" },
      {
        method: "POST",
        path: "/graphql",
        host: "api.github.com",
        headers: { authorization: "token gram-thread:thr_123", "content-type": "application/json" },
        body: '{"query":"mutation{}"}',
      },
    );
    expect(sent[0]!.headers["x-gram-thread"]).toBe("thr_123");
    expect(sent[0]!.headers["authorization"]).toBe("Bearer route-token");
    expect(sent[0]!.body).toBe('{"query":"mutation{}"}');
  });

  it("drops a thread header gh was given rather than trust it", async () => {
    const { sent } = await relayed(
      { url: "https://route.example.invalid", token: "route-token" },
      { path: "/user", host: "api.github.com", headers: { "x-gram-thread": "someone-else" } },
    );
    expect(sent[0]!.headers["x-gram-thread"]).toBeUndefined();
  });

  it("reads a token file on each call", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "gram-relay-")), "token");
    writeFileSync(file, "first-token\n");
    const endpoint = { url: "https://route.example.invalid", tokenFile: file };
    const one = await relayed(endpoint, { path: "/x", host: "api.github.com" });
    writeFileSync(file, "second-token\n");
    const two = await relayed(endpoint, { path: "/x", host: "api.github.com" });
    expect(one.sent[0]!.headers["authorization"]).toBe("Bearer first-token");
    expect(two.sent[0]!.headers["authorization"]).toBe("Bearer second-token");
  });

  it("refuses a host that isn't GitHub's, and sends nothing", async () => {
    const { sent, reply } = await relayed(
      { url: "https://route.example.invalid", token: "route-token" },
      { path: "/", host: "example.com" },
    );
    expect(reply.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("maps codeload to its own part and hands a redirect back as it came", async () => {
    const { sent, reply } = await relayed(
      { url: "https://route.example.invalid", token: "route-token" },
      { path: "/acme/widgets/tar.gz/main", host: "codeload.github.com" },
      () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere.invalid/" } }),
    );
    expect(sent[0]!.url).toBe("https://route.example.invalid/codeload/acme/widgets/tar.gz/main");
    expect(reply.status).toBe(302);
  });
});

describe("a thread's handle", () => {
  it("is read back only from gh's own token form", () => {
    expect(threadOfAuthorization("token gram-thread:thr_1")).toBe("thr_1");
    expect(threadOfAuthorization("Bearer gram-thread:thr_1")).toBe("thr_1");
    expect(threadOfAuthorization("token gram-relay")).toBeUndefined();
    expect(threadOfAuthorization("token ghp_realtoken")).toBeUndefined();
    expect(threadOfAuthorization("token gram-thread:bad id")).toBeUndefined();
    expect(threadOfAuthorization(undefined)).toBeUndefined();
  });

  it("is not set where no relay runs, so a person's own gh sign-in stands", () => {
    expect(ghThreadEnv("thr_1")).toEqual({});
  });

  it("points gh at the socket", () => {
    expect(ghConfig("/data/github-relay/gh.sock")).toContain(
      'http_unix_socket: "/data/github-relay/gh.sock"',
    );
  });
});
