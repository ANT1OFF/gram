import { fieldsOf, type WorkspaceId } from "@gram/contracts";
import type { CSSProperties } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

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

declare module "react" {
  interface CSSProperties {
    "--accent-hue"?: number | undefined;
  }
}

/** The colour on offer named `value`, if it is one. */
export const accentOf = (value: unknown): WorkspaceAccentId | undefined =>
  WORKSPACE_ACCENTS.find((accent) => accent.id === value)?.id;

/** Only the workspaces whose stored colour is one still on offer. */
export const knownAccents = (raw: unknown): Record<string, WorkspaceAccentId> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).flatMap(([workspace, stored]) => {
      const accent = accentOf(stored);
      return accent === undefined ? [] : [[workspace, accent] as const];
    }),
  );
};

/** What an element in a workspace's colour carries: its hue, for `.gram-accent-*` to paint. */
export const accentStyle = (accent: WorkspaceAccentId | undefined): CSSProperties | undefined =>
  accent === undefined ? undefined : { "--accent-hue": HUE.get(accent) };

interface WorkspaceAccentState {
  byWorkspace: Readonly<Record<string, WorkspaceAccentId>>;
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
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ byWorkspace }) => ({ byWorkspace }),
      merge: (persisted, current) => ({
        ...current,
        byWorkspace: knownAccents(fieldsOf(persisted).get("byWorkspace")),
      }),
    },
  ),
);

/** A workspace's colour, if the user gave it one. */
export const useWorkspaceAccent = (
  workspaceId: WorkspaceId | undefined,
): WorkspaceAccentId | undefined =>
  useWorkspaceAccents((s) => (workspaceId === undefined ? undefined : s.byWorkspace[workspaceId]));
