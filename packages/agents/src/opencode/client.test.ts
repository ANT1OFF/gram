import { describe, expect, it } from "vitest";

import { makeOpenCodeClient, OpenCodeRequestError, type OpenCodeFetch } from "./client.ts";
import type { OpenCodeEvent } from "./protocol.ts";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
}

const recording = (answer: (sent: Sent) => Response) => {
  const sent: Array<Sent> = [];
  const fetch: OpenCodeFetch = async (url, init) => {
    const each = {
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }),
    };
    sent.push(each);
    return answer(each);
  };
  return { sent, fetch };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the OpenCode client", () => {
  it("sends the password as Basic auth for opencode, and reads the data envelope", async () => {
    const { sent, fetch } = recording(() =>
      json({
        data: { id: "ses_1", title: "T", location: { directory: "/w" }, time: { updated: 5 } },
      }),
    );
    const client = makeOpenCodeClient({ baseUrl: "http://127.0.0.1:9/", password: "pw", fetch });
    const session = await client.createSession({
      directory: "/w",
      agent: "build",
      model: { providerID: "gram", id: "openai/gpt-5" },
    });
    expect(session).toEqual({ id: "ses_1", title: "T", directory: "/w", updated: 5 });
    expect(sent[0]).toMatchObject({
      url: "http://127.0.0.1:9/api/session",
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}` },
      body: {
        location: { directory: "/w" },
        agent: "build",
        model: { providerID: "gram", id: "openai/gpt-5" },
      },
    });
  });

  it("trims a base URL's trailing slashes in one pass, however many there are", async () => {
    const { sent, fetch } = recording(() => json({ data: [] }));
    // 200,000 slashes then a letter: `/\/+$/` takes seconds to give up on this, past the timeout.
    const run = "/".repeat(200_000);
    await makeOpenCodeClient({ baseUrl: `http://h${run}x`, password: "p", fetch }).listSessions(
      "/w",
      1,
    );
    await makeOpenCodeClient({ baseUrl: `http://h/x${run}`, password: "p", fetch }).listSessions(
      "/w",
      1,
    );
    expect(sent[0]?.url.startsWith(`http://h${run}x/api/session`)).toBe(true);
    expect(sent[1]?.url.startsWith("http://h/x/api/session")).toBe(true);
  });

  it("puts a session's id and a reply's request id in the path, encoded", async () => {
    const { sent, fetch } = recording(() => new Response(""));
    const client = makeOpenCodeClient({ baseUrl: "http://h", password: "p", fetch });
    await client.prompt("ses/1", "hi", "steer");
    await client.reply("ses/1", "per 1", "reject", "not that");
    expect(sent.map((each) => [each.method, each.url, each.body])).toEqual([
      ["POST", "http://h/api/session/ses%2F1/prompt", { text: "hi", delivery: "steer" }],
      [
        "POST",
        "http://h/api/session/ses%2F1/permission/per%201/reply",
        { decision: "reject", message: "not that" },
      ],
    ]);
  });

  it("fails with the status and the server's message, and reads a missing session as none", async () => {
    const { fetch } = recording((sent) =>
      sent.method === "GET"
        ? json({ message: "no such session" }, 404)
        : json({ error: { message: "bad model" } }, 400),
    );
    const client = makeOpenCodeClient({ baseUrl: "http://h", password: "secret", fetch });
    expect(await client.getSession("ses_x")).toBeUndefined();
    const error = await client
      .setModel("ses_x", { providerID: "p", id: "m" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenCodeRequestError);
    expect(error).toMatchObject({
      status: 400,
      message: "OpenCode answered 400 to POST /api/session/ses_x/model: bad model",
    });
    expect(String(error)).not.toContain("secret");
  });

  it("lists only models it can read", async () => {
    const { sent, fetch } = recording(() =>
      json({
        data: [{ id: "gpt-5", providerID: "openai", name: "GPT-5" }, { id: "no-name" }, "junk"],
      }),
    );
    const client = makeOpenCodeClient({ baseUrl: "http://h", password: "p", fetch });
    expect(await client.models("/w")).toEqual([
      { id: "gpt-5", providerID: "openai", name: "GPT-5" },
    ]);
    expect(sent[0]?.url).toBe("http://h/api/model?directory=%2Fw");
  });

  it("reads the event stream an event a block, across chunk boundaries", async () => {
    const text =
      'data: {"type":"server.connected","data":{}}\n\n' +
      'event: x\ndata: {"type":"session.execution.started","data":{"sessionID":"s"}}\n\n' +
      ": comment\n\n";
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const { fetch } = recording(() => new Response(body));
    const client = makeOpenCodeClient({ baseUrl: "http://h", password: "p", fetch });
    const seen: Array<OpenCodeEvent> = [];
    await client.subscribe((event) => seen.push(event), new AbortController().signal);
    expect(seen.map((event) => event.type)).toEqual([
      "server.connected",
      "session.execution.started",
    ]);
  });
});
