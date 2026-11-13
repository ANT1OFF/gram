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
  /**
   * Other paths at which the row is the current one, each with the pages under it: a row to the
   * page of every thread may name `/t` and `/new`, so it stays marked in a thread and on New task.
   * A row whose own `to` matches wins over one that only lists the path here.
   */
  readonly alsoAt?: readonly string[];
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
  /**
   * The heading opens and closes the group's rows, in the open sidebar and a phone's menu. Only a
   * group with a `label` can be; the compact sidebar and the palette list its rows either way.
   * Closed, the group still shows the row the window is at, and its heading says the sum of its
   * hidden rows' counts. Off by default.
   */
  readonly collapsible?: boolean;
  /**
   * Whether a collapsible group starts closed. Once the person opens or closes it, their choice is
   * kept on this device, by the group's `id`, and this applies only to a group they have not
   * touched.
   */
  readonly collapsed?: boolean;
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
  /**
   * Whether resting the pointer on the compact strip opens the sidebar over the page beside it.
   * Defaults to true. Off, only the strip's Expand sidebar tile (or the keyboard) opens it, and it
   * then stays open as the person left it.
   */
  readonly peek?: boolean;
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
/**
 * Machines the server's deployment starts on demand, one person's each (`GRAM_HOST_PROVIDER_URL`):
 * what the app calls one where a person starts theirs.
 */
export interface ShellMachines {
  /** The word for one, lower case: "machine" when left out, such as "sandbox". */
  readonly noun?: string;
  /**
   * Short lines the start card lists about one, in the deployment's own terms: how long it waits
   * before it stops, how long its files are kept, what it costs. None when left out.
   */
  readonly facts?: readonly string[];
}

/**
 * The prompt box's model list as the embedding app narrows it: for a deployment whose own rules,
 * or a person's own accounts, leave only some of what an agent lists usable. It only narrows what
 * is offered; the deployment still has to refuse a model it does not allow.
 */
/** The agents whose models the prompt box lists. */
export type ShellAgent = "claude" | "codex";

/** One model the prompt box lists, as the embedding app's `ShellModels.offered` is given it. */
export interface ShellModelChoice {
  readonly agent: ShellAgent;
  /** The id the agent lists it by: an alias such as `opus`, or a pinned id. */
  readonly id: string;
  /**
   * The pinned model id it runs, by Gram's model catalogue (`resolveModel`): the row's own
   * `resolvedId`, the id a Claude alias's name says it runs, or a pinned row's id. Absent when the
   * catalogue cannot tell, such as the CLI's `default` with no version in its name: an app that
   * allows only some models should not offer one it cannot place.
   */
  readonly runs?: string;
  /** The gateway profile it goes through; absent for the agent's own account. */
  readonly profile?: string;
}

/**
 * The prompt box's model list as the embedding app narrows it: for a deployment whose own rules,
 * or a person's own accounts, leave only some of what an agent lists usable. It narrows what a new
 * draft offers and picks; a thread's own composer and a saved setting still show the model they
 * have. It only narrows: the deployment still has to refuse a model it does not allow.
 */
export interface ShellModels {
  /**
   * Whether a listed model is offered. Every listed model is when left out, and when it throws. A
   * draft whose model is not offered moves to one that is.
   */
  readonly offered?: (model: ShellModelChoice) => boolean;
  /**
   * What the Model row says when the agent has no model to pick: none is offered, or the list could
   * not be read. Other agents' models stay pickable beside it. Gram's own words, and only them,
   * when left out.
   */
  readonly none?: {
    /** One short sentence: "Connect a Claude account to pick a model." */
    readonly text: string;
    /** Where it is put right: a path under the app, one of `routes` or one of Gram's own. */
    readonly action?: { readonly label: string; readonly to: string };
  };
}

/** A place of the embedding app's own, and the threads that open in it. */
export interface ShellThreadPlace {
  /** What the place is called: "Chat". */
  readonly name: string;
  /** Where a thread opens in it, under the app, with `$threadId` for the thread's id. */
  readonly path: string;
  readonly ids: readonly string[];
}

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
  /**
   * The words under each row for what kind of thread it is, for an app whose people do not speak
   * of orchestrators and workers. Each is Gram's own word when left out.
   */
  readonly kinds?: ShellThreadKinds;
  /**
   * Threads the page leaves out, by id: ones the embedding app lists in a place of its own (its
   * own assistant's conversations, say), so they are not listed twice or under the wrong name.
   * Each still opens at its address. Every thread is listed when left out.
   */
  readonly elsewhere?: readonly string[];
  /**
   * Places of the embedding app's own that some threads open in: "Chat" at `/chat/$threadId`, for
   * its assistant's conversations. A message such a thread sent to another says the place beside
   * its sender, and opens the sender there in place of its page here.
   */
  readonly places?: readonly ShellThreadPlace[];
  /**
   * The New form's Who does it, narrowed and worded by an app whose people choose between fewer
   * ways to start. Gram's three choices in its own words when left out.
   */
  readonly newForm?: ShellNewForm;
  /**
   * How the title bar starts on a thread, a Board and the New form. `path` draws a path from this
   * page (its `title`, a link back to it), then the workspace, still its switcher, then the
   * thread; a workspace's orchestrator and Board are two buttons beside it, and the New form names
   * itself. For an app whose own pages say where they are that way, and that has a Chat of its
   * own. `views`, the default, is Gram's workspace switcher and Chat · Board.
   */
  readonly bar?: "views" | "path";
}

