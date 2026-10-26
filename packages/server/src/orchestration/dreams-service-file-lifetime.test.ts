// Dream file operations held against cancel and rebind, through the anchored helper's boundaries.
import type * as NativeFiles from "./anchored-files.ts";
import type * as FsPromises from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import type { AnchoredRequest, FileBoundary } from "./anchored-files.ts";
import { InvalidState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl } from "../runtime/fake-agent.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { Dreams } from "./dreams.ts";
import { openOrchestrator } from "./test-harness.ts";
import { inDreams, startDream } from "./dreams-service-kit.ts";

const fileBoundary = vi.hoisted(() => ({
  unavailable: false,
  hook: undefined as undefined | ((q: AnchoredRequest, phase: FileBoundary) => Promise<void>),
  pathWrite: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock("./anchored-files.ts", async (importOriginal) => {
  const real = await importOriginal<typeof NativeFiles>();
  return {
    ...real,
    anchoredRequest: ((root, q, options) =>
      fileBoundary.unavailable
        ? Effect.fail(new InvalidState({ message: "Anchored file operations unavailable" }))
        : real.anchoredRequest(root, q, {
            ...options,
            boundary: (phase) =>
              Effect.promise(async () => {
                await fileBoundary.hook?.(q, phase);
              }).pipe(Effect.andThen(options?.boundary?.(phase) ?? Effect.void)),
          })) as typeof real.anchoredRequest,
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      await fileBoundary.pathWrite?.(String(args[0]));
      return real.writeFile(...args);
    },
  };
});

describe("Dream file operation lifetime", () => {
  it.effect(
    "fails unavailable confinement before opening a Dream session or persisting a run",
    () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const { workspaceId } = yield* openOrchestrator(world);
          const fake = yield* FakeAgentControl;
          const before = fake.sessions.length;
          fileBoundary.unavailable = true;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              fileBoundary.unavailable = false;
            }),
          );
          expect(
            yield* Effect.flip((yield* Dreams).start({ workspaceId, kind: "dream" })),
          ).toMatchObject({
            _tag: "InvalidState",
            message: "Anchored file operations unavailable",
          });
          expect(fake.sessions).toHaveLength(before);
          expect(yield* (yield* ThreadStore).listDreams(workspaceId)).toEqual([]);
        }),
      ),
  );
  for (const revoke of ["cancel", "rebind"] as const)
    it.effect(`revokes a staged file write through actual ${revoke}`, () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const { workspaceId } = yield* openOrchestrator(world);
          const { dream, session } = yield* startDream(workspaceId);
          const dreams = yield* Dreams;
          const store = yield* ThreadStore;
          const workBefore = fs.readdirSync(nodePath.join(dream.outputDir, "work"));
          let entered!: () => void;
          let release!: () => void;
          const enteredPromise = new Promise<void>((r) => {
            entered = r;
          });
          const releasePromise = new Promise<void>((r) => {
            release = r;
          });
          fileBoundary.hook = async (q, phase) => {
            if (q.op !== "write" || !q.rel.endsWith("work/late.md") || phase !== "staged") return;
            entered();
            await releasePromise;
          };
          fileBoundary.pathWrite = async (p) => {
            if (!p.startsWith(nodePath.join(dream.outputDir, "work/.tmp-"))) return;
            entered();
            await releasePromise;
          };
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              fileBoundary.hook = fileBoundary.pathWrite = undefined;
              release();
            }),
          );
          const call = yield* Effect.forkScoped(
            session
              .callTool("dream_write", { path: "work/late.md", content: "after revocation" })
              .pipe(Effect.result),
          );
          yield* Effect.promise(() => enteredPromise);
          if (revoke === "cancel")
            expect(yield* dreams.cancel(dream.id)).toMatchObject({ status: "canceled" });
          else
            yield* (yield* ThreadRuntimes).updateThread(dream.threadId!, (t) => ({
              ...t,
              checkout: { ...t.checkout, path: nodePath.join(world.dir, "new-binding") },
            }));
          expect(fs.existsSync(nodePath.join(dream.outputDir, "work/late.md"))).toBe(false);
          release();
          expect((yield* Fiber.join(call))._tag).toBe("Failure");
          expect(fs.existsSync(nodePath.join(dream.outputDir, "work/late.md"))).toBe(false);
          expect(fs.readdirSync(nodePath.join(dream.outputDir, "work"))).toEqual(workBefore);
          if (revoke === "cancel")
            expect((yield* store.getDream(dream.id)).status).toBe("canceled");
          else yield* dreams.cancel(dream.id);
        }),
      ),
    );

  for (const revoke of ["cancel", "rebind"] as const)
    it.effect(`holds the binding/store lock through the final rename against ${revoke}`, () =>
      inDreams((world) =>
        Effect.gen(function* () {
          const { workspaceId } = yield* openOrchestrator(world);
          const { dream, session } = yield* startDream(workspaceId);
          const dreams = yield* Dreams;
          let entered!: () => void;
          let release!: () => void;
          const enteredPromise = new Promise<void>((r) => {
            entered = r;
          });
          const releasePromise = new Promise<void>((r) => {
            release = r;
          });
          fileBoundary.hook = async (q, phase) => {
            if (q.op !== "write" || !q.rel.endsWith("work/last.md") || phase !== "committing")
              return;
            entered();
            await releasePromise;
          };
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              fileBoundary.hook = undefined;
              release();
            }),
          );
          const call = yield* Effect.forkScoped(
            session.callTool("dream_write", { path: "work/last.md", content: "before revocation" }),
          );
          yield* Effect.promise(() => enteredPromise);
          const runtimes = yield* ThreadRuntimes;
          const revocation = yield* Effect.forkScoped(
            revoke === "cancel"
              ? dreams.cancel(dream.id).pipe(Effect.asVoid)
              : runtimes
                  .updateThread(dream.threadId!, (t) => ({
                    ...t,
                    checkout: { ...t.checkout, path: nodePath.join(world.dir, "new-binding") },
                  }))
                  .pipe(Effect.asVoid),
          );
          yield* Effect.promise(() => new Promise<void>((r) => setTimeout(r, 30)));
          expect(revocation.pollUnsafe()).toBeUndefined();
          release();
          expect(yield* Fiber.join(call)).toEqual({ written: "work/last.md" });
          yield* Fiber.join(revocation);
          expect(fs.readFileSync(nodePath.join(dream.outputDir, "work/last.md"), "utf8")).toBe(
            "before revocation",
          );
          expect(
            (yield* Effect.result(
              session.callTool("dream_write", { path: "work/after.md", content: "after" }),
            ))._tag,
          ).toBe("Failure");
          expect(fs.existsSync(nodePath.join(dream.outputDir, "work/after.md"))).toBe(false);
          if (revoke === "rebind") yield* dreams.cancel(dream.id);
        }),
      ),
    );

  it.effect("refuses hardlink disclosure through the actual service/session bridge", () =>
    inDreams((world) =>
      Effect.gen(function* () {
        const { workspaceId } = yield* openOrchestrator(world);
        const { dream, session } = yield* startDream(workspaceId);
        const outside = nodePath.join(world.dir, "outside.md");
        fs.writeFileSync(outside, "synthetic outside memory");
        fs.linkSync(outside, nodePath.join(dream.outputDir, "work/linked.md"));
        expect(
          (yield* Effect.result(session.callTool("dream_read", { path: "work/linked.md" })))._tag,
        ).toBe("Failure");
        yield* (yield* Dreams).cancel(dream.id);
      }),
    ),
  );
});
