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
import { orchestrationRpc } from "./orchestration/rpc";
import { prPeopleRpc } from "./pr-people/rpc";
import { profilesRpc } from "./profiles/rpc";
import { projectsRpc } from "./projects/rpc";
import { pullRequestsRpc } from "./pull-requests/rpc";
import { reviewRequestsRpc } from "./review-requests/rpc";
import { threadWakesRpc } from "./thread-wakes/rpc";
import { sessionsRpc } from "./sessions/rpc";
import { settingsRpc } from "./settings/rpc";
import { speechRpc } from "./speech/rpc";
import { terminalRpc } from "./terminal/rpc";
import { threadsRpc } from "./threads/rpc";
import { waitsRpc } from "./waits/rpc";
import { worktreesRpc } from "./worktrees/rpc";
import { createConnectionMonitor, withSessionProbe } from "./connection";
import { type RpcContext } from "./rpc-client";
import { rpcProtocolLayer } from "./rpc-protocol";
import type { Api } from "./types";

/**
 * The `Api` over Effect RPC on a browser WebSocket (`/ws`, cookie auth). The client lives for the
 * window's lifetime. Feeds resubscribe with backoff when the socket drops, and `connection` reports
 * it for the reconnect banner.
 */
export async function createRpcApi(url: string): Promise<Api> {
  // A dropped socket is a server that's down or a session it no longer accepts. Only an HTTP probe
  // tells them apart, and only the second never recovers by retrying.
  const connection = withSessionProbe(createConnectionMonitor());
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(
      rpcProtocolLayer(
        Socket.layerWebSocket(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        connection,
      ),
      scope,
    ),
  );
  const client = await Effect.runPromise(
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

  const domain: RpcContext = { client, connection };

  return {
    kind: "rpc",
    connection,
    // After the members above, so TypeScript reports one a domain also defines.
    ...agentRuntimeRpc(domain),
    ...agentSupportRpc(domain),
    ...appRpc(domain),
    ...branchesRpc(domain),
    ...composerRpc(domain),
    ...connectorsRpc(domain),
    ...dreamsRpc(domain),
    ...filesRpc(domain),
    ...keybindingsRpc(domain),
    ...labelsRpc(domain),
    ...orchestrationRpc(domain),
    ...prPeopleRpc(domain),
    ...profilesRpc(domain),
    ...projectsRpc(domain),
    ...pullRequestsRpc(domain),
    ...reviewRequestsRpc(domain),
    ...threadWakesRpc(domain),
    ...sessionsRpc(domain),
    ...settingsRpc(domain),
    ...speechRpc(),
    ...terminalRpc(domain),
    ...threadsRpc(domain),
    ...waitsRpc(domain),
    ...worktreesRpc(domain),
  };
}
