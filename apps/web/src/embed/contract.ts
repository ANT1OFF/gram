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
  | "titlebar";

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

/** What the embedding app adds to Gram's shell. Everything is optional. */
export interface ShellContributions {
  /** Pages beside Gram's own. Read once, when the app mounts. */
  readonly routes?: readonly ShellRoute[];
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
   * Replaces what `next` names of the navigation groups, the switcher and the thread list, and
   * leaves what it doesn't name as it is: `update({ navigation })` changes counts and keeps the
   * switcher. A key given as `undefined` takes that part away. Routes stay as mounted.
   */
  update(next: Pick<ShellContributions, "navigation" | "workspaceSwitcher" | "threads">): void;
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

/** For a page or a switcher of the embedding app's: where the window is, and a way to move it. */
export type UseShellLocation = () => {
  /** The path under the app, without `basePath`. */
  readonly pathname: string;
  navigate(to: string): Promise<void>;
};
