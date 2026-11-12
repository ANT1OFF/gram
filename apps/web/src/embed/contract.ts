// What an app in front of Gram writes against: the whole web app mounted in an element of its own
// page, and the few places it may add to. Nothing here imports the app, so this file's declarations
// are the package's types as they stand.

import type { ComponentType, ReactNode } from "react";

/** Where a slot's component is drawn, so it can fit the room it has. */
export type ShellPlacement =
  /** The open sidebar, or a phone's drawer: a full row. */
  | "sidebar"
  /** The compact sidebar: a 32 px tile, an icon and no words. */
  | "rail"
  /** The title bar, while no sidebar shows: one short button. */
  | "titlebar"
  /**
   * A phone's menu in the `roomy` look: the header as a large name at the menu's head, and the
   * account as a round avatar alone (its 44 px button is Gram's, which opens the account sheet).
   */
  | "drawer";

/** What every component the embedding app supplies is given. */
export interface ShellSlotProps {
  readonly placement: ShellPlacement;
}

/** An icon for a destination: any component that draws at the size its `className` sets. */
export type ShellIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

/** A page of the embedding app's, shown in the conversation's place with Gram's shell around it. */
export interface ShellRoute {
  /**
   * The page's path under the app, in the router's own form: `/govern/policies`, or
   * `/agents/$agentId` for a parameter. A path Gram has itself (`/settings`, `/t/…`) is refused.
   */
  readonly path: string;
  /**
   * The page's name. While the page is open the title bar says it where it otherwise names the
   * workspace and its views, and a phone's header says it as where you are.
   */
  readonly title?: string;
  readonly component: ComponentType<ShellPageProps>;
}

/** The page at the app's root (`/`), in place of Gram's own home and its first-run welcome. */
export interface ShellHome {
  /** Its name, said in the title bar and a phone's header as an added page's is. */
  readonly title?: string;
  readonly component: ComponentType<ShellPageProps>;
}

export interface ShellPageProps {
  /** The path's parameters, by name. */
  readonly params: Readonly<Record<string, string>>;
}

/** One destination in a navigation group. */
export interface ShellNavigationItem {
  /** Stable among the group's items. */
  readonly id: string;
  readonly label: string;
  /** A path under the app: one of `routes`, or one of Gram's own. */
  readonly to: string;
  readonly icon?: ShellIcon;
  /**
   * A number at the row's end, such as how many runs wait for review; on the compact sidebar's
   * tile, a dot. Left out or 0, nothing is drawn. Change it through `GramHandle.update`.
   */
  readonly count?: number;
}

/**
 * Where a group is listed in the sidebar: `main` at the top of its list, under Needs you and
 * search and above the workspaces and threads, as the places you mostly work in; `foot` below
 * the threads and above History, with the places you go to now and then.
 */
export type ShellNavigationPlacement = "main" | "foot";

/** A set of destinations, listed in the sidebar, the phone's drawer, the compact sidebar and the palette. */
export interface ShellNavigationGroup {
  /** Stable among the groups. */
  readonly id: string;
  /**
   * The group's heading: "Govern". Left out, its rows stand under no heading, and the palette and
   * the compact sidebar's tiles name them alone.
   */
  readonly label?: string;
  /** Defaults to `foot`. Groups keep their order within each placement. */
  readonly placement?: ShellNavigationPlacement;
  readonly items: readonly ShellNavigationItem[];
}

/**
 * What needs someone, as the embedding app counts it, in place of Gram's own Needs you count: the
 * sidebar's pill, the compact strip's tile and the title bar's Inbox say it.
 */
export interface ShellAttention {
  /** How many things need someone. At 0 the pill hides and the tile and Inbox show no dot. */
  readonly count: number;
  /** The pill's words, short: "3 need you" when left out. */
  readonly label?: string;
  /** Where a click goes: a path under the app. */
  readonly to?: string;
  /** Called on a click instead, when there is no `to`. With neither, Gram's Inbox opens. */
  readonly onOpen?: () => void;
}

