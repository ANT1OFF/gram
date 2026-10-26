import { describe, expect, it } from "@effect/vitest";
import type { GramUIMessage, ThreadId, WorkspaceId, WorkspaceState } from "@gram/contracts";
import * as Effect from "effect/Effect";

import { renderClosedThread, type ThreadArchiveShape } from "./archive.ts";
import {
  archivedHeading,
  briefOf,
  changedFilesOf,
  makeFinishedWorkers,
} from "./finished-workers.ts";

const WS = "w1" as WorkspaceId;
const ID = "11111111-2222-3333-4444-555555555555" as ThreadId;

const text = (role: "user" | "assistant", body: string) =>
  ({ id: `${role}-${body.length}`, role, parts: [{ type: "text", text: body }] }) as GramUIMessage;

const archivedText = renderClosedThread(
  {
    id: ID,
    title: "Spike: SQS or Redis",
    spawnedBy: { threadId: "o" as ThreadId, feature: "queue-choice" },
  },
  [
    { seq: 1, message: text("user", "Compare SQS and Redis streams for the mail queue.") },
    {
      seq: 2,
      message: text("assistant", "Redis streams: cheaper here, and we run Redis already."),
    },
  ],
)!;

const archive = {
  list: () => Effect.succeed([{ threadId: ID, bytes: archivedText.length, archivedAt: 5_000 }]),
  read: (_workspace: string, threadId: string) =>
    threadId === ID ? Effect.succeed(archivedText) : Effect.fail(new Error("no such transcript")),
} as unknown as Pick<ThreadArchiveShape, "list" | "read">;

const store = {
  listClosed: Effect.succeed([]),
  listClosedMessages: () => Effect.succeed([]),
  listWorkerReports: () => Effect.succeed([]),
  listThreads: Effect.succeed([]),
  listWorkspaces: Effect.succeed([{ workspace: { id: WS } } as unknown as WorkspaceState]),
};

const edit = (path: string, content: string) =>
  ({
    type: "tool-Write",
    toolCallId: path,
    state: "output-available",
    input: { file_path: path, content },
    output: { type: "create", filePath: path, content },
  }) as unknown as GramUIMessage["parts"][number];

describe("finished workers", () => {
  it("reads a worker's name, feature and id from its archived transcript's heading", () => {
    expect(archivedHeading(archivedText)).toEqual({
      title: "Spike: SQS or Redis",
      feature: "queue-choice",
      threadId: ID,
    });
    expect(archivedHeading("# Notes\n\nSource: thread abc")).toBeUndefined();
  });

  it("sums a transcript's edits per file and quotes the brief", () => {
    const messages = [
      text("user", "Add the table."),
      { id: "a", role: "assistant", parts: [edit("a.py", "1\n2\n"), edit("b.py", "1\n")] },
    ] as GramUIMessage[];
    expect(changedFilesOf(messages)).toEqual([
      { path: "a.py", additions: 2, deletions: 0 },
      { path: "b.py", additions: 1, deletions: 0 },
    ]);
    expect(briefOf(messages)).toBe("Add the table.");
    expect(briefOf([])).toBeUndefined();
  });

  it.effect("lists and opens a worker only the archive still has", () =>
    Effect.gen(function* () {
      const finished = makeFinishedWorkers({ store, archive });
      expect(yield* finished.list(WS)).toEqual([
        {
          threadId: ID,
          workspaceId: WS,
          title: "Spike: SQS or Redis",
          feature: "queue-choice",
          closedAt: 5_000,
          prs: [],
          kept: "archived",
        },
      ]);
      const detail = yield* finished.detail(ID);
      expect(detail.worker.kept).toBe("archived");
      expect(detail.messages).toEqual([]);
      expect(detail.archived).toContain("Redis streams");
      const gone = yield* finished.detail("other" as ThreadId).pipe(Effect.flip);
      expect(gone._tag).toBe("ThreadNotFound");
      // Without an archive only closed records are read.
      expect(yield* makeFinishedWorkers({ store, archive: undefined }).list(WS)).toEqual([]);
    }),
  );
});
