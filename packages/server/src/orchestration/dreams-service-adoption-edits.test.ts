// Adoption against edits that arrive while it waits, and the failures it reports.
import { describe, expect, it } from "@effect/vitest";
import { FsError } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { Dreams } from "./dreams.ts";
import { OrchestrationMemory } from "./memory.ts";
import {
  collectEvents,
  completeTurn,
  makeWorld,
  openOrchestrator,
  settle,
  waitReal,
} from "./test-harness.ts";
import {
  githubToken,
  memoryRoot,
  withDreams,
  inDreams,
  writeOutput,
  startDream,
  finishDream,
  titles,
} from "./dreams-service-kit.ts";

describe.skipIf(!hasGit)("dreams", () => {
  for (const mode of ["auto", "review"] as const) {
    for (const timing of ["before adoption", "during awaited adoption"] as const) {
      it.effect(`${mode} refuses lossy UTF-8 edits ${timing}`, () =>
        inDreams((world) =>
          Effect.gen(function* () {
            const dreams = yield* Dreams;
            const store = yield* ThreadStore;
            const memory = yield* OrchestrationMemory;
            const { workspaceId } = yield* openOrchestrator(world);
            yield* memory.write(workspaceId, "MEMORY.md", "# Memory\n\ufffd\n");
            const { dream, session } = yield* startDream(workspaceId, undefined, mode);
            const candidate = "# Earlier candidate\n";
            writeOutput(dream, { "MEMORY.md": candidate });
            const path = nodePath.join(
              memoryRoot(world),
              workspaceId,
              "versions",
              "0001",
              "MEMORY.md",
            );
            const newer = Buffer.concat([
              Buffer.from("# Memory\n"),
              Buffer.from([0x81]),
              Buffer.from("\n"),
            ]);
            const edit = Effect.sync(() => fs.writeFileSync(path, newer));
            const original = memory.adopt;
            if (timing === "during awaited adoption") {
              memory.adopt = (id, files, options) =>
                edit.pipe(Effect.andThen(original(id, files, options)));
            }
            if (mode === "review") {
              yield* finishDream(dream, session, "completed");
              const review = yield* dreams.review(dream.id);
              if (timing === "before adoption") yield* edit;
              const result = yield* Effect.result(
                dreams.adopt(dream.id, {
                  basedOn: review.memoryVersion,
                  outputDigest: review.outputDigest,
                  memoryDigest: review.memoryDigest,
                }),
              );
              expect(result._tag).toBe("Failure");
            } else {
              if (timing === "before adoption") yield* edit;
              yield* completeTurn(session, "done");
              const stopped = yield* waitReal(
                "raw auto edit refused",
                store
                  .getDream(dream.id)
                  .pipe(
                    Effect.map(
                      (row) =>
                        (row.adoptionFailure !== undefined || row.adoptedVersion !== undefined) &&
                        row,
                    ),
                  ),
              );
              expect(stopped.adoptionFailure).toBe("refused");
              expect(stopped.adoptedVersion).toBeUndefined();
            }
            expect(yield* memory.currentVersion(workspaceId)).toBe("0001");
            expect(fs.readFileSync(path)).toEqual(newer);
            expect((yield* memory.versions(workspaceId)).map((v) => v.version)).toEqual(["0001"]);
            expect(
              fs.readFileSync(nodePath.join(dream.outputDir, "output", "MEMORY.md"), "utf8"),
            ).toBe(candidate);
            expect(fs.existsSync(nodePath.join(dream.outputDir, "output", "REPORT.md"))).toBe(true);
          }),
        ),
      );
    }
  }

  it.effect("auto detects raw hand edits even when their redacted read is unchanged", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const memory = yield* OrchestrationMemory;
        const { workspaceId } = yield* openOrchestrator(world);
        yield* memory.write(workspaceId, "MEMORY.md", `# Key ${githubToken}\n`);
        const before = yield* memory.index(workspaceId);
        const { dream, session } = yield* startDream(workspaceId, undefined, "auto");
        writeOutput(dream, { "MEMORY.md": "# Candidate\n" });
        const newer = `# Key ${githubToken}\n`;
        const path = nodePath.join(memoryRoot(world), workspaceId, "versions", "0001", "MEMORY.md");
        fs.writeFileSync(path, newer);
        expect(yield* memory.index(workspaceId)).toBe(before);
        yield* completeTurn(session, "done");
        const stopped = yield* waitReal(
          "raw edit refused",
          store.getDream(dream.id).pipe(Effect.map((d) => d.adoptionFailure !== undefined && d)),
        );
        expect(stopped.adoptionFailure).toBe("refused");
        expect(stopped.adoptedVersion).toBeUndefined();
        expect(fs.readFileSync(path, "utf8")).toBe(newer);
        expect((yield* memory.versions(workspaceId)).length).toBe(1);
      }),
    ),
  );

  it.effect("auto refuses a newer adopted version without overwriting it", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const memory = yield* OrchestrationMemory;
        const { workspaceId } = yield* openOrchestrator(world);
        const { dream, session } = yield* startDream(workspaceId, undefined, "auto");
        writeOutput(dream, { "MEMORY.md": "# Stale candidate\n" });
        yield* memory.adopt(workspaceId, [
          { path: "MEMORY.md", content: "# Newer adopted version\n" },
        ]);
        yield* completeTurn(session, "done");
        yield* waitReal(
          "stale auto",
          store.getDream(dream.id).pipe(Effect.map((d) => d.adoptionFailure !== undefined && d)),
        );
        expect(yield* memory.index(workspaceId)).toBe("# Newer adopted version\n");
        expect(yield* memory.currentVersion(workspaceId)).toBe("0002");
        expect((yield* store.getDream(dream.id)).adoptedVersion).toBeUndefined();
      }),
    ),
  );

  it.effect("auto reports persistence failure without a success notice or replay", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const store = yield* ThreadStore;
        const memory = yield* OrchestrationMemory;
        const events = yield* collectEvents(["notify"]);
        const { workspaceId } = yield* openOrchestrator(world);
        const before = yield* memory.index(workspaceId);
        const { dream, session } = yield* startDream(workspaceId, undefined, "auto");
        writeOutput(dream, { "MEMORY.md": "# Valid candidate\n" });
        memory.adopt = () =>
          Effect.fail(new FsError({ path: "CURRENT", message: "Synthetic disk error" }));
        yield* completeTurn(session, "done");
        const ended = yield* waitReal(
          "persistence failed",
          store.getDream(dream.id).pipe(Effect.map((d) => d.adoptionFailure !== undefined && d)),
        );
        expect(ended).toMatchObject({ status: "completed", adoptionFailure: "persistence_error" });
        expect(ended.adoptedVersion).toBeUndefined();
        expect(yield* memory.index(workspaceId)).toBe(before);
        expect(titles(events)).toContain("Dream automatic adoption stopped");
        expect(titles(events)).not.toContain("Dream automatically adopted");
        expect((yield* Effect.flip(dreams.adopt(dream.id))).message).toContain(
          "automatic adoption",
        );
      }),
    ),
  );

  it.effect(
    "auto reports an unconfirmed database failure after CURRENT switches and never retries it",
    () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const dreams = yield* Dreams;
          const store = yield* ThreadStore;
          const memory = yield* OrchestrationMemory;
          const events = yield* collectEvents(["notify"]);
          const { workspaceId } = yield* openOrchestrator(world);
          const { dream, session } = yield* startDream(workspaceId, undefined, "auto");
          writeOutput(dream, { "MEMORY.md": "# Written but not confirmed in SQLite\n" });
          store.putDreamWatermarks = () =>
            Effect.die(new Error("Synthetic database commit failure"));
          yield* completeTurn(session, "done");
          const stopped = yield* waitReal(
            "database failure reported",
            store.getDream(dream.id).pipe(Effect.map((d) => d.adoptionFailure !== undefined && d)),
          );
          expect(stopped).toMatchObject({
            status: "completed",
            adoptionFailure: "persistence_error",
          });
          expect(stopped.adoptedVersion).toBeUndefined();
          expect(yield* memory.currentVersion(workspaceId)).toBe("0002");
          expect(yield* memory.index(workspaceId)).toBe("# Written but not confirmed in SQLite\n");
          expect(titles(events)).not.toContain("Dream automatically adopted");
          yield* completeTurn(session, "duplicate completion");
          yield* settle;
          expect((yield* memory.versions(workspaceId)).length).toBe(2);
          expect((yield* Effect.flip(dreams.adopt(dream.id))).message).toContain(
            "automatic adoption",
          );
        }),
      ),
  );

  it.effect(
    "recovery retains interrupted auto candidates and keeps review rows in review mode",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        const seeded = yield* withDreams(
          world,
          Effect.gen(function* () {
            const store = yield* ThreadStore;
            const { workspaceId } = yield* openOrchestrator(world);
            const { dream, session } = yield* startDream(workspaceId);
            writeOutput(dream, { "MEMORY.md": "# Reviewed output\n" });
            yield* finishDream(dream, session, "completed");
            const auto = yield* startDream(workspaceId, undefined, "auto");
            writeOutput(auto.dream, { "MEMORY.md": "# Interrupted candidate\n" });
            // Durable completion immediately before automatic adoption began, as after a crash.
            yield* store.putDream({
              ...auto.dream,
              status: "completed",
              filesClosedAt: 1,
              endedAt: 2,
            });
            return { workspaceId, reviewed: dream.id, auto: auto.dream.id };
          }),
        );
        for (let attempt = 0; attempt < 2; attempt++) {
          yield* withDreams(
            world,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const memory = yield* OrchestrationMemory;
              const reviewed = yield* store.getDream(seeded.reviewed);
              expect(reviewed.mode).toBe("review");
              expect(reviewed.adoptedVersion).toBeUndefined();
              const auto = yield* store.getDream(seeded.auto);
              expect(auto).toMatchObject({
                mode: "auto",
                status: "completed",
                adoptionFailure: "interrupted",
              });
              expect(auto.adoptedVersion).toBeUndefined();
              expect((yield* memory.versions(seeded.workspaceId)).length).toBe(1);
              expect(fs.existsSync(nodePath.join(auto.outputDir, "output", "MEMORY.md"))).toBe(
                true,
              );
            }),
          );
        }
      }),
  );
});