/**
 * How the open sidebar is drawn.
 *
 * - `standard`: Gram's own: edge to edge, compact rows, the current row filled, Hide and Compact
 *   at its head and History and Settings at its foot.
 * - `roomy`: Gram's surface, edge to edge, with group headings in small capitals with air
 *   above them; taller rows with larger icons and stronger labels; the current row marked by a
 *   solid tile behind its icon and a bold label; search's shortcut as keycaps; and at the foot,
 *   History, Settings, the account and Collapse as labelled rows in place of the head's toggles.
 *
 * The compact strip keeps its own shape in either. A phone's drawer keeps Gram's in `standard`; in
 * `roomy` it is a plain menu: the header large at its head (placement `drawer`) beside a round
 * search, the switcher (placement `drawer`) under it, the `main` groups as large rows, and at its
 * foot the account (placement `drawer`, a round avatar opening a sheet with the `foot` groups,
 * History, Settings and the theme) and one New pill. The phone's header is then round buttons
 * either side of the page's name, with the menu's button dotted while a destination counts above 0.
 */
export type ShellSidebarLook = "standard" | "roomy";

/** The open sidebar's look and the two places in it the embedding app may fill. */
export interface ShellSidebar {
  /** Defaults to `standard`. */
  readonly look?: ShellSidebarLook;
  /**
   * The sidebar's head: a brand mark and name, say. It takes the head's room, with Gram's New
   * beside it; in the `standard` look it is a row of its own under the head's toggles.
   */
  readonly header?: ComponentType<ShellSlotProps>;
  /**
   * The person signed in: an avatar, a name and one line, drawn at the sidebar's foot (above
   * Collapse in the `roomy` look). A phone's drawer has it at its foot too.
   */
  readonly account?: ComponentType<ShellSlotProps>;
}

/**
 * Where the right panel (Diff, PR, Files, Terminal and its other tabs) and its title-bar toggle are
 * offered.
 *
 * - `shown`: on every page, as Gram on its own.
 * - `code`: only on a thread that works in a git repository, a worktree or a checkout. On any
 *   other page (a thread with no repository, `/threads`, the home page, the embedding app's own
 *   pages) neither the panel nor its toggle shows, and its key and palette commands are left out.
 */
export type ShellPanel = "shown" | "code";

/**
 * Gram's page of every thread (`/threads`), as the embedding app words it: an app whose threads
 * are conversations with its agents may call the page "Chat" and its button "New chat".
 */
export interface ShellThreadsPage {
  /**
   * The page's name: its heading, the title bar, a phone's header and the palette's command.
   * "Threads" when left out.
   */
  readonly title?: string;
  /**
   * The words on the page's button. Given, the button starts a chat (Gram's New form on Chat);
   * left out it is Gram's "New task", which opens the form on the choice used last.
   */
  readonly newLabel?: string;
}

/**
 * New, in the sidebar's head and a phone menu's foot, as one plain button of the embedding app's
 * in place of Gram's menu of Task, Team and Chat: for an app where what a person mostly starts is
 * something of its own. Gram's New form stays reachable from the threads page, the palette and its
 * shortcuts.
 */
export interface ShellNewEntry {
  /** The button's words and its name for a screen reader: "New agent". */
  readonly label: string;
  /** Where it goes: a path under the app, one of `routes` or one of Gram's own. */
  readonly to: string;
}

/** What a tool call's card of the embedding app's is given. */
export interface ShellToolCardProps {
  /** The tool's name as the agent called it, such as `mcp__acme__create_order`. */
  readonly name: string;
  /** What the agent passed, as it parsed. */
  readonly input: unknown;
  /** What the tool answered. A tool that answers JSON as text is given the parsed value. */
  readonly output: unknown;
}

/**
 * A card of the embedding app's under a tool call's row in a thread, once the call has answered:
 * for a tool of the app's own whose answer is one of its things (an order, a ticket, a document),
 * shown as that thing with its own links and buttons. Gram's row stays above it, so what was
 * called and with what can still be read. A card that has nothing to show returns null.
 */
export interface ShellToolCard {
  /**
   * The tools it is for: a name, or a pattern where `*` stands for any run of characters
   * (`mcp__*__create_order`). The first card in the list that matches is used.
   */
  readonly tool: string;
  readonly component: ComponentType<ShellToolCardProps>;
}

