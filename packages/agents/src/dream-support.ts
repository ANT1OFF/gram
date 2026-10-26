import type { AgentKind } from "@gram/contracts";
// Qualified independently from generated protocol bindings; regeneration is not verification.
const VERIFIED_CODEX_DREAM_VERSION = "0.162.1";

export type DreamSupportEvidence =
  | { readonly kind: "implementation" }
  | { readonly kind: "installed"; readonly cliVersion?: string | undefined };

export interface DreamSupport {
  readonly mode: "guided" | "confined" | "unsupported" | "unknown";
  readonly reason: string;
  readonly verifiedCliVersion?: string;
}

/**
 * One decision for Dream admission, runtime policy and capability presentation. Implementation
 * evidence describes Gram's route; installed evidence additionally qualifies the actual Codex
 * executable. Neither a model listing nor a login proves file-only native-tool confinement.
 */
export const dreamSupportFor = (agent: AgentKind, evidence: DreamSupportEvidence): DreamSupport => {
  switch (agent) {
    case "claude":
      return {
        mode: "confined",
        reason:
          "Bounded Dream file tools: snapshot inputs are read-only; candidate output and notes are writable. Native tools are disabled. Requires macOS or Linux with /usr/bin/python3.",
      };
    case "codex":
      if (evidence.kind === "installed" && evidence.cliVersion !== VERIFIED_CODEX_DREAM_VERSION) {
        return {
          mode: "unknown",
          verifiedCliVersion: VERIFIED_CODEX_DREAM_VERSION,
          reason: `Codex Dream is verified with CLI ${VERIFIED_CODEX_DREAM_VERSION}; ${evidence.cliVersion === undefined ? "the installed version could not be determined" : `installed CLI ${evidence.cliVersion} has not been qualified`}. Select the verified runtime or another supported Dream harness. Ordinary Codex chats remain available.`,
        };
      }
      return {
        mode: "guided",
        verifiedCliVersion: VERIFIED_CODEX_DREAM_VERSION,
        reason:
          "Gram starts Dream with normal Codex permissions: workspace-write sandbox and on-request approvals. Instructions guide snapshot reads and candidate writes; native tools can read or change other permitted files. Gram validates the candidate before applying it through the user's selected per-run Review or Auto mode.",
      };
    case "grok":
      return { mode: "unsupported", reason: "Grok Build Dream confinement is not implemented." };
  }
};
