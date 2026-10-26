import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
  closeSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { snapshotCandidate, type CandidateSnapshot } from "./native-snapshot.ts";
import { createSquirrelFeed, type SquirrelFeed } from "./native-squirrel-feed.ts";

const verifiedBytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x18); // "rc.18", verified
const olderBytes = Buffer.alloc(verifiedBytes.length, 0x16); // "rc.16", same length

const open: Array<CandidateSnapshot | SquirrelFeed> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((each) => each.close()));
});

/** electron-updater's shared cache path, with the verified download in it. */
function cache(bytes = verifiedBytes) {
  const path = join(mkdtempSync(join(tmpdir(), "gram-updater-cache-")), "update.zip");
  writeFileSync(path, bytes);
  return path;
}

function fetch(url: string) {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const req = request(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("aborted")));
    });
    req.on("error", reject);
    req.end();
  });
}

/** What Squirrel.Mac does: the feed's JSON, then the ZIP it names. */
async function squirrelDownload(feed: SquirrelFeed) {
  const answer = await fetch(feed.feedURL);
  const { url } = JSON.parse(answer.body.toString()) as { url: string };
  return fetch(url);
}

async function staged(path: string) {
  const snapshot = await snapshotCandidate(path, tmpdir());
  const feed = await createSquirrelFeed(snapshot, "0.1.0-rc.18");
  open.push(feed, snapshot);
  return { snapshot, feed };
}

describe("the Squirrel.Mac feed", () => {
  it("serves the verified snapshot even when the cache is replaced after verification", async () => {
    const path = cache();
    const { snapshot, feed } = await staged(path);
    expect(snapshot.sha256).toBe(createHash("sha256").update(verifiedBytes).digest("hex"));
    // The reviewer's attack: an older same-team ZIP over electron-updater's cache, mid-fence.
    writeFileSync(path, olderBytes);
    rmSync(path);
    writeFileSync(path, olderBytes);
    const served = await squirrelDownload(feed);
    expect(served.status).toBe(200);
    expect(served.body.equals(verifiedBytes)).toBe(true);
  });

  it("never completes a ZIP whose bytes no longer match the verified digest", async () => {
    const { snapshot, feed } = await staged(cache());
    // Even the private copy changed in place: the descriptor sees it, the digest catches it.
    chmodSync(snapshot.path, 0o600);
    const fd = openSync(snapshot.path, "r+");
    writeSync(fd, Buffer.from([0x16]), 0, 1, verifiedBytes.length - 1);
    closeSync(fd);
    await expect(squirrelDownload(feed)).rejects.toThrow();
  });

  it("answers nothing but its own feed and ZIP, a few times at most", async () => {
    const { feed } = await staged(cache());
    const base = new URL(feed.feedURL);
    expect((await fetch(new URL("/", base).href)).status).toBe(404);
    expect(
      (await fetch(new URL(base.pathname.replace(/[a-f0-9]{8}/, "00000000"), base).href)).status,
    ).toBe(404);
    for (let i = 0; i < 4; i++) expect((await fetch(feed.feedURL)).status).toBe(200);
    expect((await fetch(feed.feedURL)).status).toBe(429);
  });

  it("stops serving once the attempt closes it", async () => {
    const { feed } = await staged(cache());
    await feed.close();
    await expect(fetch(feed.feedURL)).rejects.toThrow();
  });
});

describe("snapshotCandidate", () => {
  it("is a read-only private copy that knows when its path no longer names it", async () => {
    const snapshot = await snapshotCandidate(cache(), tmpdir());
    open.push(snapshot);
    expect(await snapshot.intact()).toBe(true);
    chmodSync(snapshot.path, 0o600);
    rmSync(snapshot.path);
    writeFileSync(snapshot.path, verifiedBytes);
    expect(await snapshot.intact()).toBe(false);
  });
});
