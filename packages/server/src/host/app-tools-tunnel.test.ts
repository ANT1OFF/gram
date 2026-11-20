import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeAppToolsTunnel } from "./app-tools-tunnel.ts";

const post = (url: string, headers: Record<string, string> = {}) =>
  Effect.promise(() =>
    fetch(`${url}/host/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json", ...headers },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    }).then(async (response) => ({ status: response.status, body: await response.text() })),
  );

describe("a host's app-tools tunnel", () => {
  it.live("carries a session's call to the control plane and writes its answer back", () =>
    Effect.gen(function* () {
      const tunnel = yield* makeAppToolsTunnel;
      const { url } = yield* tunnel.open;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      yield* tunnel.requests.pipe(
        Stream.runForEach((call) =>
          tunnel.answer({
            id: call.id,
            status: 200,
            headers: { "content-type": "application/json", "x-not-passed": "no" },
            body: JSON.stringify({ got: call.body, token: call.headers["authorization"] }),
          }),
        ),
        Effect.forkScoped,
      );
      const answered = yield* post(url);
      expect(answered).toEqual({
        status: 200,
        body: JSON.stringify({
          got: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
          token: "Bearer t",
        }),
      });
    }).pipe(Effect.scoped),
  );

  it.live("refuses a call from a page or one a proxy passed on, and carries none of them", () =>
    Effect.gen(function* () {
      const tunnel = yield* makeAppToolsTunnel;
      const { url } = yield* tunnel.open;
      for (const headers of [
        { origin: "https://example.test" },
        { "x-forwarded-for": "10.0.0.1" },
        { forwarded: "for=10.0.0.1" },
      ])
        expect((yield* post(url, headers)).status, JSON.stringify(headers)).toBe(403);
      // Nothing reached the control plane.
      const none = yield* tunnel.requests.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeoutOption("200 millis"),
      );
      expect(none._tag).toBe("None");
    }).pipe(Effect.scoped),
  );
});
