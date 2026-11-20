import { useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchOnDemandStatus, isComing, type OnDemandStatus } from "@/api/on-demand";
import { useEmbedShell } from "@/embed/store";
import { lazyPart } from "@/lib/lazy-part";

export const ON_DEMAND_QUERY_KEY = ["on-demand-machine"] as const;

export const useOnDemandMachine = () => {
  const client = useQueryClient();
  // Only an app mounted in front of a hosted server can have machines started for its people.
  const hosted = useEmbedShell((s) => s.hosted);
  const query = useQuery({
    queryKey: ON_DEMAND_QUERY_KEY,
    queryFn: () => fetchOnDemandStatus(),
    enabled: hosted,
    retry: false,
    refetchInterval: (state) => (isComing(state.state.data) ? 1000 : 30_000),
  });
  return {
    status: query.data,
    refresh: () => client.invalidateQueries({ queryKey: ON_DEMAND_QUERY_KEY }),
  };
};

/** Whether the card is for this person now: the feature is on, and they have none online. */
export const needsMachine = (status: OnDemandStatus | undefined): boolean =>
  status !== undefined && status.machine?.online !== true;

/**
 * The card itself loads only where it shows: a hosted deployment that starts machines on demand,
 * for a person with none online. Everywhere else the composer's route doesn't carry it.
 */
const cardBody = lazyPart(() => import("./start-machine-card-body"));

export function StartMachineCard({
  repositories,
}: {
  /** Repositories to offer, checked: the ones this work is likely to need. */
  readonly repositories?: ReadonlyArray<string>;
}) {
  const { status } = useOnDemandMachine();
  const wanted = needsMachine(status);
  const body = cardBody.useModule(wanted);
  if (!wanted || body === undefined) return null;
  return <body.StartMachineCardBody {...(repositories === undefined ? {} : { repositories })} />;
}
