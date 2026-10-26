import { INBOX_SET_ASIDE_LIMIT, type Settings, type SettingsPatch } from "@gram/contracts";
import { useEffect, useMemo, useState } from "react";

import { useServerSettings } from "@/settings-sync/store";

// What Needs you sets aside, kept in settings so it outlasts a reload and a restart: failures
// dismissed from the Board's Failing strip or the Needs you panel (`inbox.cleared`, named for the
// Inbox that first wrote it), and items put away for Later until a wake time (`inbox.snoozed`).
// Both are hidden from every view that reads `useWorkspaceAsks` or the strip, through the same
// hidden ids as an answer; a snoozed one comes back on its own when it wakes.

/** How long Later puts an item away. */
export const SNOOZE_MS = 60 * 60_000;

/** `inbox.snoozed` as id → the epoch ms it wakes; split at the last space, as an id may hold one. */
export const snoozesOf = (entries: readonly string[] | undefined): ReadonlyMap<string, number> =>
  new Map(
    (entries ?? []).flatMap((entry) => {
      const space = entry.lastIndexOf(" ");
      if (space <= 0) return [];
      const at = Number(entry.slice(space + 1));
      return Number.isFinite(at) ? [[entry.slice(0, space), at] as const] : [];
    }),
  );

/** `entries` with `ids` snoozed until `until`, woken ones gone, capped oldest-first. */
export const withSnoozes = (
  entries: readonly string[] | undefined,
  ids: readonly string[],
  until: number,
  now: number,
): string[] => {
  const kept = [...snoozesOf(entries)].filter(([id, at]) => at > now && !ids.includes(id));
  return [...kept.map(([id, at]) => `${id} ${at}`), ...ids.map((id) => `${id} ${until}`)].slice(
    -INBOX_SET_ASIDE_LIMIT,
  );
};

/** `entries` with `ids` awake again at once. */
export const withoutSnoozes = (entries: readonly string[] | undefined, ids: readonly string[]) =>
  [...snoozesOf(entries)].filter(([id]) => !ids.includes(id)).map(([id, at]) => `${id} ${at}`);

/** `entries` with `ids` cleared, each once, the most recent last, capped oldest-first. */
export const withCleared = (entries: readonly string[] | undefined, ids: readonly string[]) =>
  [...(entries ?? []).filter((id) => !ids.includes(id)), ...ids].slice(-INBOX_SET_ASIDE_LIMIT);

/** The ids snoozed past `now`, and the soonest of their wake times. */
export const asleep = (
  snoozes: ReadonlyMap<string, number>,
  now: number,
): { readonly ids: ReadonlySet<string>; readonly wakes: number | undefined } => {
  const ids = new Set<string>();
  let wakes: number | undefined;
  for (const [id, at] of snoozes) {
    if (at <= now) continue;
    ids.add(id);
    wakes = wakes === undefined ? at : Math.min(wakes, at);
  }
  return { ids, wakes };
};

/** What a save does to its ids: snoozes them until a time, wakes them now, or clears them. */
export type SetAsideHow =
  | { readonly snoozeUntil: number; readonly now: number }
  | "unsnooze"
  | "clear";

/** A save still in flight, which the next one builds on, so two quick ones both stay. */
let pending: NonNullable<Settings["inbox"]> | undefined;

/** The patch that sets `ids` aside, built on `settings` as they are and on any save in flight. */
const setAsidePatch = (
  settings: Settings | undefined,
  ids: readonly string[],
  how: SetAsideHow,
): { readonly inbox: NonNullable<Settings["inbox"]> } => {
  const base = { ...settings?.inbox, ...pending };
  const inbox =
    how === "clear"
      ? { cleared: withCleared(base.cleared, ids) }
      : how === "unsnooze"
        ? { snoozed: withoutSnoozes(base.snoozed, ids) }
        : { snoozed: withSnoozes(base.snoozed, ids, how.snoozeUntil, how.now) };
  return { inbox };
};

/** Saves `ids` set aside; resolves once the stored settings have them. */
export const saveSetAside = async (
  save: (patch: SettingsPatch) => Promise<Settings>,
  ids: readonly string[],
  how: SetAsideHow,
): Promise<void> => {
  const patch = setAsidePatch(useServerSettings.getState().settings, ids, how);
  const mine = { ...pending, ...patch.inbox };
  pending = mine;
  try {
    await save(patch);
  } finally {
    if (pending === mine) pending = undefined;
  }
};

/** Saves `ids` cleared (a dismissed failure); resolves once the stored settings have them. */
export const saveCleared = (
  save: (patch: SettingsPatch) => Promise<Settings>,
  ids: readonly string[],
): Promise<void> => saveSetAside(save, ids, "clear");

/**
 * The ids snoozed now, each with the epoch ms it wakes. Re-renders when the soonest wakes, so it
 * comes back on its own.
 */
function useAsleep(): ReadonlyMap<string, number> {
  const snoozed = useServerSettings((s) => s.settings?.inbox?.snoozed);
  const [now, setNow] = useState(() => Date.now());
  const { away, wakes } = useMemo(() => {
    const snoozes = snoozesOf(snoozed);
    const sleeping = asleep(snoozes, now);
    return {
      away: new Map([...snoozes].filter(([id]) => sleeping.ids.has(id))),
      wakes: sleeping.wakes,
    };
  }, [snoozed, now]);
  useEffect(() => {
    if (wakes === undefined) return;
    // At least a second, so a clock a little behind the wake doesn't spin.
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1_000, wakes - Date.now()));
    return () => clearTimeout(timer);
  }, [wakes]);
  return away;
}

/** Every failure id dismissed. */
function useCleared(): ReadonlySet<string> {
  const cleared = useServerSettings((s) => s.settings?.inbox?.cleared);
  return useMemo(() => new Set(cleared ?? []), [cleared]);
}

/** Every id set aside and still away: snoozed ones until they wake, and dismissed failures. */
export function useSetAside(): ReadonlySet<string> {
  const away = useAsleep();
  const cleared = useCleared();
  return useMemo(() => new Set([...away.keys(), ...cleared]), [away, cleared]);
}
