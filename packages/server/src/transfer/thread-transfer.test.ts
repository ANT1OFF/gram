// Moving one thread between two servers, each the real runtimes and store over the fake agent and
// real git: the laptop exports a thread with a conversation and an uncommitted edit, the hosted
// server takes the bundle in as it would arrive over HTTP and carries on in a fresh session that
// reads the recent turns, and the laptop's copy settles as read-only.
import { describe, expect, it } from "@effect/vitest";
import { applySettingsPatch, type ThreadId } from "@gram/contracts";
import { ImportThreadInput, type ThreadBundle } from "@gram/contracts/thread-transfer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { hasGit, run, write } from "../git/test-repo.ts";
import {
  completeTurn,
  makeWorld,
  serverLayer,
  waitSent,
  type Server,
  type World,
} from "../orchestration/test-harness.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { THREAD_TRANSFER_OFF, ThreadTransfer } from "./thread-transfer.ts";

/** The address both repositories name as `origin`; git reads it from a bare repository here. */
const REMOTE = "https://git.example.test/acme/shop.git";

const onServer = <A, E>(
  world: World,
  body: Effect.Effect<A, E, Server | ThreadTransfer | Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        ThreadTransfer.layerWith({ protocols: "file" }).pipe(
          Layer.provideMerge(serverLayer(world)),
        ),
      );
      return yield* body.pipe(Effect.provide(context));
    }),
  );

const hostedFeatures = (on: boolean) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* store.updateSettings(
      (settings) => applySettingsPatch(settings, { experimental: { embedding: on } }),
      [["experimental", "embedding"]],
    );
  });

const overTheWire = (bundle: ThreadBundle, root: string) =>
  Schema.decodeUnknownSync(ImportThreadInput)(
    JSON.parse(
      JSON.stringify(Schema.encodeSync(ImportThreadInput)({ bundle, root, from: "Laptop" })),
    ),
  );

/** `repo`'s origin is `REMOTE`, which git fetches from and pushes to the bare repository `bare`. */
const pointAt = (repo: string, bare: string) => {
  run(repo, "remote", "add", "origin", REMOTE);
  run(repo, "config", `url.${bare}.insteadOf`, REMOTE);
};

