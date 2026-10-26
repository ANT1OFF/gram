import type { LaunchChecks } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useApi } from "@/api/context";

export const LAUNCH_CHECKS_KEY = ["app.launchChecks"] as const;

/**
 * The server's launch checks, fetched once in the background (the app never waits for them), and
 * `recheck` to run them again.
 */
export function useLaunchChecks(): {
  checks: LaunchChecks | undefined;
  recheck: () => Promise<LaunchChecks>;
} {
  const api = useApi();
  const client = useQueryClient();
  const { data } = useQuery({
    queryKey: LAUNCH_CHECKS_KEY,
    queryFn: () => api.launchChecks(),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const recheck = useCallback(async () => {
    const next = await api.launchChecks(true);
    client.setQueryData(LAUNCH_CHECKS_KEY, next);
    // Explicit recheck also recovers failed listings whose chooser is currently closed.
    // Mounting that chooser itself does not retry a failed discovery.
    await Promise.all([
      client.invalidateQueries({ queryKey: ["models"], refetchType: "all" }),
      client.invalidateQueries({ queryKey: ["agents-available"] }),
    ]);
    return next;
  }, [api, client]);
  return { checks: data, recheck };
}
