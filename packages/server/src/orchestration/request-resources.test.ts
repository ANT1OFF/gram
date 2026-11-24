// `request_resources` on an embedded server: a worker on a machine of its own asks the embedder's
// host provider to have it hold a larger size for a while (`POST /hosts/resize`). A fake provider on
// loopback, no real machine.

import { createServer, type Server } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { HostId, LOCAL_HOST_ID, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOnDemandHosts, OnDemand } from "../embedding/on-demand.ts";
import { hasGit } from "../git/test-repo.ts";
import { RemoteHosts, type RemoteHostsShape } from "../host/remote-hosts.ts";
import { ServerWork } from "../host/ownership.ts";
import { makeStopMarks } from "../host/stop-marks.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { atAutonomy, makeWorld, openOrchestrator, serverLayer, spawn } from "./test-harness.ts";

const MACHINE = HostId.make("m-0123456789abcdef01234567");
const ORCHESTRATORS = HostId.make("m-89abcdef0123456789abcdef");
const NAME = "worker-0123456789";

/** A host provider on loopback that grows what it is asked to, and records each ask. */
const fakeProvider = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ server: Server; url: string; asked: Array<{ path: string; body: unknown }> }>(
        (resolve) => {
          const asked: Array<{ path: string; body: unknown }> = [];
          const server = createServer((req, res) => {
            let text = "";
            req.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
            req.on("end", () => {
              const body = text === "" ? undefined : (JSON.parse(text) as { size?: string | null });
              asked.push({ path: req.url ?? "", body });
              const grown =
                req.url === "/hosts/resize"
                  ? {
                      state: body?.size === null ? "released" : "grown",
                      size: body?.size ?? "large",
                      start: "large",
                      until: "2026-11-24T12:30:00.000Z",
                    }
                  : {};
              res.writeHead(req.url === "/hosts/choices" ? 404 : 200, {
                "content-type": "application/json",
              });
              res.end(JSON.stringify(grown));
            });
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            resolve({ server, url: `http://127.0.0.1:${port}`, asked });
          });
        },
      ),
  ),
  ({ server }) => Effect.sync(() => server.close()),
);

/** Puts a thread on a host: the orchestrator on its person's machine, a worker on its own. */
const onHost = (id: ThreadId, hostId: HostId) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* store.updateThread(id, (thread) => ({
      ...thread,
      checkout: { ...thread.checkout, hostId },
    }));
  });

describe.skipIf(!hasGit)("request_resources on a machine from an embedder's host provider", () => {
  it.effect(
    "asks the provider for the calling worker's own machine, and refuses a worker without one",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        world.owners = new Map([
          [LOCAL_HOST_ID, "grace"],
          [ORCHESTRATORS, "grace"],
          [MACHINE, "grace"],
        ]);
        const provider = yield* fakeProvider;
        const remote = Layer.succeed(RemoteHosts, {
          machines: { list: () => [], get: () => undefined },
          stops: makeStopMarks(),
          watch: () => () => undefined,
          list: () => [
            {
              id: MACHINE,
              name: NAME,
              confirmed: true,
              owner: "grace",
              onDemand: "worker",
              onlineSince: 1,
            },
          ],
        } as unknown as RemoteHostsShape);
        const context = yield* Layer.build(
          serverLayer(world).pipe(
            Layer.provide(remote),
            Layer.provide(
              Layer.succeed(OnDemand)(makeOnDemandHosts({ url: provider.url, token: "synthetic" })),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const { thread } = yield* openOrchestrator(world);
          const session = yield* atAutonomy(thread, "full", { maxConcurrentWorkers: 8 });
          const onIts = yield* spawn(session, { feature: "heavy" });
          const local = yield* spawn(session, { feature: "light" });
          yield* onHost(thread.id, ORCHESTRATORS);
          yield* onHost(onIts.thread.id, MACHINE);

          const grown = yield* onIts.session.callTool("request_resources", {
            size: "xlarge",
            minutes: 20,
            reason: "The full check.",
          });
          expect(grown).toMatchObject({ machine: NAME, state: "grown", size: "xlarge" });
          expect(provider.asked.filter((each) => each.path === "/hosts/resize")).toEqual([
            {
              path: "/hosts/resize",
              body: {
                kind: "worker",
                owner: "grace",
                name: NAME,
                size: "xlarge",
                holdMinutes: 20,
                reason: "The full check.",
              },
            },
          ]);

          // The worker gives its own back.
          const back = yield* onIts.session.callTool("request_resources", { size: "default" });
          expect(back).toMatchObject({ machine: NAME, state: "released" });
          expect(provider.asked.at(-1)?.body).toMatchObject({ name: NAME, size: null });

          // A worker on its orchestrator's machine has nothing to resize.
          const refused = yield* local.session
            .callTool("request_resources", { size: "large" })
            .pipe(Effect.flip);
          expect(refused.message).toMatch(/isn't a worker's own/);
          expect(provider.asked.filter((each) => each.path === "/hosts/resize")).toHaveLength(2);
        }).pipe(Effect.provide(context), Effect.provideService(ServerWork, true));
      }).pipe(Effect.scoped),
    { timeout: 90_000 },
  );
});
