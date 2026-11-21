import type { GramServer } from "@/embed/contract";

import { GramRpcs } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as RpcClient from "effect/rpc/RpcClient";
import * as Socket from "effect/socket/Socket";

import { agentRuntimeRpc } from "./agent-runtime/rpc";
import { agentSupportRpc } from "./agent-support/rpc";
import { appRpc } from "./app/rpc";
import { branchesRpc } from "./branches/rpc";
import { composerRpc } from "./composer/rpc";
import { connectorsRpc } from "./connectors/rpc";
import { dreamsRpc } from "./dreams/rpc";
import { filesRpc } from "./files/rpc";
import { keybindingsRpc } from "./keybindings/rpc";
import { labelsRpc } from "./labels/rpc";
import { peopleRpc } from "./people/rpc";
import { orchestrationRpc } from "./orchestration/rpc";
import { prPeopleRpc } from "./pr-people/rpc";
import { profilesRpc } from "./profiles/rpc";
import { projectsRpc } from "./projects/rpc";
import { pullRequestsRpc } from "./pull-requests/rpc";
import { reviewRequestsRpc } from "./review-requests/rpc";
import { routinesRpc } from "./routines/rpc";
import { threadWakesRpc } from "./thread-wakes/rpc";
import { sessionsRpc } from "./sessions/rpc";
import { settingsRpc } from "./settings/rpc";
import { speechRpc } from "./speech/rpc";
import { terminalRpc } from "./terminal/rpc";
import { browserViewRpc } from "./browser-view/rpc";
import { threadsRpc } from "./threads/rpc";
import { waitsRpc } from "./waits/rpc";
import { docsRpc } from "./docs/rpc";
import { pagesRpc } from "./pages/rpc";
import { worktreesRpc } from "./worktrees/rpc";
import { createConnectionMonitor, withSessionProbe } from "./connection";
import { run, type RpcContext } from "./rpc-client";
import { createServed, gateClient, HANDSHAKE_TAG, startHandshake } from "./served";
import { rpcProtocolLayer } from "./rpc-protocol";
import type { Api } from "./types";
import { originKeyProtocols } from "./origin-key";

/**
 * The `Api` over Effect RPC on a browser WebSocket (`/ws`, cookie auth). The client lives for the
 * window's lifetime. Feeds resubscribe with backoff when the socket drops, and `connection` reports
 * it for the reconnect banner.
 */
export async function createRpcApi(url: string, session?: GramServer["session"]): Promise<Api> {
  // A dropped socket is a server that's down or a session it no longer accepts. Only an HTTP probe
  // tells them apart, and only the second never recovers by retrying.
  const connection = withSessionProbe(createConnectionMonitor(), undefined, session);
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      rpcProtocolLayer(
        Socket.layerWebSocket(url, { protocols: originKeyProtocols() }).pipe(
          Layer.provide(Socket.layerWebSocketConstructorGlobal),
        ),
        connection,
      ),
      scope,
    ),
  );
  const raw = await Effect.runPromise(
    RpcClient.make(GramRpcs, { disableTracing: true }).pipe(
      Effect.provideContext(context),
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  // The shell logs it, so a window that stops moving says whether its socket was the reason.
  const bridge = typeof window === "undefined" ? undefined : window.gram;
  if (bridge?.reportConnection !== undefined) {
    connection.subscribe(() => {
      const { status, attempt } = connection.get();
      bridge.reportConnection?.({ status, attempt });
    });
  }

  // The server may be older than this build (an embedding app ships the two apart): its handshake
  // says what it serves, first on the socket, and nothing else goes out before it answers.
  const served = createServed();
  const ready = startHandshake(
    () => run(raw[HANDSHAKE_TAG](undefined)),
    served,
    (again) => {
      let status = connection.get().status;
      connection.subscribe(() => {
        const next = connection.get().status;
        if (status === "reconnecting" && next === "open") again();
        status = next;
      });
    },
  );
  const client = gateClient(raw, served, ready);

  const domain: RpcContext = { client, connection };

  return {
    kind: "rpc",
    connection,
    served,
    // After the members above, so TypeScript reports one a domain also defines.
    ...agentRuntimeRpc(domain),
    ...agentSupportRpc(domain),
    ...appRpc(domain),
    ...branchesRpc(domain),
    ...composerRpc(domain),
    ...connectorsRpc(domain),
    ...docsRpc(domain),
    ...dreamsRpc(domain),
    ...filesRpc(domain),
    ...keybindingsRpc(domain),
    ...labelsRpc(domain),
    ...peopleRpc(domain),
    ...orchestrationRpc(domain),
    ...pagesRpc(domain),
    ...prPeopleRpc(domain),
    ...profilesRpc(domain),
    ...projectsRpc(domain),
    ...pullRequestsRpc(domain),
    ...reviewRequestsRpc(domain),
    ...routinesRpc(domain),
    ...threadWakesRpc(domain),
    ...sessionsRpc(domain),
    ...settingsRpc(domain),
    ...speechRpc(),
    ...terminalRpc(domain),
    ...browserViewRpc(domain),
    ...threadsRpc(domain),
    ...waitsRpc(domain),
    ...worktreesRpc(domain),
  };
}