/** One of the New form's Who does it choices, in the embedding app's words. */
export interface ShellNewChoice {
  /** The choice's name: "Orchestrator". */
  readonly label: string;
  /** What comes of it, in one sentence under the name. Gram's own sentence when left out. */
  readonly line?: string;
  /** The words on the form's button with this choice picked: "Send to the orchestrator". */
  readonly start?: string;
}

/** The New form's Who does it, as an embedding app narrows and words it. */
export interface ShellNewForm {
  /**
   * `hidden` leaves out the choice of one worker straight away (Gram's "Task"), so the form asks
   * only between an orchestrator and one agent. A shortcut or link that would open the form on
   * that choice opens it on the orchestrator's. Shown when left out.
   */
  readonly task?: "shown" | "hidden";
  /** The orchestrator's choice (Gram's "Team"). */
  readonly team?: ShellNewChoice;
  /** The choice of one agent in no workspace (Gram's "Chat"); its name wins over `kinds.solo` there. */
  readonly solo?: ShellNewChoice;
}

/** The page of every thread's words for a thread's kind. */
export interface ShellThreadKinds {
  /**
   * A thread in no workspace: "Solo" when left out. Given, it also names that choice in the New
   * form (Gram's "Chat") and a solo thread's header, so an app with a Chat of its own has one word
   * for it.
   */
  readonly solo?: string;
  /** A workspace's orchestrator: "Orchestrator" when left out. */
  readonly orchestrator?: string;
  /** A thread an orchestrator started, alone or before "of <its orchestrator>": "Worker". */
  readonly worker?: string;
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

/** What the browser tab's title is made from. */
export interface ShellDocumentPage {
  /**
   * The name of the page the window is on, as the title bar says it: an added page's, the home's,
   * or the page of every thread's. Undefined on Gram's other pages, a thread's among them.
   */
  readonly name: string | undefined;
  /** How many things need the person, by Gram's own count of its threads: 0 when nothing does. */
  readonly needsYou: number;
}

/** The browser tab, as the embedding app names it. */
export interface ShellDocument {
  /**
   * The tab's whole title, written again whenever the page or the count changes: "(1) Gram" when
   * left out, as on Gram's own.
   */
  readonly title?: (page: ShellDocumentPage) => string;
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
  /** How machines started on demand are worded. Read once, when the app mounts. */
  readonly machines?: ShellMachines;
  /** The prompt box's model list, narrowed. Replaceable through `GramHandle.update`. */
  readonly models?: ShellModels;
  /** The open sidebar's look, its head and its account. Replaceable through `GramHandle.update`. */
  readonly sidebar?: ShellSidebar;
  /** Cards of the embedding app's under its own tools' calls. Read once, when the app mounts. */
  readonly toolCards?: readonly ShellToolCard[];
  /** The browser tab's title. Replaceable through `GramHandle.update`. */
  readonly document?: ShellDocument;
}

/** The server one mount talks to. */
export interface GramServer {
  /**
   * Where the server answers, as a URL or a path on the page's origin, ending in `/`:
   * `/cells/acme/` puts the socket at `/cells/acme/ws` and every HTTP call beside it. Defaults to
   * `/`, the page's own origin, as the app has it on its own.
   */
  readonly base?: string;
  /**
   * Sign-in owned by the app in front. On a reconnect probe's 401, renew its cookie and return
   * true to retry; return false only for an ended session, or throw for a temporary outage.
   * `expired` takes over the page with the app's own sign-in. No credentials enter Gram.
   */
  readonly session?: {
    readonly refresh: () => Promise<boolean>;
    readonly expired: () => void;
  };
}

/**
 * A thread the in-memory server starts with, beside its own: a conversation of the embedding
 * app's, for previews and tests of the pages around the app, at an id the app chooses.
 */
export interface MockThread {
  readonly id: string;
  readonly title: string;
  /** Its conversation so far, as plain text, oldest first. */
  readonly messages?: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
  /**
   * Makes it a worker of the named workspace's orchestrator, started with `brief` for `feature`,
   * when the mock has that workspace. `askedBy` is the id of another of these threads whose message
   * the orchestrator was answering, which the worker and its row then name.
   */
  readonly worker?: {
    readonly workspace: string;
    readonly feature: string;
    readonly brief: string;
    readonly askedBy?: string;
  };
}

/** A palette's ten seed colours, as Gram's own palettes define them (hex). */
export interface ThemeSeeds {
  readonly bg: string;
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly accent2: string;
  readonly red: string;
  readonly green: string;
  readonly yellow: string;
  readonly cyan: string;
}

/** The app's look, given to `mountGram` by the page that mounts it (`MountOptions.theme`). */
export interface HostTheme {
  /** The name the palette goes by in Settings, in place of "Neutral". */
  readonly name?: string;
  /** Seeds for each mode. Either may be left out; with both, they pair. */
  readonly palettes?: { readonly dark?: ThemeSeeds; readonly light?: ThemeSeeds };
  /**
   * Colours set over what the seeds derive, per mode, by the theme's names without `--`
   * (`accent`, `on-accent`, `accent-text`, `status-needs`, …): an accent apart from the links, say.
   */
  readonly colors?: {
    readonly dark?: Readonly<Record<string, string>>;
    readonly light?: Readonly<Record<string, string>>;
  };
  /** Font stacks for text, code and display. */
  readonly fonts?: { readonly ui?: string; readonly mono?: string; readonly display?: string };
  /** Corner radii in pixels, by the theme's step names. */
  readonly radii?: Partial<Record<"2xs" | "xs" | "sm" | "md" | "lg" | "xl", number>>;
  /** `"none"`: raised cards and menus are drawn by their edge, with no shadow. */
  readonly shadows?: "none";
  /** Colours for charts in order, per mode, as `--chart-1` onwards. */
  readonly chart?: { readonly dark?: readonly string[]; readonly light?: readonly string[] };
}

export interface MountOptions {
  /** The element the app fills. It takes the whole window: one mount to a page. */
  readonly element: HTMLElement;
  /**
   * The server to talk to, or `"mock"` for the in-memory one the app's own development uses, with
   * no server at all: for building and testing the pages around it.
   */
  readonly server?: GramServer | "mock";
  /** With `server: "mock"`: threads it starts with, beside its own. Ignored with a real server. */
  readonly mockThreads?: readonly MockThread[];
  /**
   * The path the app's own routes sit under, when the page isn't served from the origin's root:
   * `/w/acme` puts a thread at `/w/acme/t/<id>`.
   */
  readonly basePath?: string;
  readonly shell?: ShellContributions;
  /**
   * The app's look in this page: a palette for each mode that takes the place of Gram's default
   * one, colours set over it, fonts, radii, shadows and chart colours (`--chart-1` onwards). A
   * person's own palette and fonts, picked in Settings, still win. Left out, the look is Gram's.
   */
  readonly theme?: HostTheme;
}

export interface GramHandle {
  /**
   * Whether the server has its hosted features on. While it is off the app mounts as it is on its
   * own and `shell` is left out whole: no page, group or switcher is added.
   */
  readonly shell: "on" | "off";
  /**
   * Replaces what `next` names of the navigation groups, the switcher, the thread list, the
   * right panel's pages, the attention count, the sidebar's look, the tab's title and the model list, and leaves
   * what it doesn't name as it is: `update({ navigation })` changes counts and keeps the
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
      | "document"
      | "models"
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
export type ShellThreadComponent = ComponentType<{
  threadId: string;
  /**
   * The words in its empty prompt box, for a page that shows more than one thread and has to say
   * which one a message goes to: "Message the release agent…". "Steer this thread…" when left out.
   */
  placeholder?: string;
}>;

/** The working panels of a thread that `ShellThreadPanel` shows. */
export type ShellThreadPanelTab = "diff" | "pr" | "files" | "terminal";

/**
 * One thread's working panels inside a page of the embedding app's: its diff, its pull request,
 * its files and its terminal, under a row of tabs, filling the element it is put in. They are the
 * right panel's own, for the same thread as on its own page (`/t/<id>`), without the panel's other
 * tabs. `tab` picks the one shown and `onTabChange` hears a change; without `tab` it keeps its own,
 * starting on the diff. For a sheet or a pane of yours that shows what a thread changed.
 */
export type ShellThreadPanelComponent = ComponentType<{
  threadId: string;
  tab?: ShellThreadPanelTab;
  onTabChange?: (tab: ShellThreadPanelTab) => void;
}>;

/** For a page or a switcher of the embedding app's: where the window is, and a way to move it. */
export type UseShellLocation = () => {
  /** The path under the app, without `basePath`. */
  readonly pathname: string;
  navigate(to: string): Promise<void>;
};
