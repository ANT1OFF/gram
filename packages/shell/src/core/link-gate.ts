import { domainToUnicode } from "node:url";

import {
  ALWAYS_ASKS_BECAUSE,
  linkHost,
  trustedHostsOf,
  type LinkHost,
} from "@gram/contracts/link-trust";

/**
 * The only door from a renderer to the OS browser. Every link a window asks to open, by
 * `window.open`, by navigating away or over the bridge, comes here: a trusted host opens, anything
 * else is asked about in a native dialog the renderer can't draw, answer or skip. Hosts are trusted
 * only from that dialog's checkbox; the renderer can list and remove them, never add one.
 */

/** What the user picked in the link dialog, and whether they ticked "Always open…". */
export interface LinkAnswer {
  readonly action: "open" | "copy" | "cancel";
  readonly trust: boolean;
}

/** The native message box's text for a link, laid out the way `dialog.showMessageBox` takes it. */
export interface LinkPrompt {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  /** Absent when the link can't be trusted by its host, so no "always" is offered. */
  readonly checkboxLabel?: string;
}

export interface LinkGateDeps<W> {
  /** The stored hosts, as saved; cleaned before use. */
  load(): unknown;
  save(hosts: readonly string[]): void;
  ask(prompt: LinkPrompt, window: W | undefined): Promise<LinkAnswer>;
  open(url: string): Promise<void>;
  copy(text: string): void;
  /** Tells every window the list changed, so an open Settings page follows. */
  changed(hosts: readonly string[]): void;
}

export interface LinkGate<W> {
  hosts(): readonly string[];
  /** Stops trusting `host`; a host that isn't trusted is a no-op. */
  remove(host: string): void;
  /** Opens `url` if its host is trusted or the user says so; resolves whether it was opened. */
  open(url: string, window?: W): Promise<boolean>;
}

/** A URL longer than this is cut in the dialog; the browser still gets all of it. */
const SHOWN_URL_CHARS = 600;

/** The dialog's text for `url`: the host it really goes to first, then the whole link. */
export function linkPrompt(url: string, link: LinkHost): LinkPrompt {
  const shown = url.length > SHOWN_URL_CHARS ? `${url.slice(0, SHOWN_URL_CHARS)}…` : url;
  // The renderer hands over links already parsed, so an IDN arrives as punycode alone.
  const unicode = domainToUnicode(link.host);
  const spelled = link.written ?? (unicode !== "" && unicode !== link.host ? unicode : undefined);
  const notes = [
    ...(spelled === undefined
      ? []
      : [`The link spells the site “${spelled}”; the browser goes to ${link.host}.`]),
    ...(link.untrustable === undefined ? [] : [ALWAYS_ASKS_BECAUSE[link.untrustable]]),
  ];
  return {
    title: "Open external link?",
    message: `Open a link to ${link.host}?`,
    detail: [shown, ...notes].join("\n\n"),
    ...(link.untrustable === undefined
      ? { checkboxLabel: `Always open links to ${link.host} without asking` }
      : {}),
  };
}

export function createLinkGate<W>(deps: LinkGateDeps<W>): LinkGate<W> {
  let hosts = trustedHostsOf(deps.load());
  // One question at a time, so a burst of links can't stack dialogs, and a host trusted in one
  // answer opens the links queued behind it.
  let queue: Promise<unknown> = Promise.resolve();

  const setHosts = (next: string[]) => {
    hosts = next;
    deps.save(hosts);
    deps.changed(hosts);
  };

  const decide = async (url: string, window: W | undefined): Promise<boolean> => {
    const link = linkHost(url);
    if (link === null) return false;
    if (link.untrustable === undefined && hosts.includes(link.host)) {
      await deps.open(url);
      return true;
    }
    const answer = await deps.ask(linkPrompt(url, link), window);
    if (answer.action === "copy") deps.copy(url);
    if (answer.action !== "open") return false;
    if (answer.trust && link.untrustable === undefined && !hosts.includes(link.host)) {
      setHosts(trustedHostsOf([...hosts, link.host]));
    }
    await deps.open(url);
    return true;
  };

  const enqueue = (url: string, window: W | undefined) => {
    const next = queue.then(() => decide(url, window));
    queue = next.catch(() => {});
    return next;
  };

  return {
    hosts: () => hosts,
    remove(host) {
      if (hosts.includes(host)) setHosts(hosts.filter((h) => h !== host));
    },
    open: (url, window) => enqueue(url, window),
  };
}
