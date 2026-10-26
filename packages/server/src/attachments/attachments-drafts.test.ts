import { describe, expect, it } from "@effect/vitest";
import { InvalidState, type DraftId, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptDraftAttachments, makeAttachments, withDraftAttachments } from "./attachments.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const draftId = "5a9b6bc9-01d5-4fb3-aacf-ec410b8b74d5" as DraftId;
const threadId = "t1" as ThreadId;

const tempDir = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "gram-draft-attachments-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  );
  return dir;
});

const service = (dir: string, draftMaxAgeMs?: number) =>
  makeAttachments({
    dir,
    threadExists: () => Effect.die("drafts don't look up a thread"),
    closedThreads: Stream.empty,
    ...(draftMaxAgeMs === undefined ? {} : { draftMaxAgeMs }),
  });

describe("draft attachments", () => {
  it.effect("stage without a thread, then move into the thread when it's created", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const attachments = yield* service(dir);
      const staged = yield* attachments.upload({
        draftId,
        name: "image.png",
        mediaType: "image/png",
        data: PNG.toString("base64"),
      });
      const draftDir = join(dir, "_drafts", draftId);
      expect(staged.path.startsWith(draftDir)).toBe(true);

      const onDisk = { path: "/Users/x/notes.md", name: "notes.md" };
      const adopted = yield* adoptDraftAttachments(dir, draftId, threadId, {
        text: "look",
        attachments: [staged, onDisk],
      });
      const moved = adopted?.attachments?.[0];
      expect(moved?.path).toBe(join(dir, "t1", staged.path.slice(draftDir.length + 1)));
      expect(readFileSync(moved!.path)).toEqual(PNG);
      expect(existsSync(draftDir)).toBe(false);
      expect(adopted?.attachments?.[1]).toEqual(onDisk);
      expect(adopted?.text).toBe("look");
    }),
  );

  it.effect("adopting a draft with nothing staged changes nothing", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const input = { text: "hello", attachments: [{ path: "/Users/x/notes.md" }] };
      expect(yield* adoptDraftAttachments(dir, draftId, threadId, input)).toBe(input);
      expect(existsSync(join(dir, "t1"))).toBe(false);
    }),
  );

  it.effect("rejects an upload with neither a thread nor a draft", () =>
    Effect.gen(function* () {
      const attachments = yield* service(yield* tempDir);
      const error = yield* attachments
        .upload({ name: "a.png", mediaType: "image/png", data: PNG.toString("base64") })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidState);
    }),
  );

  it.live("prunes draft folders older than the TTL when the service starts", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const old = join(dir, "_drafts", "old-draft-0001");
      const fresh = join(dir, "_drafts", "fresh-draft-0001");
      for (const folder of [old, fresh]) {
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "image.png"), PNG);
      }
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      utimesSync(old, twoDaysAgo, twoDaysAgo);

      yield* service(dir, 24 * 60 * 60 * 1000);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    }),
  );

  it.effect("keeps pruning stale drafts hourly while the service runs", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const draft = join(dir, "_drafts", "abandoned-draft-01");
      mkdirSync(draft, { recursive: true });
      writeFileSync(join(draft, "image.png"), PNG);
      // The TTL compares the clock with the folder's real modification time.
      yield* TestClock.setTime(Math.floor(statSync(draft).mtimeMs));
      const pruned = yield* Queue.unbounded<void>();

      yield* makeAttachments({
        dir,
        threadExists: () => Effect.die("drafts don't look up a thread"),
        closedThreads: Stream.empty,
        draftMaxAgeMs: 24 * 60 * 60 * 1000,
        onPruned: Queue.offer(pruned, undefined).pipe(Effect.asVoid),
      });
      yield* Queue.take(pruned);
      for (let hour = 1; hour <= 24; hour++) {
        yield* TestClock.adjust("1 hour");
        yield* Queue.take(pruned);
        expect(existsSync(draft), `still staged at hour ${hour}`).toBe(true);
      }
      yield* TestClock.adjust("1 hour");
      yield* Queue.take(pruned);
      expect(existsSync(draft)).toBe(false);
    }),
  );
});

