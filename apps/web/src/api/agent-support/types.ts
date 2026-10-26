import type { ModelRef, SelectedHarnessSupport, ThreadId } from "@gram/contracts";

export interface AgentSupportApi {
  /** Read-only local observations; never a model/entitlement probe or provider turn. */
  agentSupport(
    model: ModelRef,
    options?: { readonly threadId?: ThreadId; readonly refresh?: boolean },
  ): Promise<SelectedHarnessSupport>;
}
