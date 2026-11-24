import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { threadTmpDir } from "./sessions.ts";

const root = mkdtempSync(join(tmpdir(), "gram-thread-tmp-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("a thread's own temp folder on a machine", () => {
  it("is one folder a thread, this user's alone, and the same one each time", async () => {
    const first = await threadTmpDir("t-one", root);
    const other = await threadTmpDir("t-two", root);
    expect(first).toBeDefined();
    expect(other).not.toBe(first);
    expect(await threadTmpDir("t-one", root)).toBe(first);
    expect(statSync(first!).mode & 0o777).toBe(0o700);
    // A thread id is never a path out of the temp root.
    expect(await threadTmpDir("../../etc", root)).toBe(join(root, "gram-tmp-______etc"));
  });

  it("gives none where the folder can't be made, so the session keeps the machine's", async () => {
    expect(await threadTmpDir("t-one", join(root, "t-one-as-a-file\0"))).toBeUndefined();
  });
});
