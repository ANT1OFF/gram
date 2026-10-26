// The tray's (macOS menu bar's) menu: what a page sent, held to the rules again, and laid out as
// plain entries the module turns into Electron's menu. No Electron here.

import {
  EMPTY_TRAY_MENU,
  TRAY_ASKS_MAX,
  TRAY_LINE_MAX,
  TRAY_LINES_MAX,
  TRAY_WORKSPACES_MAX,
  trayAnswerable,
  trayText,
  type TrayAction,
  type TrayAsk,
  type TrayMenu,
  type TrayWorkspace,
} from "@gram/contracts/desktop-bridge";

/** A page-made token: never text the menu shows. */
const TOKEN = /^[\w:-]{1,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, 9999) : 0;

const askOf = (input: unknown): TrayAsk | undefined => {
  if (!isRecord(input)) return undefined;
  const { id, title, context, lines, answer } = input;
  if (typeof id !== "string" || !TOKEN.test(id)) return undefined;
  if (typeof title !== "string" || typeof context !== "string") return undefined;
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return undefined;
  const shown = lines as string[];
  // An answer only under lines shown whole, by the notifications' rule, whatever the page asked.
  const answers = trayAnswerable(shown, answer);
  return {
    id,
    title: trayText(title),
    context: trayText(context),
    // Otherwise read-only lines, plain and short; the submenu sends them to the window.
    lines: answers
      ? shown
      : shown.slice(0, TRAY_LINES_MAX).map((line) => trayText(line, TRAY_LINE_MAX)),
    ...(answers ? { answer } : {}),
  };
};

const workspaceOf = (input: unknown): TrayWorkspace | undefined => {
  if (!isRecord(input)) return undefined;
  const { id, name } = input;
  if (typeof id !== "string" || !TOKEN.test(id) || typeof name !== "string") return undefined;
  return {
    id,
    name: trayText(name),
    busy: count(input["busy"]),
    asks: count(input["asks"]),
    failed: count(input["failed"]),
  };
};

/** A page's menu, bounded; anything malformed in it is left out, and nothing malformed is empty. */
export function parseTrayMenu(input: unknown): TrayMenu {
  if (!isRecord(input)) return EMPTY_TRAY_MENU;
  const asksIn = Array.isArray(input["asks"]) ? input["asks"] : [];
  const workspacesIn = Array.isArray(input["workspaces"]) ? input["workspaces"] : [];
  const asks = asksIn.flatMap((each) => askOf(each) ?? []);
  const workspaces = workspacesIn
    .flatMap((each) => workspaceOf(each) ?? [])
    .slice(0, TRAY_WORKSPACES_MAX);
  return {
    asks: asks.slice(0, TRAY_ASKS_MAX),
    more: count(input["more"]) + Math.max(0, asks.length - TRAY_ASKS_MAX),
    workspaces,
    // Only a true or false, and only beside workspaces it could pause.
    ...(workspaces.length > 0 && typeof input["allPaused"] === "boolean"
      ? { allPaused: input["allPaused"] }
      : {}),
  };
}

/** Whether `input` is an action this menu could have sent back. */
export function isTrayAction(input: unknown): input is TrayAction {
  if (!isRecord(input)) return false;
  if (input["kind"] === "asks") return true;
  if (input["kind"] === "pauseAll") return typeof input["paused"] === "boolean";
  return (
    (input["kind"] === "answer" || input["kind"] === "open" || input["kind"] === "workspace") &&
    typeof input["id"] === "string" &&
    TOKEN.test(input["id"])
  );
}

/** One entry of the menu, before it is Electron's. */
export type TrayEntry =
  | { readonly kind: "separator" }
  | {
      readonly kind: "item";
      readonly label: string;
      /** What picking it does; none for a line that is only read. */
      readonly run?: TrayAction | "show" | "quit";
      readonly submenu?: readonly TrayEntry[];
    };

const SEPARATOR: TrayEntry = { kind: "separator" };

