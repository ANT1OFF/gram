import type { Attachment, DraftId } from "@gram/contracts";
import { useCallback, useState, useSyncExternalStore } from "react";

import type { TaskTarget } from "@/orchestration/task-model";

/** What the next draft starts on. */
let pendingRoot: string | undefined;
/** The last project prefilled, numbered so an open draft can tell a new one from one it has. */
let latest: { readonly root: string | undefined; readonly seq: number } = {
  root: undefined,
  seq: 0,
};
const listeners = new Set<() => void>();

/**
 * Preselects a project for the next `/new` draft (e.g. from the palette's Projects section), and
 * for the draft already open, which a navigation to `/new` doesn't remount.
 */
export function prefillDraftProject(root: string | undefined) {
  pendingRoot = root;
  if (root === undefined) return;
  latest = { root, seq: latest.seq + 1 };
  for (const listener of listeners) listener();
}

export function draftProjectPrefill(): string | undefined {
  return pendingRoot;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const snapshot = () => latest;

/**
 * The draft's project root and its setter. Whichever came last wins: a prefill newer than what the
 * user typed shows, and what the user types after a prefill replaces it. One value, so a prefill
 * landing mid-render or before the draft subscribed is never half-applied or lost.
 */
export function useDraftProjectRoot() {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [typed, setTyped] = useState(() => ({ root: pendingRoot, seq: latest.seq }));
  const root = current.seq > typed.seq ? current.root : typed.root;
  const setRoot = useCallback(
    (next: string | undefined) => setTyped({ root: next, seq: latest.seq }),
    [],
  );
  return [root, setRoot] as const;
}

/** What one draft hands the other when the target picker switches between them. */
export interface CarriedDraft {
  readonly text: string;
  /** The files staged so far live under this id, so the other draft keeps sending them. */
  readonly draftId: DraftId;
  readonly attachments: readonly Attachment[];
}

let carried: CarriedDraft | undefined;

/** Hands `draft` to the next draft that opens: New task to the one-off thread, or back. */
export function carryDraft(draft: CarriedDraft) {
  carried = draft;
}

/**
 * The carried draft, for a draft's initial state. It is only read here, since Strict Mode runs an
 * initializer twice; the draft lets go of it with `dropCarriedDraft` once it has mounted.
 */
export function carriedDraft(): CarriedDraft | undefined {
  return carried;
}

export function dropCarriedDraft() {
  carried = undefined;
}

let pendingTarget: TaskTarget | undefined;

/** Starts the next New task draft on `target`, as the one-off draft's picker hands it over. */
export function prefillTaskTarget(target: TaskTarget | undefined) {
  pendingTarget = target;
}

/** The handed-over target, read like `carriedDraft` and let go of with `dropTaskTarget`. */
export function pendingTaskTarget(): TaskTarget | undefined {
  return pendingTarget;
}

export function dropTaskTarget() {
  pendingTarget = undefined;
}

/**
 * The user's pick on a draft, starting at `initial`, until the route's entry (`entry`, as a key)
 * changes: a new entry from the New menu replaces the pick.
 */
export function useRoutePick<T>(entry: string, initial: () => T | undefined) {
  const [choice, setChoice] = useState(() => ({ entry, picked: initial() }));
  if (choice.entry !== entry) setChoice({ entry, picked: undefined });
  const picked = choice.entry === entry ? choice.picked : undefined;
  const setPicked = (next: T | undefined) => setChoice({ entry, picked: next });
  return [picked, setPicked] as const;
}
