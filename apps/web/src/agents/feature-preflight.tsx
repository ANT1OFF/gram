import {
  featurePreflight,
  imageInputSupport,
  type FeaturePreflight,
  type HarnessFeature,
  type SelectedHarnessSupport,
} from "@gram/contracts/agent-support";
import type { AgentModel, ModelRef, ThreadId } from "@gram/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";

const AGENT_SUPPORT_KEY = ["agents.support"] as const;

/** The same selected-account evidence supplies every start control; no previous-provider placeholder. */
export function useHarnessPreflight(
  model: ModelRef | undefined,
  feature: HarnessFeature,
  options: {
    readonly threadId?: ThreadId;
    readonly requireVerified?: boolean;
    readonly models?: ReadonlyArray<AgentModel>;
  } = {},
) {
  const api = useApi();
  const client = useQueryClient();
  const queryKey = [...AGENT_SUPPORT_KEY, model ?? null, options.threadId ?? null];
  const query = useQuery({
    queryKey,
    queryFn: () =>
      api.agentSupport(
        model!,
        options.threadId === undefined ? {} : { threadId: options.threadId },
      ),
    enabled: model !== undefined,
    retry: false,
    staleTime: 30_000,
  });
  const support =
    feature === "imageInput" && model !== undefined
      ? { ...query.data?.support, imageInput: imageInputSupport(options.models, model.model) }
      : query.data?.support;
  const result = featurePreflight({
    feature,
    support,
    availability: query.data?.availability ?? {
      state: "unknown",
      reason: query.isError
        ? "Could not check this harness. Retry or let the CLI check availability at start."
        : "Checking the selected harness…",
    },
    ...(options.requireVerified === undefined ? {} : { requireVerified: options.requireVerified }),
  });
  const checking = model !== undefined && query.isPending && query.fetchStatus === "fetching";
  const recheck = async () => {
    if (model === undefined) return;
    // Explicit retry follows the established cache retirement path after CLI/login changes.
    await api.launchChecks(true);
    const next = await api.agentSupport(model, {
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
      refresh: true,
    });
    client.setQueryData(queryKey, next);
    await Promise.all([
      client.invalidateQueries({
        queryKey: ["models", model.agent, model.profileId ?? null],
        refetchType: "all",
      }),
      client.invalidateQueries({ queryKey: ["agents-available"] }),
    ]);
  };
  return {
    result,
    checking,
    blocked: checking || result.blocked,
    observation: query.data,
    recheck,
  };
}

/** Granular reason stays beside Start, with setup and retry reachable while the agent stays selectable. */
export function HarnessPreflightNote({
  result,
  checking,
  model,
  observation,
  onRetry,
}: {
  readonly result: FeaturePreflight;
  readonly checking: boolean;
  readonly model: ModelRef | undefined;
  readonly observation?: SelectedHarnessSupport | undefined;
  readonly onRetry: () => Promise<unknown>;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const retry = async () => {
    setRetrying(true);
    setRetryError(false);
    try {
      await onRetry();
    } catch {
      setRetryError(true);
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div
      data-testid="harness-preflight"
      className="flex flex-col gap-1 text-xs text-muted-foreground"
    >
      {(checking || result.reason !== undefined) && (
        <p
          role="status"
          data-testid="harness-preflight-reason"
          className="flex flex-wrap items-center gap-x-2 gap-y-1"
        >
          <span>
            {checking
              ? "Checking the selected harness…"
              : `${result.state === "unknown" ? "Unverified: " : ""}${result.reason}`}
          </span>
          {!checking && result.action === "setup" && (
            <Link
              to={model?.profileId === undefined ? "/settings/agents" : "/settings/gateways"}
              className="text-foreground underline underline-offset-2"
            >
              Set up
            </Link>
          )}
          {!checking && result.action !== "chooseAgent" && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={retrying}
              onClick={() => void retry()}
            >
              {retrying ? "Checking…" : "Retry check"}
            </Button>
          )}
        </p>
      )}
      {retryError && <p role="alert">Could not refresh this check. Retry when the CLI is ready.</p>}
      {observation?.dreamReason !== undefined && (
        <p data-testid="dream-harness-mode">{observation.dreamReason}</p>
      )}
    </div>
  );
}