describe.skipIf(!hasGit)("moving a thread to another server", () => {
  it.effect("a thread moves with its conversation and edits, and carries on there", () =>
    Effect.gen(function* () {
      const laptop = yield* makeWorld;
      const hosted = yield* makeWorld;
      const bare = nodePath.join(hosted.dir, "remote.git");
      run(hosted.dir, "init", "-q", "--bare", bare);
      pointAt(laptop.repo, bare);
      run(laptop.repo, "push", "-q", "origin", "main");
      const clone = nodePath.join(hosted.dir, "shop");
      run(hosted.dir, "clone", "-q", bare, clone);
      run(clone, "remote", "set-url", "origin", REMOTE);
      run(clone, "config", `url.${bare}.insteadOf`, REMOTE);

      const exported = yield* onServer(
        laptop,
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const transfer = yield* ThreadTransfer;
          const thread = yield* runtimes.create({
            projectRoot: laptop.repo,
            checkout: { kind: "main", path: laptop.repo },
            input: { text: "Port the cart to the new checkout." },
          });
          const session = yield* waitSent(thread.id, 1);
          write(nodePath.join(laptop.repo, "cart.ts"), "export const cart = [];\n");
          yield* completeTurn(session, "Started: cart.ts holds the new cart.");

          // Off, nothing moves.
          const off = yield* transfer.exportThread({ threadId: thread.id }).pipe(Effect.flip);
          expect(off.message).toBe(THREAD_TRANSFER_OFF);

          yield* hostedFeatures(true);
          const bundle = yield* transfer.exportThread({ threadId: thread.id });
          return { bundle, threadId: thread.id };
        }),
      );
      const { bundle } = exported;
      expect(bundle.repository.remote).toBe(REMOTE);
      expect(bundle.thread.agentSessionId).toBeUndefined();
      expect(bundle.wip?.uncommitted).toBe(true);
      // The edits are at the remote under the thread's ref, at the commit the bundle names.
      expect(run(bare, "rev-parse", bundle.wip!.ref).trim()).toBe(bundle.wip!.commit);
      // And the laptop's folder is as it was.
      expect(readFileSync(nodePath.join(laptop.repo, "cart.ts"), "utf8")).toContain("cart");

      const threadId: ThreadId = yield* onServer(
        hosted,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const runtimes = yield* ThreadRuntimes;
          const transfer = yield* ThreadTransfer;
          yield* hostedFeatures(true);
          // A bundle is input from elsewhere: an id that could name a path is refused, and how
          // the model runs here is this server's.
          const unsafe = yield* transfer
            .importThread(
              overTheWire({ ...bundle, thread: { ...bundle.thread, id: ".." as ThreadId } }, clone),
            )
            .pipe(Effect.flip);
          expect(unsafe.message).toContain("not one Gram makes");
          const { thread } = yield* transfer.importThread(
            overTheWire(
              {
                ...bundle,
                thread: {
                  ...bundle.thread,
                  model: { ...bundle.thread.model, profileId: "elsewhere" as never, speed: "fast" },
                },
              },
              clone,
            ),
          );
          expect(thread.model.profileId).toBeUndefined();
          expect(thread.model.speed).toBeUndefined();
          expect(thread.id).toBe(exported.threadId);
          expect(thread.transferredFrom?.name).toBe("Laptop");
          expect(thread.agentSessionId).toBeUndefined();
          const folder = thread.checkout.path;
          expect(folder.startsWith(nodePath.join(clone, ".worktrees"))).toBe(true);
          // The edit is back, uncommitted.
          expect(readFileSync(nodePath.join(folder, "cart.ts"), "utf8")).toBe(
            "export const cart = [];\n",
          );
          expect(run(folder, "status", "--porcelain")).toContain("cart.ts");
          // A second import of the same thread is refused before anything is made.
          const twice = yield* transfer.importThread(overTheWire(bundle, clone)).pipe(Effect.flip);
          expect(twice._tag).toBe("InvalidState");

          // The first session here reads the recent turns ahead of the next message, once.
          yield* runtimes.send(thread.id, { text: "Carry on with the tests." });
          const session = yield* waitSent(thread.id, 1);
          const first = session.sent[0]!.text;
          expect(first).toContain("moved here from Laptop");
          expect(first).toContain("Port the cart to the new checkout.");
          expect(first.endsWith("Carry on with the tests.")).toBe(true);
          expect((yield* store.getThread(thread.id)).transferredFrom?.seeded).toBe(true);
          yield* completeTurn(session, "Tests next.");
          return thread.id;
        }),
      );

      // Settled back on the laptop: archived, read-only, saying where it went.
      yield* onServer(
        laptop,
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const transfer = yield* ThreadTransfer;
          // A thread that carried on after the bundle was made stays here.
          const behind = yield* transfer
            .settleThread({ threadId, to: "Hosted", exportedAt: bundle.exportedAt - 60_000 })
            .pipe(Effect.flip);
          expect(behind.message).toContain("carried on after it was exported");
          const settled = yield* transfer.settleThread({
            threadId,
            to: "Hosted",
            exportedAt: bundle.exportedAt,
          });
          expect(settled.parked).toBe(true);
          expect(settled.transferredTo?.name).toBe("Hosted");
          const refused = yield* runtimes
            .send(threadId, { text: "One more thing." })
            .pipe(Effect.flip);
          expect(refused.message).toContain("moved to Hosted");
          // And once moved, it can't be moved from here again.
          const again = yield* transfer.exportThread({ threadId }).pipe(Effect.flip);
          expect(again.message).toContain("moved to Hosted");
        }),
      );
    }),
  );

  it.effect("a folder that isn't a clone of the thread's repository is refused", () =>
    Effect.gen(function* () {
      const laptop = yield* makeWorld;
      const hosted = yield* makeWorld;
      const bare = nodePath.join(hosted.dir, "remote.git");
      run(hosted.dir, "init", "-q", "--bare", bare);
      pointAt(laptop.repo, bare);
      run(laptop.repo, "push", "-q", "origin", "main");
      const bundle = yield* onServer(
        laptop,
        Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const transfer = yield* ThreadTransfer;
          const thread = yield* runtimes.create({
            projectRoot: laptop.repo,
            checkout: { kind: "main", path: laptop.repo },
            input: { text: "Look at the cart." },
          });
          yield* completeTurn(yield* waitSent(thread.id, 1), "Looked.");
          yield* hostedFeatures(true);
          return yield* transfer.exportThread({ threadId: thread.id });
        }),
      );
      yield* onServer(
        hosted,
        Effect.gen(function* () {
          const store = yield* ThreadStore;
          const transfer = yield* ThreadTransfer;
          yield* hostedFeatures(true);
          // `hosted.repo` has no origin at all.
          const refused = yield* transfer
            .importThread(overTheWire(bundle, hosted.repo))
            .pipe(Effect.flip);
          expect(refused.message).toContain("isn't a clone of");
          expect((yield* store.getThread(bundle.thread.id).pipe(Effect.option))._tag).toBe("None");
          expect(existsSync(nodePath.join(hosted.repo, ".worktrees"))).toBe(false);
        }),
      );
    }),
  );
});
