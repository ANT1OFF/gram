import {
  NOTICE_CUT_LINE,
  TRAY_ASKS_MAX,
  type ThreadId,
  type TrayAsk,
  type TrayMenu,
  type TrayWorkspace,
  type WorkspaceId,
} from "@gram/contracts";

import {
  askFingerprint,
  askScope,
  awayAsk,
  awayAskId,
  templateTitle,
  type ShownAsk,
} from "@/orchestration/ask-actions";
import type { Ask } from "@/orchestration/ask-model";
import type { WorkspaceAsks } from "@/orchestration/ask-stack";
import { isBusy } from "@/orchestration/wait-model";
import type { StripWorkspace } from "@/views/quiet-model";

// The menu bar's (tray's) menu, built by the same rule as the asks' notifications (`awayAsk`): the
// exact command and extras, and an Allow or Merge only when they are shown whole. No React.

/** What the page keeps of an ask it put in the menu, to answer or open it when it is picked. */
export interface ShownTrayAsk extends ShownAsk {
  /** Where Open goes: the stack on the workspace's orchestrator, else the asking thread. */
  readonly openThreadId: ThreadId | undefined;
}

/** What the page keeps of a workspace line. */
export interface ShownTrayWorkspace {
  readonly workspaceId: WorkspaceId;
  readonly orchestratorThreadId: ThreadId | undefined;
}

export interface BuiltTrayMenu {
  readonly menu: TrayMenu;
  readonly asks: ReadonlyMap<string, ShownTrayAsk>;
  readonly workspaces: ReadonlyMap<string, ShownTrayWorkspace>;
}

/**
 * An ask's token in the menu: its scope (workspace, threads, request ids) and its fingerprint (the
 * very input shown). A request replaced or changed under the same id is another token, so a pick
 * of the old one can never be read as the new ask.
 */
export const trayAskToken = (scope: string, fingerprint: string): string =>
  awayAskId(JSON.stringify([scope, fingerprint]));

/** One ask's menu entry, and what the page keeps to act on it. */
const trayAskOf = (
  ask: Ask,
  workspace: Pick<WorkspaceAsks, "workspaceId" | "name" | "orchestratorThreadId">,
): { readonly entry: TrayAsk; readonly shown: ShownTrayAsk } => {
  const away = awayAsk(ask, true);
  const fingerprint = askFingerprint(ask);
  const id = trayAskToken(askScope(ask, workspace.workspaceId), fingerprint);
  // The cut line is the submenu's own "Open to review"; the menu says it once.
  const lines = away.text.split("\n").filter((line) => line !== NOTICE_CUT_LINE);
  return {
    entry: {
      id,
      title: templateTitle(ask),
      context: `${workspace.name} · ${ask.context}`,
      lines,
      ...(away.button === undefined ? {} : { answer: away.button.label }),
    },
    shown: {
      workspaceId: workspace.workspaceId,
      askKey: ask.key,
      fingerprint,
      button: away.button,
      openThreadId: workspace.orchestratorThreadId ?? ask.group?.entries[0]?.threadId,
    },
  };
};

/**
 * The menu for every workspace's asks and status, in the workspaces' order, then Pause all, or
 * Resume all when `allPaused`; none when it is undefined (no workspaces to pause).
 */
export const trayMenuOf = (
  all: readonly WorkspaceAsks[],
  strip: readonly StripWorkspace[],
  allPaused?: boolean,
): BuiltTrayMenu => {
  const asks = new Map<string, ShownTrayAsk>();
  const entries: TrayAsk[] = [];
  let more = 0;
  for (const workspace of all) {
    for (const ask of workspace.asks) {
      if (entries.length >= TRAY_ASKS_MAX) {
        more++;
        continue;
      }
      const { entry, shown } = trayAskOf(ask, workspace);
      entries.push(entry);
      asks.set(entry.id, shown);
    }
  }
  // Quiet's strip: each workspace's Now workers; busy counts a live turn and a wait on automation.
  const workers = new Map(strip.map((w) => [w.workspaceId, w.workers]));
  const workspaces = new Map<string, ShownTrayWorkspace>();
  const lines: TrayWorkspace[] = all.map((workspace) => {
    const id = awayAskId(`workspace:${workspace.workspaceId}`).replace(/^ask-/, "ws-");
    workspaces.set(id, {
      workspaceId: workspace.workspaceId,
      orchestratorThreadId: workspace.orchestratorThreadId,
    });
    const rows = workers.get(workspace.workspaceId) ?? [];
    return {
      id,
      name: workspace.name,
      busy: rows.filter((row) => isBusy(row.activity)).length,
      asks: workspace.asks.length,
      failed: rows.filter((row) => row.glyph === "error").length,
    };
  });
  return {
    menu: {
      asks: entries,
      more,
      workspaces: lines,
      ...(allPaused === undefined || lines.length === 0 ? {} : { allPaused }),
    },
    asks,
    workspaces,
  };
};

/**
 * What the menus sent showed under `id`, newest first. A token names one scope and one fingerprint,
 * so every menu that has it showed the same ask; a token no menu has finds nothing.
 */
export function shownIn<K extends "asks" | "workspaces">(
  sent: readonly BuiltTrayMenu[],
  kind: K,
  id: string,
): (K extends "asks" ? ShownTrayAsk : ShownTrayWorkspace) | undefined {
  for (const menu of sent.toReversed()) {
    const shown = menu[kind].get(id);
    if (shown !== undefined) return shown as K extends "asks" ? ShownTrayAsk : ShownTrayWorkspace;
  }
  return undefined;
}
