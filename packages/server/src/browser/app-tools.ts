import { sessionHostOf, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { AppToolRegistry } from "../app-tools/registry.ts";
import { EventHub } from "../events/event-hub.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import { WorkspaceOutputs } from "../outputs/workspace-outputs.ts";
import { PageFiles } from "../pages/page-files.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { PreviewFiles } from "../preview/files.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { DevServerAppToolsLive } from "./dev-server-tools.ts";
import { loopbackProxies } from "./loopback-proxy.ts";
import { PanePort, unsandboxedLocalOnly } from "./pane-port.ts";
import { browserTools } from "./tools.ts";

/**
 * Proxies to threads' own machines' loopback, for the headless browser, the one that takes them;
 * none in the desktop app, whose Preview pane reaches this machine's loopback alone, nor where no
 * other machine's host is reachable.
 */
const loopbackProxiesHere = Effect.gen(function* () {
  const pane = yield* PanePort;
  const hosts = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
  if (pane.view === undefined || hosts === undefined) return undefined;
  const store = yield* ThreadStore;
  const run = yield* FiberSet.makeRuntime();
  const proxies = loopbackProxies(
    (threadId) =>
      store.getThread(threadId as ThreadId).pipe(
        Effect.flatMap((thread) => hosts.get(sessionHostOf(thread))),
        Effect.map((host) => ({ tunnels: host.loopback })),
        Effect.orElseSucceed(() => undefined),
      ),
    run,
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => proxies.close()));
  return proxies;
});

/** Registers the browser tools with the app tool registry. */
const BrowserAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    // Absent in tool-only test layers, which serve no previewed files.
    const previewFiles = Option.getOrUndefined(yield* Effect.serviceOption(PreviewFiles));
    // Pinned pages' listener too: no agent reads or drives a page the user pinned.
    const pageFiles = Option.getOrUndefined(yield* Effect.serviceOption(PageFiles));
    const pane = yield* PanePort;
    yield* registry.register(
      browserTools({
        pane,
        localOnly: pane.view !== undefined && unsandboxedLocalOnly(process.env),
        hub: yield* EventHub,
        store: yield* ThreadStore,
        runtimes: yield* ThreadRuntimes,
        appOrigins: Effect.succeed(
          [previewFiles?.origin, pageFiles?.origin].filter((origin) => origin !== undefined),
        ),
        outputs: Option.getOrUndefined(yield* Effect.serviceOption(WorkspaceOutputs)),
        loopbackProxies: yield* loopbackProxiesHere,
      }),
    );
  }),
);

/**
 * The browser's app tools: the agent's own page and its dev servers. Merged with the pane port,
 * so the handlers that show an agent's page to a client reach the same port.
 */
export const BrowserFamilyAppToolsLive = Layer.mergeAll(
  BrowserAppToolsLive.pipe(Layer.provideMerge(PanePort.layer)),
  DevServerAppToolsLive,
);
