import type { OrchestratorCharter } from "@gram/contracts";

import { Toggle } from "./fields";
import { withRouteAtLimit } from "./workspace-settings-model";

/**
 * Whether a spawn a limit would hold is offered to the orchestrator on another worker model whose
 * note fits. Off by default; never a silent swap.
 */
export function RouteAtLimitField({
  charter,
  disabled,
  onChange,
}: {
  charter: OrchestratorCharter;
  disabled: boolean;
  onChange: (charter: OrchestratorCharter, title: string) => void;
}) {
  const on = charter.routeAtLimit === true;
  return (
    <div data-testid="route-at-limit" data-value={on ? "on" : "off"}>
      <Toggle
        label="Offer another model"
        description="When a usage limit would hold a new worker, the orchestrator may start it on another worker model whose note fits instead."
        keywords={["usage", "limit", "route", "routing", "fallback", "worker models"]}
        learnMore={
          <p>
            Gram never swaps by itself: the orchestrator chooses, and the spawn says which model the
            worker runs on. A model whose note rules the work out isn't picked.
          </p>
        }
        checked={on}
        disabled={disabled}
        onChange={(next) =>
          onChange(
            withRouteAtLimit(charter, next),
            next ? "Another model is offered at a limit" : "Workers wait at a limit",
          )
        }
      />
    </div>
  );
}