/** "6 busy · 1 ask", or "idle". */
export const workspaceStatus = (workspace: TrayWorkspace): string => {
  const parts = [
    workspace.busy > 0 ? `${workspace.busy} busy` : undefined,
    workspace.asks > 0 ? `${workspace.asks} ${workspace.asks === 1 ? "ask" : "asks"}` : undefined,
    workspace.failed > 0 ? `${workspace.failed} failed` : undefined,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? "idle" : parts.join(" · ");
};

/** An ask's submenu: who asks, the exact lines, then its answer and Open. */
const askEntries = (ask: TrayAsk): TrayEntry[] => {
  const lines: TrayEntry[] = ask.lines.map((line) => ({ kind: "item", label: line }));
  // Lines with no answer under them may be cut short for the menu: the window shows them whole.
  if (lines.length > 0 && ask.answer === undefined) {
    lines.push({ kind: "item", label: "Open to review" });
  }
  return [
    { kind: "item", label: ask.context },
    ...(lines.length === 0 ? [] : [SEPARATOR, ...lines]),
    SEPARATOR,
    ...(ask.answer === undefined
      ? []
      : [{ kind: "item", label: ask.answer, run: { kind: "answer", id: ask.id } } as const]),
    { kind: "item", label: "Open", run: { kind: "open", id: ask.id } },
  ];
};

/** The whole menu: Open, the asks, the workspaces and Pause all (or Resume all), Quit. */
export function trayEntries(menu: TrayMenu, productName: string): TrayEntry[] {
  const asks: TrayEntry[] = menu.asks.map((ask) => ({
    kind: "item",
    label: ask.title,
    submenu: askEntries(ask),
  }));
  if (menu.more > 0) {
    asks.push({
      kind: "item",
      label: `${menu.more} more ${menu.more === 1 ? "ask" : "asks"}`,
      run: { kind: "asks" },
    });
  }
  const workspaces: TrayEntry[] = menu.workspaces.map((workspace) => ({
    kind: "item",
    label: `${workspace.name} — ${workspaceStatus(workspace)}`,
    run: { kind: "workspace", id: workspace.id },
  }));
  if (menu.allPaused !== undefined) {
    // The pick says what the item said, so a menu opened before a change does what it showed.
    workspaces.push({
      kind: "item",
      label: menu.allPaused ? "Resume all" : "Pause all",
      run: { kind: "pauseAll", paused: !menu.allPaused },
    });
  }
  return [
    { kind: "item", label: `Open ${productName}`, run: "show" },
    ...(asks.length === 0 ? [] : [SEPARATOR, ...asks]),
    ...(workspaces.length === 0 ? [] : [SEPARATOR, ...workspaces]),
    SEPARATOR,
    { kind: "item", label: `Quit ${productName}`, run: "quit" },
  ];
}

/** The asks the menu bar's title counts. */
export const trayAskCount = (menu: TrayMenu): number => menu.asks.length + menu.more;

/**
 * A label as Windows and Linux menus draw it: there `&` marks the next letter as the item's
 * mnemonic and is hidden, so an exact command keeps its `&` only doubled.
 */
export const menuLabel = (label: string, platform: NodeJS.Platform): string =>
  platform === "darwin" ? label : label.replaceAll("&", "&&");

/**
 * A 32 bpp BGRA bitmap of the menu bar glyph: four rounded squares, two by two, like the app
 * icon's four runes. Black on clear, for a macOS template image the menu bar tints itself.
 */
export function trayGlyphBitmap(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const pad = size * 0.16;
  const gap = size * 0.12;
  const side = (size - 2 * pad - gap) / 2;
  const radius = side * 0.28;
  /** Coverage of one rounded square at a pixel's centre, anti-aliased over a pixel. */
  const cover = (x: number, y: number, left: number, top: number) => {
    const cx = Math.min(Math.max(x, left + radius), left + side - radius);
    const cy = Math.min(Math.max(y, top + radius), top + side - radius);
    const d = Math.hypot(x - cx, y - cy) - radius;
    return Math.max(0, Math.min(1, 0.5 - d));
  };
  const origins = [pad, pad + side + gap];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0;
      for (const top of origins) {
        for (const left of origins) a = Math.max(a, cover(x + 0.5, y + 0.5, left, top));
      }
      // Black, premultiplied: only alpha carries the shape.
      buf[(y * size + x) * 4 + 3] = Math.round(a * 255);
    }
  }
  return buf;
}