const staged = (dir: string) =>
  Effect.gen(function* () {
    const attachments = yield* service(dir);
    return yield* attachments.upload({
      draftId,
      name: "image.png",
      mediaType: "image/png",
      data: PNG.toString("base64"),
    });
  });

describe("creating a thread from a draft", () => {
  it.effect("returns the files to the draft when create fails, so a retry still has them", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const file = yield* staged(dir);
      const input = { text: "look", attachments: [file] };

      const error = yield* withDraftAttachments(dir, draftId, threadId, input, (adopted) => {
        expect(adopted?.attachments?.[0]?.path.startsWith(join(dir, "t1"))).toBe(true);
        return Effect.fail(new InvalidState({ message: "the agent didn't start" }));
      }).pipe(Effect.flip);
      expect(error.message).toBe("the agent didn't start");
      expect(readFileSync(file.path)).toEqual(PNG);
      expect(existsSync(join(dir, "t1"))).toBe(false);

      const retried = yield* withDraftAttachments(
        dir,
        draftId,
        "t2" as ThreadId,
        input,
        (adopted) => Effect.succeed(adopted),
      );
      const moved = retried?.attachments?.[0]?.path ?? "";
      expect(moved.startsWith(join(dir, "t2"))).toBe(true);
      expect(readFileSync(moved)).toEqual(PNG);
    }),
  );

  it.effect("adds to a thread's folder that is there already, and takes back only its own", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const file = yield* staged(dir);
      const own = join(dir, "t1", "own.png");
      mkdirSync(join(dir, "t1"));
      writeFileSync(own, PNG);
      const input = { text: "look", attachments: [file] };

      yield* withDraftAttachments(dir, draftId, threadId, input, (adopted) => {
        expect(readFileSync(adopted!.attachments![0]!.path)).toEqual(PNG);
        return Effect.fail(new InvalidState({ message: "the orchestrator is gone" }));
      }).pipe(Effect.flip);
      expect(readFileSync(file.path)).toEqual(PNG);
      expect(existsSync(own)).toBe(true);

      const sent = yield* withDraftAttachments(dir, draftId, threadId, input, (adopted) =>
        Effect.succeed(adopted),
      );
      const moved = sent?.attachments?.[0]?.path ?? "";
      expect(moved.startsWith(join(dir, "t1"))).toBe(true);
      expect(readFileSync(moved)).toEqual(PNG);
      expect(existsSync(own)).toBe(true);
      expect(existsSync(join(dir, "_drafts", draftId))).toBe(false);
    }),
  );

  it.effect("puts every file back in the draft when a merge into the thread's folder fails", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const draftDir = join(dir, "_drafts", draftId);
      mkdirSync(draftDir, { recursive: true });
      writeFileSync(join(draftDir, "a.png"), PNG);
      writeFileSync(join(draftDir, "b.png"), PNG);
      // A folder in the way of one file makes its rename fail, whichever order they go in.
      mkdirSync(join(dir, "t1", "b.png", "taken"), { recursive: true });
      const input = {
        text: "look",
        attachments: [{ path: join(draftDir, "a.png") }, { path: join(draftDir, "b.png") }],
      };

      const error = yield* withDraftAttachments(dir, draftId, threadId, input, () =>
        Effect.die("create must not run"),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(InvalidState);
      expect(readFileSync(join(draftDir, "a.png"))).toEqual(PNG);
      expect(readFileSync(join(draftDir, "b.png"))).toEqual(PNG);
      expect(existsSync(join(dir, "t1", "a.png"))).toBe(false);
    }),
  );

  it.effect("deletes the files when they can't go back to the draft", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir;
      const file = yield* staged(dir);
      const draftDir = join(dir, "_drafts", draftId);

      yield* withDraftAttachments(dir, draftId, threadId, { text: "", attachments: [file] }, () =>
        Effect.gen(function* () {
          // Something else took the draft's folder while create ran.
          mkdirSync(draftDir);
          writeFileSync(join(draftDir, "other.png"), PNG);
          return yield* new InvalidState({ message: "the agent didn't start" });
        }),
      ).pipe(Effect.flip);
      expect(existsSync(join(dir, "t1"))).toBe(false);
      expect(existsSync(join(draftDir, "other.png"))).toBe(true);
    }),
  );
});
