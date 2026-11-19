import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { carryAttachments } from "./carry-attachments.ts";

const dir = mkdtempSync(join(tmpdir(), "gram-carry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const thread = ThreadId.make("11111111-1111-4111-8111-111111111111");
const other = ThreadId.make("22222222-2222-4222-8222-222222222222");
const attachments = join(dir, "attachments");
const own = join(attachments, thread, "shot.png");
const theirs = join(attachments, other, "theirs.png");
const serverFile = join(dir, "server-state.json");
for (const [path, body] of [
  [own, "own"],
  [theirs, "theirs"],
  [serverFile, "the server's"],
] as const) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

/** Carries `paths` for `thread`, and answers what reached the machine, by name. */
const carried = (paths: ReadonlyArray<string>, within?: string) =>
  Effect.gen(function* () {
    const put: Array<string> = [];
    const store = () =>
      Effect.succeed({
        put: (_: ThreadId, name: string, data: string) =>
          Effect.sync(() => {
            put.push(`${name}=${Buffer.from(data, "base64").toString()}`);
            return { path: `/there/${name}` };
          }),
        remove: () => Effect.void,
      });
    const input = yield* carryAttachments(
      thread,
      { text: "look", attachments: paths.map((path) => ({ path })) },
      "the machine",
      store,
      undefined,
      within,
    );
    return { put, text: input.text };
  });

describe("carryAttachments", () => {
  it.effect("on a server with no local user, carries only the thread's own attachments", () =>
    Effect.gen(function* () {
      const { put, text } = yield* carried([own, theirs, serverFile], attachments);
      // Another thread's attachment and the server's own file never leave for a person's machine.
      expect(put).toEqual(["shot.png=own"]);
      expect(text).toContain("theirs.png (it isn't one of the files attached here)");
      expect(text).toContain("server-state.json (it isn't one of the files attached here)");
    }),
  );

  it.effect("on the desktop, carries a file the user attached from anywhere", () =>
    Effect.gen(function* () {
      const { put } = yield* carried([serverFile]);
      expect(put).toEqual(["server-state.json=the server's"]);
    }),
  );
});
