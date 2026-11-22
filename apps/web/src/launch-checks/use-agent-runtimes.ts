import type {
  AgentRuntime,
  AgentRuntimes,
  CliUpdateState,
  RuntimeAgent,
  RuntimeInstallState,
} from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { useApi } from "@/api/context";

import { LAUNCH_CHECKS_KEY, useLaunchChecks } from "./use-launch-checks";

export const AGENT_RUNTIMES_KEY = ["agentRuntime.list"] as const;

/**
 * Each agent CLI's runtime, fetched in the background once Settings → Agents or a launch-check
 * Update shows, and `recheck` to probe the machine again. The server reads vendor releases rarely
 * whatever this asks.
 */
export function useAgentRuntimes(): {
  runtimes: AgentRuntimes | undefined;
  byAgent: (agent: RuntimeAgent) => AgentRuntime | undefined;
  recheck: () => Promise<void>;
} {
  const api = useApi();
  const client = useQueryClient();
  const { recheck: recheckLaunch } = useLaunchChecks();
  const { data } = useQuery({
    queryKey: AGENT_RUNTIMES_KEY,
    queryFn: () => api.agentRuntimes(),
    retry: false,
    staleTime: 5 * 60_000,
    refetchInterval: (query) => (query.state.data?.releasesChecking === true ? 5_000 : false),
  });
  const recheck = useCallback(async () => {
    const next = await api.agentRuntimes(true);
    client.setQueryData(AGENT_RUNTIMES_KEY, next);
    await recheckLaunch();
  }, [api, client, recheckLaunch]);
  const byAgent = useCallback(
    (agent: RuntimeAgent) => data?.agents.find((runtime) => runtime.agent === agent),
    [data],
  );
  return { runtimes: data, byAgent, recheck };
}

/**
 * The managed store's state for `agent` while `enabled`, live from its feed; the runtime listing is
 * read again when an install settles, so the row shows what now runs.
 */
export function useRuntimeInstall(agent: RuntimeAgent, enabled: boolean) {
  const api = useApi();
  const client = useQueryClient();
  const [state, setState] = useState<RuntimeInstallState>();
  const watched = enabled ? agent : undefined;
  useEffect(() => {
    if (watched === undefined) return;
    const abort = new AbortController();
    let last: RuntimeInstallState["state"] | undefined;
    void (async () => {
      try {
        for await (const next of api.watchRuntimeInstall(watched, abort.signal)) {
          setState(next);
          if (last !== undefined && last !== next.state && next.state === "idle")
            void client.invalidateQueries({ queryKey: AGENT_RUNTIMES_KEY });
          last = next.state;
        }
      } catch (e) {
        if (!abort.signal.aborted) console.warn("agent runtime: install feed", e);
      }
    })();
    return () => abort.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `api` and `client` are context values the rule takes for stable, and a new `api` must resubscribe
  }, [api, client, watched]);
  return { state };
}

/**
 * The update of the user's own CLI for `agent`, live from its feed. When a run settles, the server
 * has probed the CLI again, so the runtime listing and the launch checks are read again and the
 * row shows the version now installed.
 */
export function useCliUpdate(agent: RuntimeAgent) {
  const api = useApi();
  const client = useQueryClient();
  const [state, setState] = useState<CliUpdateState>();
  useEffect(() => {
    const abort = new AbortController();
    let last: CliUpdateState["state"] | undefined;
    void (async () => {
      try {
        for await (const next of api.watchCliUpdate(agent, abort.signal)) {
          setState(next);
          const settled = next.state === "succeeded" || next.state === "failed";
          if ((last === "running" && next.state !== "running") || (last === undefined && settled)) {
            void client.invalidateQueries({ queryKey: AGENT_RUNTIMES_KEY });
            void client.invalidateQueries({ queryKey: LAUNCH_CHECKS_KEY });
          }
          last = next.state;
        }
      } catch (e) {
        if (!abort.signal.aborted) console.warn("agent runtime: update feed", e);
      }
    })();
    return () => abort.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `api` and `client` are context values the rule takes for stable, and a new `api` must resubscribe
  }, [api, client, agent]);
  return { state };
}
