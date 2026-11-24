// Archived threads, which a memory update given threads to read reads too.
import { describe, expect, it } from "@effect/vitest";
import { type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { renderClosedThread, ThreadArchive } from "./archive.ts";
import { Dreams } from "./dreams.ts";
import { completeTurn, openOrchestrator, waitReal, waitSent } from "./test-harness.ts";
import {
  githubToken,
  memoryRoot,
  inDreams,
  startDream,
  filesUnder,
  sessionsOf,
  exchange,
  adoptDream,
  dropDream,
} from "./dreams-service-kit.ts";

describe.skipIf(!hasGit)("dreams", () => {
  it.effect("a closed workspace thread is archived, scrubbed, and read by the next dream", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const runtimes = yield* ThreadRuntimes;
        const archive = yield* ThreadArchive;
        const { workspaceId, thread, session, project } = yield* openOrchestrator(world);
        yield* runtimes.send(thread.id, { text: `The deploy token is ${githubToken}` });
        yield* waitSent(thread.id, 2);
        yield* completeTurn(session, "Noted.");

        const plain = yield* runtimes.create({
          projectRoot: world.repo,
          checkout: { kind: "main", path: world.repo },
          input: { text: "unrelated" },
        });
        yield* runtimes.close(plain.id);
        yield* runtimes.close(thread.id);

        const file = nodePath.join(memoryRoot(world), workspaceId, "archive", `${thread.id}.md`);
        yield* waitReal(
          "the archive",
          Effect.sync(() => fs.existsSync(file)),
        );
        const text = fs.readFileSync(file, "utf8");
        expect(text).toContain("# Orchestrator · shop");
        expect(text).toContain(`orchestrator thread ${thread.id}`);
        expect(text).toContain("The deploy token is [redacted]");
        expect(text).not.toContain(githubToken);
        expect((yield* archive.list(workspaceId)).map((entry) => entry.threadId)).toEqual([
          thread.id,
        ]);
        expect(project.id).toBe((yield* store.getWorkspace(workspaceId)).workspace.homeProjectId);

        const dreams = yield* Dreams;
        expect((yield* dreams.preview({ workspaceId })).archivedThreads).toBe(1);
        // A memory update reads no transcript unless given threads to read, archived ones too.
        const dream = yield* dreams.start({ workspaceId, kind: "dream", threadIds: [thread.id] });
        expect(dream.inputs.threadIds).toEqual([thread.id]);
        const names = filesUnder(nodePath.join(dream.outputDir, "input", "sessions"));
        expect(names).toHaveLength(1);
        expect(names[0]).toContain("archived");
        // A dream's own thread is not archived when it goes.
        yield* dreams.cancel(dream.id);
        yield* dreams.discard(dream.id);
        expect((yield* archive.list(workspaceId)).map((entry) => entry.threadId)).toEqual([
          thread.id,
        ]);
      }),
    ),
  );
});