/** What the embedding app adds to Gram's shell. Everything is optional. */
export interface ShellContributions {
  /** Pages beside Gram's own. Read once, when the app mounts. */
  readonly routes?: readonly ShellRoute[];
  /**
   * The page at `/`, in place of Gram's home: what Gram shows with nothing open, and its first-run
   * welcome ("Open a repository"), which is then never shown. Read once, when the app mounts.
   */
  readonly home?: ShellHome;
  /** Groups of destinations. Replaceable later through `GramHandle.update`. */
  readonly navigation?: readonly ShellNavigationGroup[];
  /**
   * A switcher of the embedding app's own (organisations, workspaces on other servers), drawn at
   * the head of the sidebar and, while that is hidden, at the start of the title bar. Replaceable
   * later through `GramHandle.update`.
   */
  readonly workspaceSwitcher?: ComponentType<ShellSlotProps>;
  /**
   * Whether the sidebar lists Gram's workspaces and threads (the open sidebar's and the drawer's
   * lists, the compact sidebar's tiles). `hidden` leaves the sidebar to Needs you, search and the
   * navigation groups; a thread still opens from those, from the palette and from its address.
   * Defaults to `shown`. Replaceable later through `GramHandle.update`.
   */
  readonly threads?: "shown" | "hidden";
  /** Where the right panel is offered. Defaults to `shown`. Replaceable through `GramHandle.update`. */
  readonly panel?: ShellPanel;
  /** What needs someone, counted by the embedding app. Replaceable through `GramHandle.update`. */
  readonly attention?: ShellAttention;
  /** How the page of every thread is worded. Replaceable through `GramHandle.update`. */
  readonly threadsPage?: ShellThreadsPage;
  /** What New starts, in place of Gram's menu. Replaceable through `GramHandle.update`. */
  readonly newEntry?: ShellNewEntry;
  /** The open sidebar's look, its head and its account. Replaceable through `GramHandle.update`. */
  readonly sidebar?: ShellSidebar;
  /** Cards of the embedding app's under its own tools' calls. Read once, when the app mounts. */
  readonly toolCards?: readonly ShellToolCard[];
}

/** The server one mount talks to. */
export interface GramServer {
  /**
   * Where the server answers, as a URL or a path on the page's origin, ending in `/`:
   * `/cells/acme/` puts the socket at `/cells/acme/ws` and every HTTP call beside it. Defaults to
   * `/`, the page's own origin, as the app has it on its own.
   */
  readonly base?: string;
}

export interface MountOptions {
  /** The element the app fills. It takes the whole window: one mount to a page. */
  readonly element: HTMLElement;
  /**
   * The server to talk to, or `"mock"` for the in-memory one the app's own development uses, with
   * no server at all: for building and testing the pages around it.
   */
  readonly server?: GramServer | "mock";
  /**
   * The path the app's own routes sit under, when the page isn't served from the origin's root:
   * `/w/acme` puts a thread at `/w/acme/t/<id>`.
   */
  readonly basePath?: string;
  readonly shell?: ShellContributions;
}

export interface GramHandle {
  /**
   * Whether the server has its hosted features on. While it is off the app mounts as it is on its
   * own and `shell` is left out whole: no page, group or switcher is added.
   */
  readonly shell: "on" | "off";
  /**
   * Replaces what `next` names of the navigation groups, the switcher, the thread list, the
   * right panel's pages, the attention count and the sidebar's look, and leaves what it doesn't name as it is: `update({ navigation })` changes counts and keeps the
   * switcher. A key given as `undefined` takes that part away. Routes stay as mounted.
   */
  update(
    next: Pick<
      ShellContributions,
      | "navigation"
      | "workspaceSwitcher"
      | "threads"
      | "panel"
      | "attention"
      | "threadsPage"
      | "newEntry"
      | "sidebar"
    >,
  ): void;
  /** Moves the window to a path under the app. */
  navigate(to: string): Promise<void>;
  /** Takes the app off the page. A page mounts it once: after this, load the page again. */
  unmount(): void;
}

/** Mounts Gram's web app, whole, in `options.element`. */
export type MountGram = (options: MountOptions) => Promise<GramHandle>;

/** A link to a path under the app that moves the window without loading the page again. */
export type ShellLinkComponent = ComponentType<{
  to: string;
  className?: string;
  children?: ReactNode;
}>;

/**
 * One thread inside a page of the embedding app's: its transcript, cards and composer, without
 * the thread's own header, filling the element it is put in. The same thread as on its own page
 * (`/t/<id>`), so what is sent here is sent there.
 */
export type ShellThreadComponent = ComponentType<{ threadId: string }>;

/** For a page or a switcher of the embedding app's: where the window is, and a way to move it. */
export type UseShellLocation = () => {
  /** The path under the app, without `basePath`. */
  readonly pathname: string;
  navigate(to: string): Promise<void>;
};
