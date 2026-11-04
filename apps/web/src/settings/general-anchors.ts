/**
 * Settings → General's subsections, each an anchor the nav links to while General is open. Their
 * ids are the page's DOM ids, so `#general-branches` names one.
 */
export const GENERAL_ANCHORS = {
  launch: "general-launch",
  branches: "general-branches",
  composer: "general-composer",
  interruptions: "general-interruptions",
  running: "general-running",
  editor: "general-editor",
  links: "general-links",
} as const;

export interface SettingsAnchor {
  readonly id: string;
  readonly label: string;
}

/** The nav's links under General, in the page's order. */
export const GENERAL_SECTIONS: readonly SettingsAnchor[] = [
  { id: GENERAL_ANCHORS.launch, label: "Launch" },
  { id: GENERAL_ANCHORS.branches, label: "Branches" },
  { id: GENERAL_ANCHORS.composer, label: "Composer" },
  { id: GENERAL_ANCHORS.interruptions, label: "Interruptions" },
  { id: GENERAL_ANCHORS.running, label: "Running work" },
  { id: GENERAL_ANCHORS.editor, label: "Editor" },
  { id: GENERAL_ANCHORS.links, label: "Links" },
];
