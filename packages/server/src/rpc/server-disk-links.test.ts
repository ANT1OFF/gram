// A call that reads this server's own disk follows links here, whoever else holds the path: a link
// inside a folder another machine holds can't reach a thread's folder its caller may not see.

import { afterEach, describe, expect, it } from "@effect/vitest";
import { type Thread, ThreadId } from "@gram/contracts";
import { forgetForeignPathsForTest, noteForeignPath } from "@gram/git";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notePrivacy, touchesUnreadable } from "../embedding/readable-by.ts";
import { readsServerDisk } from "./server-disk.ts";

afterEach(() => forgetForeignPathsForTest());

describe("a call on this server's disk", () => {
  it("follows a link inside another machine's folder to a thread's private folder", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gram-disk-")));
    try {
      const secret = join(dir, "alice-work");
      const shared = join(dir, "shared");
      mkdirSync(secret);
      mkdirSync(shared);
      symlinkSync(secret, join(shared, "link"));
      notePrivacy({
        id: ThreadId.make("t-disk-links"),
        readableBy: "alice",
        checkout: { kind: "main", path: secret },
      } as unknown as Thread);
      // A joined machine records a folder at the same path as this one.
      noteForeignPath(shared);
      const named = join(shared, "link", "notes.md");
      const bob = { subject: "bob" };
      for (const [action, payload] of [
        ["fs.browse", { path: named }],
        ["fs.tree", { root: named }],
        ["fs.list", { path: named }],
      ] as const)
        expect(touchesUnreadable(bob, [named], "act", readsServerDisk(action, payload))).toBe(true);
      // A listing of a thread's folder is on that thread's machine, read there.
      expect(readsServerDisk("fs.list", { path: named, threadId: "t-1" })).toBe(false);
      expect(touchesUnreadable({ subject: "alice" }, [named], "act", true)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
