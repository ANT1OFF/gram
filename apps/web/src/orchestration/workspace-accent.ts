import type { WorkspaceId } from "@gram/contracts";
import type { CSSProperties } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// A colour the user gives a workspace, to tell its orchestrator from the others at a glance: a bar
// beside its line in the sidebar, the guide beside its workers and its orchestrator's glyph. It
// says whose a thing is, never a status, so no hue here is near the amber, red, green or blue a
// status takes, and it never tints a name, a row's ground or a status dot.

/** The colours on offer, by name, each a hue (oklch degrees) the theme sets light and dark. */
export const WORKSPACE_ACCENTS = [
  { id: "violet", label: "Violet", hue: 300 },
  { id: "magenta", label: "Magenta", hue: 330 },
  { id: "pink", label: "Pink", hue: 355 },
  { id: "lime", label: "Lime", hue: 118 },
  { id: "teal", label: "Teal", hue: 185 },
  { id: "cyan", label: "Cyan", hue: 215 },
] as const;

export type WorkspaceAccentId = (typeof WORKSPACE_ACCENTS)[number]["id"];

const HUE: ReadonlyMap<string, number> = new Map(
  WORKSPACE_ACCENTS.map((accent) => [accent.id, accent.hue]),
);

/** Only the workspaces whose stored colour is one still on offer. */
export const knownAccents = (raw: unknown): Record<string, WorkspaceAccentId> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, WorkspaceAccentId] =>
        typeof entry[1] === "string" && HUE.has(entry[1]),
    ),
  );
};

/** What an element in a workspace's colour carries: its hue, for `.gram-accent-*` to paint. */
export const accentStyle = (accent: WorkspaceAccentId | undefined): CSSProperties | undefined =>
  accent === undefined ? undefined : ({ "--accent-hue": HUE.get(accent) } as CSSProperties);

interface WorkspaceAccentState {
  /** Workspace id → its colour. A workspace without one is not listed. */
  byWorkspace: Readonly<Record<string, WorkspaceAccentId>>;
  /** Gives `workspaceId` a colour, or takes it away. */
  setAccent(workspaceId: WorkspaceId, accent: WorkspaceAccentId | undefined): void;
}

/** Each workspace's colour, kept on this machine only. */
export const useWorkspaceAccents = create<WorkspaceAccentState>()(
  persist(
    (set) => ({
      byWorkspace: {},
      setAccent: (workspaceId, accent) =>
        set((s) => {
          const { [workspaceId]: _was, ...rest } = s.byWorkspace;
          return { byWorkspace: accent === undefined ? rest : { ...rest, [workspaceId]: accent } };
        }),
    }),
    {
      name: "gram.workspaceAccent",
      version: 1,
      // `window`, not `globalThis`: under Node, reading `globalThis.localStorage` warns that it has no
      // backing file, while a missing `window` throws, which zustand takes as no storage.
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ byWorkspace }) => ({ byWorkspace }),
      merge: (persisted, current) => ({
        ...current,
        byWorkspace: knownAccents(
          (persisted as { byWorkspace?: unknown } | undefined)?.byWorkspace,
        ),
      }),
    },
  ),
);

/** A workspace's colour, if the user gave it one. */
export const useWorkspaceAccent = (
  workspaceId: WorkspaceId | undefined,
): WorkspaceAccentId | undefined =>
  useWorkspaceAccents((s) => (workspaceId === undefined ? undefined : s.byWorkspace[workspaceId]));
