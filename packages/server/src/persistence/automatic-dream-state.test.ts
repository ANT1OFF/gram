import { describe, expect, it } from "@effect/vitest";
import {
  AutomaticDreamThreshold,
  DEFAULT_CHARTER,
  type Dream,
  type DreamId,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "./thread-store.ts";

const withStore = <A, E>(path: string, body: Effect.Effect<A, E, ThreadStore>) =>
  Effect.scoped(body.pipe(Effect.provide(ThreadStore.layerSqlite(path).pipe(Layer.orDie))));

const storedDream = (workspaceId: WorkspaceId, id: string, status: Dream["status"]): Dream => ({
  id: id as DreamId,
  workspaceId,
  status,
  kind: "dream",
  mode: "review",
  inputs: { memoryVersion: "", threadIds: [], agentSessions: [] },
  model: { agent: "claude", model: "default" },
  outputDir: "/synthetic/dream",
  createdAt: 0,
});

describe("automatic Dream persistence", () => {
  it("refuses noninteger, zero and unbounded thresholds", () => {
    for (const threshold of [0, -1, 1.5, 1001, Infinity, NaN])
      expect(() => Schema.decodeUnknownSync(AutomaticDreamThreshold)(threshold)).toThrow();
    for (const threshold of [1, 10, 1000])
      expect(Schema.decodeUnknownSync(AutomaticDreamThreshold)(threshold)).toBe(threshold);
  });
  it.effect("config baselines observe only a current owning run and invalidate prior claims", () =>
    withStore(
      ":memory:",
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root: "/synthetic/repo", name: "synthetic" });
        const id = "workspace" as WorkspaceId;
        const workspace: WorkspaceState = {
          workspace: {
            id,
            name: "synthetic",
            projectIds: [project.id],
            homeProjectId: project.id,
            createdAt: 0,
          },
          charter: DEFAULT_CHARTER,
        };
        yield* store.putWorkspace(workspace);
        for (const status of ["completed", "failed", "canceled"] as const)
          yield* store.putDream(storedDream(id, `${status}-dream`, status));
        yield* store.putDream(storedDream("foreign" as WorkspaceId, "foreign-running", "running"));
        yield* store.updateWorkspace(id, (state) => ({
          ...state,
          charter: { ...state.charter, automaticDreamThreshold: 1 },
        }));
        expect((yield* store.getAutomaticDreamState(id))?.observedDreamId).toBeUndefined();
        yield* store.putDream(storedDream(id, "active-dream", "running"));
        yield* store.updateAutomaticDreamState(id, (state) => ({
          ...state,
          completed: 1,
          lastDreamId: "old-run",
          lastAttemptId: "old-claim",
        }));
        const previous = yield* store.getAutomaticDreamState(id);
        yield* store.updateWorkspace(id, (state) => ({
          ...state,
          charter: { ...state.charter, automaticDreamThreshold: 2 },
        }));
        const edited = yield* store.getAutomaticDreamState(id);
        expect(edited).toMatchObject({
          threshold: 2,
          completed: 0,
          observedDreamId: "active-dream",
        });
        expect(edited?.epoch).not.toBe(previous?.epoch);
        expect(edited?.lastDreamId).toBeUndefined();
        expect(edited?.lastAttemptId).toBeUndefined();
        yield* store.updateWorkspace(id, ({ charter, ...state }) => {
          const { automaticDreamThreshold: _threshold, ...disabled } = charter;
          return { ...state, charter: disabled };
        });
        yield* store.updateWorkspace(id, (state) => ({
          ...state,
          charter: { ...state.charter, automaticDreamThreshold: 2 },
        }));
        const enabled = yield* store.getAutomaticDreamState(id);
        expect(enabled?.observedDreamId).toBe("active-dream");
        expect(enabled?.epoch).not.toBe(edited?.epoch);
        yield* store.putDream(storedDream(id, "active-dream", "completed"));
        yield* store.updateWorkspace(id, (state) => ({
          ...state,
          charter: { ...state.charter, automaticDreamThreshold: 3 },
        }));
        expect((yield* store.getAutomaticDreamState(id))?.observedDreamId).toBeUndefined();
      }),
    ),
  );
  it.effect(
    "atomically baselines settings edits, preserves unrelated saves, and survives an actual SQLite reopen",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* Effect.acquireRelease(
            Effect.sync(() => mkdtempSync(join(tmpdir(), "gram-automatic-dream-"))),
            (ownedDir) => Effect.sync(() => rmSync(ownedDir, { recursive: true, force: true })),
          );
          const path = join(dir, "state.sqlite");
          const id = "workspace" as WorkspaceId;
          yield* withStore(
            path,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              const project = yield* store.ensureProject({
                root: "/synthetic/repo",
                name: "synthetic",
              });
              const thread: Thread = {
                id: "old" as ThreadId,
                projectId: project.id,
                title: "old",
                userNamed: false,
                model: { agent: "claude", model: "default" },
                mode: "default",
                checkout: { kind: "main", path: "/synthetic/repo" },
                labels: [],
                pinned: false,
                parked: false,
                unread: false,
                createdAt: 0,
                lastActivityAt: 1,
                completedAt: 1,
                completedReason: "user",
              };
              yield* store.insertThread(thread);
              const workspace: WorkspaceState = {
                workspace: {
                  id,
                  name: "synthetic",
                  projectIds: [project.id],
                  homeProjectId: project.id,
                  createdAt: 0,
                },
                charter: DEFAULT_CHARTER,
              };
              yield* store.putWorkspace(workspace);
              yield* store.putDream(storedDream(id, "active-manual", "running"));
              expect(yield* store.getAutomaticDreamState(id)).toBeUndefined();
              yield* store.updateWorkspace(id, (w) => ({
                ...w,
                charter: { ...w.charter, automaticDreamThreshold: 10 },
              }));
              expect((yield* store.getAutomaticDreamState(id))?.seen).toEqual([thread.id]);
              yield* store.updateAutomaticDreamState(id, (s) => ({
                ...s,
                completed: 4,
                seen: [...s.seen, "counted"],
                lastAttemptAt: 123,
              }));
              yield* store.updateWorkspace(id, (w) => ({
                ...w,
                paused: { reason: "user", at: 5 },
              }));
              expect((yield* store.getAutomaticDreamState(id))?.completed).toBe(4);
            }),
          );
          yield* withStore(
            path,
            Effect.gen(function* () {
              const store = yield* ThreadStore;
              expect(yield* store.getAutomaticDreamState(id)).toMatchObject({
                threshold: 10,
                observedDreamId: "active-manual",
                completed: 4,
                seen: ["old", "counted"],
                lastAttemptAt: 123,
              });
              yield* store.updateWorkspace(id, (w) => ({
                ...w,
                charter: { ...w.charter, automaticDreamThreshold: 5 },
              }));
              expect(yield* store.getAutomaticDreamState(id)).toMatchObject({
                threshold: 5,
                observedDreamId: "active-manual",
                completed: 0,
                seen: ["old", "counted"],
              });
              yield* store.updateWorkspace(id, (w) => {
                const { automaticDreamThreshold: _threshold, ...charter } = w.charter;
                return { ...w, charter };
              });
              expect(yield* store.getAutomaticDreamState(id)).toBeUndefined();
            }),
          );
        }),
      ),
  );
});
