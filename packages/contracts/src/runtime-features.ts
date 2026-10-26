// Shared local feature availability. The server leaves shell capabilities unspecified;
// renderer callers provide the bridge so missing native capabilities remain hidden.

import type { DesktopBridge } from "./desktop-bridge.ts";

export interface RuntimeFeature {
  /** What the feature does, as a refusal names it. */
  readonly what: string;
  readonly needsShell?: readonly (keyof DesktopBridge)[];
  /** An explicit refusal; a shell bridge cannot make this feature available. */
  readonly unavailable?: string;
}

const FEATURES = {
  openInEditor: { what: "Opening files in an editor" },
  revealInFileManager: { what: "Showing files in a file manager" },
  openLogsFolder: { what: "Opening the logs folder" },
  cliUpdates: { what: "Updating an agent CLI" },
  appUpdates: { what: "Checking for app updates" },
  claudeAiConnectorSignIn: {
    what: "Signing in to a claude.ai connector with no Claude thread running",
  },
  dictation: { what: "Dictation", needsShell: ["speech"] },
  fontList: { what: "Listing installed fonts", needsShell: ["listFonts"] },
  previewPane: { what: "Previewing a local app inside Gram", needsShell: ["preview"] },
  agentBrowsing: {
    what: "Agents browsing local apps in the Preview pane",
    needsShell: ["preview"],
  },
  agentBrowsingPublic: {
    what: "Agents browsing public sites in the Preview pane",
    needsShell: ["preview", "agentBrowse"],
  },
} satisfies Record<string, RuntimeFeature>;

export type RuntimeFeatureId = keyof typeof FEATURES;
export const RUNTIME_FEATURES: Readonly<Record<RuntimeFeatureId, RuntimeFeature>> = FEATURES;

export interface RuntimeWhere {
  /** Omitted on the server, which cannot observe the shell; null means no native bridge. */
  readonly shell?: Partial<DesktopBridge> | null | undefined;
}

export const featureAvailable = (id: RuntimeFeatureId, where: RuntimeWhere): boolean => {
  const feature = RUNTIME_FEATURES[id];
  if (feature.unavailable !== undefined) return false;
  if (where.shell === undefined) return true;
  return (feature.needsShell ?? []).every((member) => where.shell?.[member] !== undefined);
};

export const featureRefusal = (id: RuntimeFeatureId): string => {
  const feature = RUNTIME_FEATURES[id];
  return feature.unavailable ?? `${feature.what} isn't available here.`;
};
