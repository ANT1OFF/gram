import type { StartupDiagnostic } from "@gram/contracts";
import { createHash } from "node:crypto";

/** Only the opaque digest leaves the adapter; scopes and provider details are never retained. */
export const startupDiagnostic = (
  scope: string,
  source: string,
  identity: readonly unknown[],
): StartupDiagnostic => ({
  source,
  key: createHash("sha256")
    .update(JSON.stringify([scope, source, ...identity]))
    .digest("hex"),
});
