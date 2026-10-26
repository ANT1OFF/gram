import type { AppUpdateState } from "@gram/contracts";

import { formatClockTime, notificationTime } from "@/lib/time";

/** What clicking the pill does. */
type PillAction = "check" | "download" | "install" | "settings" | "none";

type PillKind =
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error"
  | "notApplied";

export interface PillView {
  readonly kind: PillKind;
  /** The few words beside the icon, when there are any. */
  readonly label?: string;
  /** The hover text: what this is, then what a click does. */
  readonly hint: string;
  /** The release's notes, for the hover. */
  readonly notes?: string;
  readonly action: PillAction;
  readonly percent?: number;
  /** The version the pill is about, for its accessible name. */
  readonly version?: string;
}

const RESTART_NOTE = "Gram saves sessions and stops running agents first.";
const ELSEWHERE = "Gram updates itself only from Applications. Click for Settings → Updates.";

/** `Published 16 Oct, 10:00`, on a 24-hour clock; undefined for no or a malformed date. */
function published(date: string | null, intl?: { timeZone?: string; locale?: string }) {
  const at = date === null ? Number.NaN : Date.parse(date);
  return Number.isFinite(at) ? `Published ${notificationTime(at, intl)}` : undefined;
}

/** Release notes as the hover shows them: Markdown's marks dropped, blank runs collapsed. */
export function notesPreview(notes: string): string {
  return notes
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^(\s*)[-*+]\s+/, "$1• ")
        .replace(/\*\*|__|`/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .trimEnd(),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const lines = (...parts: Array<string | undefined | false>) =>
  parts.filter((part): part is string => typeof part === "string" && part !== "").join("\n");

/**
 * The update pill for a signed install's updater state, or undefined while there's nothing to
 * say: before a check, when current, and for a background check (or its failure), which stays
 * quiet. A manual check, an update, a download, a restart, a problem and a signed-out `gh` show.
 */
export function pillView(
  state: AppUpdateState | null | undefined,
  intl?: { timeZone?: string; locale?: string },
): PillView | undefined {
  if (!state) return undefined;
  const notes = state.releaseNotes ? notesPreview(state.releaseNotes) || undefined : undefined;
  const withNotes = (view: PillView): PillView => (notes ? { ...view, notes } : view);
  const available = state.availableVersion ?? undefined;
  const downloaded = state.downloadedVersion ?? available;
  const notApplied = state.notApplied;

  switch (state.status) {
    case "installing":
      return {
        kind: "installing",
        label: "Restarting…",
        hint: lines(`Restarting into Gram ${downloaded}.`, state.message ?? RESTART_NOTE),
        action: "none",
        ...(downloaded ? { version: downloaded } : {}),
      };
    case "ready":
      return withNotes({
        kind: "ready",
        label: "Restart",
        hint: lines(
          `Gram ${downloaded} is ready.`,
          published(state.releaseDate, intl),
          state.canInstall ? `Restart to update. ${RESTART_NOTE}` : ELSEWHERE,
        ),
        action: state.canInstall ? "install" : "settings",
        ...(downloaded ? { version: downloaded } : {}),
      });
    case "downloading": {
      const percent = Math.floor(state.percent ?? 0);
      // At 100% the download is whole and Gram is checking it before offering a restart.
      return withNotes({
        kind: "downloading",
        label: percent >= 100 ? "Verifying…" : `${percent}%`,
        hint:
          percent >= 100
            ? `Verifying Gram ${available}: its signature, notarization and version.`
            : `Downloading Gram ${available} · ${percent}%`,
        action: "none",
        percent,
        ...(available ? { version: available } : {}),
      });
    }
    case "available":
      return withNotes({
        kind: "available",
        hint: lines(
          notApplied?.version === available && `Gram ${available} didn't apply last time.`,
          `Gram ${available} is available.`,
          published(state.releaseDate, intl),
          state.canInstall ? "Click to download." : ELSEWHERE,
        ),
        action: state.canInstall ? "download" : "settings",
        ...(available ? { version: available } : {}),
      });
    case "error":
      if (state.errorStep === "install")
        return {
          kind: "error",
          hint: lines(
            state.message ?? "The restart was refused.",
            state.canInstall ? "Click to try again." : "Click for Settings → Updates.",
          ),
          action: state.canInstall ? "install" : "settings",
          ...(downloaded ? { version: downloaded } : {}),
        };
      if (state.errorStep === "download")
        return {
          kind: "error",
          hint: lines(
            `Couldn't download Gram ${available}: ${state.message ?? "the download failed."}`,
            "Click to try again.",
          ),
          action: "download",
          ...(available ? { version: available } : {}),
        };
      // A timer's failed check stays in Settings; a manual one says so here too.
      if (!state.manual) break;
      return {
        kind: "error",
        hint: lines(state.message ?? "The check for updates failed.", "Click to check again."),
        action: "check",
      };
    case "checking":
      if (state.manual) return { kind: "checking", hint: "Checking for updates…", action: "none" };
      break;
    case "idle":
    case "upToDate":
      break;
  }
  if (notApplied)
    return {
      kind: "notApplied",
      hint: lines(`Gram ${notApplied.version} wasn't applied.`, notApplied.reason),
      action: "settings",
      version: notApplied.version,
    };
  return undefined;
}

/** Settings → Updates' one-line status for the same state. */
export function statusLine(
  state: AppUpdateState,
  intl?: { timeZone?: string; locale?: string },
): string {
  const checked =
    state.checkedAt === null ? undefined : `checked ${formatClockTime(state.checkedAt, intl)}`;
  switch (state.status) {
    case "idle":
      return "Not checked yet";
    case "checking":
      return "Checking for updates…";
    case "upToDate":
      return lines(`Up to date${checked ? ` · ${checked}` : ""}`);
    case "available":
      return `Gram ${state.availableVersion} is available${checked ? ` · ${checked}` : ""}`;
    case "downloading":
      return (state.percent ?? 0) >= 100
        ? `Verifying Gram ${state.availableVersion}`
        : `Downloading Gram ${state.availableVersion} · ${Math.floor(state.percent ?? 0)}%`;
    case "ready":
      return `Gram ${state.downloadedVersion} is downloaded and verified · restart to update`;
    case "installing":
      return state.message ?? `Restarting into Gram ${state.downloadedVersion}…`;
    case "error":
      // The reason itself shows once, below the buttons.
      return state.errorStep === "install"
        ? `Gram ${state.downloadedVersion} is downloaded · the restart didn't go ahead`
        : state.errorStep === "download"
          ? `Gram ${state.availableVersion} didn't download`
          : `The check didn't finish${checked ? ` · ${checked}` : ""}`;
  }
}
