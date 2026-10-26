import type { PermissionMode } from "@gram/contracts";

/** Why a mode chip warns; `undefined` for modes that still ask before tools run. */
export const modeWarning = (mode: PermissionMode | undefined): string | undefined =>
  mode === "bypassPermissions"
    ? "Bypass permissions: tools run without asking for approval."
    : undefined;
