// Automatic and reviewed adoption: what a dream may adopt, and what refuses it.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { hasGit } from "../git/test-repo.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { Dreams } from "./dreams.ts";
import { OrchestrationMemory } from "./memory.ts";
import { Orchestration } from "./service.ts";
import { completeTurn, openOrchestrator, settle, waitReal } from "./test-harness.ts";
import {
  type DreamWorld,
  noValidation,
  inDreams,
  waitDream,
  writeOutput,
  startDream,
  finishDream,
} from "./dreams-service-kit.ts";

describe.skipIf(!hasGit)("dreams", () => {
  it.effect("auto refuses changed memory even when CURRENT has not changed", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const store = yield* ThreadStore;
        const memory = yield* OrchestrationMemory;
        const { workspaceId } = yield* openOrchestrator(world);
        const { dream, session } = yield* startDream(workspaceId, undefined, "auto");
        writeOutput(dream, { "MEMORY.md": "# Candidate\n" });
        const newer = "# Newer user edit, exact bytes\n\nPreserve me.\n";
        yield* memory.write(workspaceId, "MEMORY.md", newer);
        yield* completeTurn(session, "done");
        const stopped = yield* waitReal(
          "auto stopped",
          store
            .getDream(dream.id)
            .pipe(Effect.map((row) => row.adoptionFailure !== undefined && row)),
        );
        expect(stopped.adoptionFailure).toBe("refused");
        expect(stopped.adoptedVersion).toBeUndefined();
        expect(yield* memory.currentVersion(workspaceId)).toBe("0001");
        expect(yield* memory.index(workspaceId)).toBe(newer);
        expect((yield* Effect.flip(dreams.adopt(dream.id))).message).toContain(
          "automatic adoption",
        );
      }),
    ),
  );

  it.effect("reviewed adoption refuses a newer same-version edit during awaited adoption", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const memory = yield* OrchestrationMemory;
        const { workspaceId } = yield* openOrchestrator(world);
        const { dream, session } = yield* startDream(workspaceId);
        writeOutput(dream, { "MEMORY.md": "# Older candidate\n" });
        yield* finishDream(dream, session, "completed");
        const review = yield* dreams.review(dream.id);
        const original = memory.adopt;
        const newer = "# Newer in-place user edit\n\nExact bytes retained.\n";
        memory.adopt = (id, files, options) =>
          memory.write(id, "MEMORY.md", newer).pipe(Effect.andThen(original(id, files, options)));
        const result = yield* Effect.result(
          dreams.adopt(dream.id, {
            basedOn: review.memoryVersion,
            outputDigest: review.outputDigest,
            memoryDigest: review.memoryDigest,
          }),
        );
        expect(result._tag).toBe("Failure");
        expect(yield* memory.currentVersion(workspaceId)).toBe("0001");
        expect(yield* memory.index(workspaceId)).toBe(newer);
        expect((yield* memory.versions(workspaceId)).map((v) => v.version)).toEqual(["0001"]);
      }),
    ),
  );

  it.effect("reviewed adoption refuses a changed same-version review and serialises replay", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const dreams = yield* Dreams;
        const memory = yield* OrchestrationMemory;
        const { workspaceId } = yield* openOrchestrator(world);
        const { dream, session } = yield* startDream(workspaceId);
        writeOutput(dream, { "MEMORY.md": "# Reviewed candidate\n" });
        yield* finishDream(dream, session, "completed");
        const old = yield* dreams.review(dream.id);
        yield* memory.write(workspaceId, "MEMORY.md", "# Newer\n");
        expect(
          (yield* Effect.flip(dreams.adopt(dream.id, { memoryDigest: old.memoryDigest }))).message,
        ).toContain("changed since this review");
        const fresh = yield* dreams.review(dream.id);
        const results = yield* Effect.all(
          [1, 2].map(() =>
            Effect.result(
              dreams.adopt(dream.id, {
                basedOn: fresh.memoryVersion,
                memoryDigest: fresh.memoryDigest,
                outputDigest: fresh.outputDigest,
                resolutions: { "MEMORY.md": "current" },
              }),
            ),
          ),
          { concurrency: "unbounded" },
        );
        expect(results.map((r) => r._tag).toSorted()).toEqual(["Failure", "Success"]);
        expect((yield* memory.versions(workspaceId)).length).toBe(2);
        expect(yield* memory.index(workspaceId)).toBe("# Newer\n");
      }),
    ),
  );

  for (const outcome of ["missing_report", "input_tampered", "agent_error", "canceled"] as const) {
    it.effect(`auto never adopts ${outcome} output`, () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const dreams = yield* Dreams;
          const store = yield* ThreadStore;
          const memory = yield* OrchestrationMemory;
          const { workspaceId } = yield* openOrchestrator(world);
          const before = yield* memory.index(workspaceId);
          const { dream, session } = yield* startDream(workspaceId, undefined, "auto");
          writeOutput(dream, { "MEMORY.md": "# Partial candidate\n" });
          if (outcome === "missing_report")
            fs.unlinkSync(nodePath.join(dream.outputDir, "output", "REPORT.md"));
          if (outcome === "input_tampered") {
            fs.chmodSync(nodePath.join(dream.outputDir, "input", "memory", "MEMORY.md"), 0o600);
            fs.writeFileSync(
              nodePath.join(dream.outputDir, "input", "memory", "MEMORY.md"),
              "tampered\n",
            );
          }
          if (outcome === "canceled") yield* dreams.cancel(dream.id);
          else if (outcome === "agent_error") {
            yield* session.emit({
              type: "turnEnd",
              reason: "error",
              error: "Synthetic failure",
            });
          } else yield* completeTurn(session, "done");
          const ended = yield* waitDream(dream.id, outcome === "canceled" ? "canceled" : "failed");
          expect(ended.failure).toBe(outcome);
          yield* completeTurn(session, "late completion");
          yield* settle;
          expect((yield* store.getDream(dream.id)).adoptedVersion).toBeUndefined();
          expect(yield* memory.index(workspaceId)).toBe(before);
          expect((yield* memory.versions(workspaceId)).length).toBe(1);
        }),
      ),
    );
  }

  for (const change of ["cancel", "rebind", "workspace", "output"] as const) {
    it.effect(`auto rejects ${change} during final validation and preserves memory`, () => {
      let hook: NonNullable<DreamWorld["onValidation"]> = noValidation;
      let outputs = 0;
      return inDreams(
        (world) =>
          Effect.gen(function* () {
            const dreams = yield* Dreams;
            const store = yield* ThreadStore;
            const memory = yield* OrchestrationMemory;
            const { workspaceId } = yield* openOrchestrator(world);
            const before = yield* memory.index(workspaceId);
            const state = yield* store.getWorkspace(workspaceId);
            const other = yield* (yield* Orchestration).saveWorkspace({
              name: "Other synthetic workspace",
              projectIds: state.workspace.projectIds,
              homeProjectId: state.workspace.homeProjectId,
            });
            yield* memory.write(
              other.workspace.id,
              "MEMORY.md",
              "# Other workspace, exact bytes\n",
            );
            const { dream, session } = yield* startDream(workspaceId, undefined, "auto");
            writeOutput(dream, { "MEMORY.md": "# First validated candidate\n" });
            hook = (stage) =>
              Effect.gen(function* () {
                if (change === "output") {
                  if (stage === "output" && ++outputs === 2)
                    writeOutput(dream, { "MEMORY.md": "# Changed after successful validation\n" });
                  return;
                }
                if (stage !== "baseline") return;
                hook = noValidation;
                if (change === "cancel") yield* dreams.cancel(dream.id);
                else if (change === "workspace")
                  yield* store.updateThread(dream.threadId!, (t) => ({
                    ...t,
                    workspaceId: other.workspace.id,
                  }));
                else
                  yield* store.updateThread(dream.threadId!, (t) => ({
                    ...t,
                    checkout: { ...t.checkout, path: world.dir },
                  }));
              }).pipe(Effect.orDie);
            yield* completeTurn(session, "done");
            const stopped =
              change === "cancel"
                ? yield* waitDream(dream.id, "canceled")
                : yield* waitReal(
                    "unsafe auto stopped",
                    store
                      .getDream(dream.id)
                      .pipe(Effect.map((d) => d.adoptionFailure !== undefined && d)),
                  );
            expect(stopped.adoptedVersion).toBeUndefined();
            expect(yield* memory.index(workspaceId)).toBe(before);
            expect(yield* memory.index(other.workspace.id)).toBe(
              "# Other workspace, exact bytes\n",
            );
            expect((yield* memory.versions(workspaceId)).length).toBe(1);
          }),
        { onValidation: (stage, id) => hook(stage, id) },
      );
    });
  }

  it.effect("auto refuses a newer in-place edit during awaited adoption", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const memory = yield* OrchestrationMemory;
        const { workspaceId } = yield* openOrchestrator(world);
        const { dream, session } = yield* startDream(workspaceId, undefined, "auto");
        writeOutput(dream, { "MEMORY.md": "# Earlier candidate\n" });
        const original = memory.adopt;
        const newer = "# Newer while auto awaited\n\nExact bytes.\n";
        memory.adopt = (id, files, options) =>
          memory.write(id, "MEMORY.md", newer).pipe(Effect.andThen(original(id, files, options)));
        yield* completeTurn(session, "done");
        const stopped = yield* waitReal(
          "auto race refused",
          store.getDream(dream.id).pipe(Effect.map((d) => d.adoptionFailure !== undefined && d)),
        );
        expect(stopped.adoptedVersion).toBeUndefined();
        expect(stopped.adoptionFailure).toBe("refused");
        expect(yield* memory.currentVersion(workspaceId)).toBe("0001");
        expect(yield* memory.index(workspaceId)).toBe(newer);
        expect((yield* memory.versions(workspaceId)).length).toBe(1);
      }),
    ),
  );
});
