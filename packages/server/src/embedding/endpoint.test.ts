import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { postJson } from "./endpoint.ts";

// A token from a file is read again for every call, so one replaced while the server runs is the
// one sent next.

let dir: string;
let server: Server;
let url: string;
const seen: Array<string | undefined> = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gram-endpoint-"));
  server = createServer((request, response) => {
    seen.push(request.headers.authorization);
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe("an endpoint's token file", () => {
  it("is read for every call, and a file that can't be used fails the call without its text", async () => {
    const file = join(dir, "token");
    await writeFile(file, "first-token\n");
    expect(await Effect.runPromise(postJson({ url, tokenFile: file }, {}, 5000))).toEqual({
      ok: true,
    });
    await writeFile(file, "second-token");
    await Effect.runPromise(postJson({ url, tokenFile: file }, {}, 5000));
    expect(seen).toEqual(["Bearer first-token", "Bearer second-token"]);

    await writeFile(file, "two words");
    const unusable = await Effect.runPromiseExit(postJson({ url, tokenFile: file }, {}, 5000));
    expect(Exit.isFailure(unusable)).toBe(true);
    expect(JSON.stringify(unusable)).not.toContain("two words");
    const missing = await Effect.runPromiseExit(
      postJson({ url, tokenFile: join(dir, "nothing") }, {}, 5000),
    );
    expect(JSON.stringify(missing)).toContain("the token file could not be read");
    expect(seen).toHaveLength(2);
  });
});
