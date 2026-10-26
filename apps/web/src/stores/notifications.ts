import { presentableUrl, redactText, type ServerEvent, type ThreadId } from "@gram/contracts";
import { create } from "zustand";

type Notification = Extract<ServerEvent, { type: "notify" }>;
interface NotificationEntry {
  readonly id: string;
  readonly kind: Notification["kind"];
  readonly title: string;
  readonly body?: string;
  readonly source?: string;
  readonly diagnosticKey?: string;
  readonly threadIds: readonly ThreadId[];
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly count: number;
  readonly read: boolean;
}

export const NOTIFICATIONS_KEY = "gram.notifications.v1";
export const HISTORY_LIMIT = 100;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_STORED_BYTES = 512_000;
const KINDS = new Set(["info", "done", "needsInput", "error"]);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const timestamp = (value: unknown, now: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > now - RETENTION_MS && value <= now;
const OMITTED_DETAILS = "Sensitive notification details omitted";
// Header/config values have no reliable delimiter (cookies, arbitrary auth schemes and multiline
// keys). Omit the entire field rather than guessing where a credential ends. Names are bounded.
const SENSITIVE_CONTENT =
  /\b[\w.-]{0,64}(?:cookie|auth(?:orization|entication)?|private[-_ .]?key|credential|token|secret|password|passphrase|api[-_ .]?key|(?:http|request|response)[-_ .]?headers)[\w.-]{0,64}["'\\\s]*[:=]|-----BEGIN [^-]*PRIVATE KEY-----/i;
const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  if (SENSITIVE_CONTENT.test(value)) return OMITTED_DETAILS;
  return redactText(value.replace(/https?:\/\/[^\s<>"']+/g, presentableUrl)).slice(0, max);
};
const threadId = (value: unknown): value is ThreadId =>
  typeof value === "string" && value.length > 0 && value.length <= 128;

type Quiet = Readonly<Record<string, number>>;
interface Retained {
  readonly entries: readonly NotificationEntry[];
  /** Independent of read/clear: clearing history must not turn recurring warnings back into spam. */
  readonly quiet: Quiet;
}
const boundedQuiet = (quiet: Quiet, now: number): Quiet =>
  Object.fromEntries(
    Object.entries(quiet)
      .filter(([key, at]) => digest(key) && timestamp(at, now))
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, HISTORY_LIMIT),
  );

/** Treat local storage as untrusted input, including old versions, oversize and malformed records. */
export function restoreNotifications(raw: string | null, now: number): Retained {
  const empty = { entries: [], quiet: {} };
  if (raw === null || raw.length > MAX_STORED_BYTES) return empty;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1)
      return empty;
    const state = value as { entries?: unknown; quiet?: unknown };
    const entries: NotificationEntry[] = [];
    const ids = new Set<string>();
    for (const candidate of Array.isArray(state.entries)
      ? state.entries.slice(0, HISTORY_LIMIT * 2)
      : []) {
      if (typeof candidate !== "object" || candidate === null) continue;
      const c = candidate as Record<string, unknown>;
      const title = text(c.title, 320);
      if (
        !title ||
        typeof c.id !== "string" ||
        c.id.length > 128 ||
        ids.has(c.id) ||
        typeof c.kind !== "string" ||
        !KINDS.has(c.kind) ||
        !timestamp(c.lastSeen, now) ||
        typeof c.firstSeen !== "number" ||
        !Number.isFinite(c.firstSeen) ||
        c.firstSeen < 0 ||
        c.firstSeen > c.lastSeen ||
        typeof c.count !== "number" ||
        !Number.isInteger(c.count) ||
        c.count < 1 ||
        c.count > 1_000_000 ||
        typeof c.read !== "boolean"
      )
        continue;
      ids.add(c.id);
      const body = text(c.body, 2000);
      const source = text(c.source, 120);
      entries.push({
        id: c.id,
        kind: c.kind as Notification["kind"],
        title,
        ...(body ? { body } : {}),
        ...(source ? { source } : {}),
        ...(c.kind === "info" && digest(c.diagnosticKey) ? { diagnosticKey: c.diagnosticKey } : {}),
        threadIds: Array.isArray(c.threadIds)
          ? [...new Set(c.threadIds.filter(threadId))].slice(-8)
          : [],
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
        count: c.count,
        read: c.read,
      });
    }
    const quiet: Record<string, number> = {};
    if (typeof state.quiet === "object" && state.quiet !== null)
      for (const [key, at] of Object.entries(state.quiet).slice(0, HISTORY_LIMIT * 2))
        if (digest(key) && timestamp(at, now)) quiet[key] = at;
    return {
      entries: entries.toSorted((a, b) => b.lastSeen - a.lastSeen).slice(0, HISTORY_LIMIT),
      quiet: boundedQuiet(quiet, now),
    };
  } catch {
    return empty;
  }
}

export interface NotificationHistoryState extends Retained {
  readonly storageUnavailable: boolean;
  /** Returns whether this event warrants a toast. Only explicit info diagnostics are quieted. */
  record(notification: Notification, at?: number): boolean;
  markRead(id?: string): void;
  prune(): void;
  clear(): void;
}

export function createNotificationHistory(storage: () => Storage | undefined) {
  const save = (state: Retained) => {
    try {
      const target = storage();
      if (!target) return false;
      target.setItem(
        NOTIFICATIONS_KEY,
        JSON.stringify({ version: 1, entries: state.entries, quiet: state.quiet }),
      );
      return true;
    } catch {
      // Disabled storage or quota: the bounded in-memory center still works.
      return false;
    }
  };
  const read = (): Retained & { storageUnavailable: boolean } => {
    try {
      const raw = storage()?.getItem(NOTIFICATIONS_KEY) ?? null;
      const retained = restoreNotifications(raw, Date.now());
      // Remove old unsafe fields from the stored cache too, without waiting for a new notification
      // or for the user to open the center. A failed rewrite still keeps sanitized in-memory data.
      const rewrite = raw !== null && raw !== JSON.stringify({ version: 1, ...retained });
      return { ...retained, storageUnavailable: rewrite && !save(retained) };
    } catch {
      return { entries: [], quiet: {}, storageUnavailable: true };
    }
  };
  return create<NotificationHistoryState>()((set, get) => ({
    ...read(),
    record: (n, at = Date.now()) => {
      const state = get();
      const key =
        n.kind === "info" && digest(n.startupDiagnostic?.key) ? n.startupDiagnostic.key : undefined;
      const quiet = boundedQuiet(state.quiet, at);
      const alert =
        key === undefined || quiet[key] === undefined || at - quiet[key] >= DIAGNOSTIC_COOLDOWN_MS;
      const entries = state.entries.filter((e) => timestamp(e.lastSeen, at));
      const previous = key === undefined ? undefined : entries.find((e) => e.diagnosticKey === key);
      const body = text(n.body, 2000);
      const source = text(n.startupDiagnostic?.source, 120);
      const entry: NotificationEntry = {
        id: previous?.id ?? crypto.randomUUID(),
        kind: n.kind,
        title: text(n.title, 320) ?? "Notification",
        ...(body ? { body } : {}),
        ...(key === undefined ? {} : { diagnosticKey: key, ...(source ? { source } : {}) }),
        threadIds: [
          ...new Set([
            ...(previous?.threadIds ?? []),
            ...(threadId(n.threadId) ? [n.threadId] : []),
          ]),
        ].slice(-8),
        firstSeen: previous?.firstSeen ?? at,
        lastSeen: at,
        count: Math.min(1_000_000, (previous?.count ?? 0) + 1),
        read: alert ? false : (previous?.read ?? false),
      };
      const retained = {
        entries: [entry, ...entries.filter((e) => e !== previous)].slice(0, HISTORY_LIMIT),
        quiet: key !== undefined && alert ? boundedQuiet({ ...quiet, [key]: at }, at) : quiet,
      };
      set({ ...retained, storageUnavailable: !save(retained) });
      return alert;
    },
    markRead: (id) => {
      const state = get();
      const next = {
        ...state,
        entries: state.entries.map((e) =>
          id === undefined || e.id === id ? { ...e, read: true } : e,
        ),
      };
      set({ ...next, storageUnavailable: !save(next) });
    },
    prune: () => {
      const state = get();
      const now = Date.now();
      const next = {
        entries: state.entries.filter((e) => timestamp(e.lastSeen, now)),
        quiet: boundedQuiet(state.quiet, now),
      };
      set({ ...next, storageUnavailable: !save(next) });
    },
    clear: () => {
      const next = { entries: [], quiet: boundedQuiet(get().quiet, Date.now()) };
      set({ ...next, storageUnavailable: !save(next) });
    },
  }));
}

export const useNotificationHistory = createNotificationHistory(() =>
  typeof window === "undefined" ? undefined : window.localStorage,
);
export const unreadNotifications = (s: NotificationHistoryState): number =>
  s.entries.filter((e) => !e.read).length;
