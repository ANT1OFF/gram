// What an agent may do to its thread's page in the Preview pane (`modules/agent-browser`), decided
// here in the shell whatever the server asked: the server asks, the shell decides.
// Where it may navigate (contracts' `browseTarget`, the "Agent may browse" list and the hosts the
// user allowed once), which requests a page it opened may make, and when acting waits.

import {
  BROWSER_MOBILE_MAX_WIDTH,
  BROWSER_VIEWPORT_MAX,
  BROWSER_VIEWPORT_MIN,
  BROWSER_VIEWPORTS,
  browseHostsOf,
  browseTarget,
  isPaneKey,
  isPreviewFilesUrl,
  paneKeyRefusal,
  PANE_ACTION_SUMMARY_MAX,
  PANE_EVALUATE_MAX,
  visibleText,
  PANE_KEY_MODIFIERS,
  PANE_KEY_REPEAT_MAX,
  PANE_READ_MAX_CHARS,
  PANE_READ_MIN_CHARS,
  PANE_SCROLL_MAX,
  PANE_SNAPSHOT_MAX_DEPTH,
  PANE_WAIT_MAX_MS,
  originOf,
  refusedHost,
  type BrowseRefusal,
  type PaneAccess,
  type PaneCommand,
  type PaneKeyModifier,
  type PaneLimits,
  type PanePoint,
  type PaneRequest,
} from "@gram/contracts/link-trust";

/** What the shell knows about one thread's page when it decides. */
export interface BrowseContext {
  /** Settings → Agent may browse. */
  readonly approved: ReadonlySet<string>;
  /** The hosts the user allowed once for this thread's page, until it closes. */
  readonly once: ReadonlySet<string>;
  /** Gram's own loopback origins (`PaneLimits.appOrigins`), refused like a deny-listed host. */
  readonly appOrigins?: ReadonlySet<string> | undefined;
}

/** Where a main-frame navigation of an agent's page goes. */
export type AgentNavigation =
  | { readonly kind: "allow"; readonly url: string; readonly access: PaneAccess }
  /** A public host nobody approved yet: the server raises a card for it. */
  | { readonly kind: "ask"; readonly url: string; readonly host: string }
  | { readonly kind: "refuse"; readonly reason: BrowseRefusal; readonly host?: string | undefined };

/** Where `url` goes when an agent's page navigates to it: asked for, clicked, or redirected. */
export function agentNavigation(url: string, context: BrowseContext): AgentNavigation {
  const target = browseTarget(url);
  if (target.kind === "loopback") {
    const origin = originOf(target.url);
    // The file preview listener by its path as well, so it stays refused on a command whose
    // limits name no app origins.
    if (
      isPreviewFilesUrl(target.url) ||
      (origin !== undefined && context.appOrigins?.has(origin) === true)
    ) {
      return { kind: "refuse", reason: "app" };
    }
    return { kind: "allow", url: target.url, access: "loopback" };
  }
  if (target.kind === "refused")
    return { kind: "refuse", reason: target.reason, host: target.host };
  if (context.approved.has(target.host)) {
    return { kind: "allow", url: target.url, access: "approved" };
  }
  if (context.once.has(target.host)) return { kind: "allow", url: target.url, access: "once" };
  return { kind: "ask", url: target.url, host: target.host };
}

const WEB = new Set(["http:", "https:", "ws:", "wss:"]);
/** Schemes that never reach the network: the page's own data and blobs. */
const LOCAL = new Set(["data:", "blob:"]);

/**
 * Whether a page on a public host may make one request, a subresource or a socket: to another
 * public host, yes, since pages load from CDNs; never to loopback, a private network, EXAMPLE or a
 * sign-in page, so a page can't use the pane to reach what the laptop reaches. A name that
 * resolves to a private address is caught by `isPrivateAddress` once it is resolved.
 */
export function publicPageRequest(url: string): "allow" | "block" {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "block";
  }
  if (LOCAL.has(parsed.protocol)) return "allow";
  if (!WEB.has(parsed.protocol)) return "block";
  if (parsed.username !== "" || parsed.password !== "") return "block";
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return "block";
  return refusedHost(host) === undefined ? "allow" : "block";
}

/** Why an agent may not act (click, type, fill in) on the page it is on, or `undefined`. */
export function actRefusal(access: PaneAccess, limits: PaneLimits): "loopbackOnly" | undefined {
  return limits.actOnLoopbackOnly && access !== "loopback" ? "loopbackOnly" : undefined;
}

/** Whether an action that submits a form waits for the user's card: off loopback, every time. */
export const submitNeedsConfirmation = (access: PaneAccess, confirmed: boolean): boolean =>
  access !== "loopback" && !confirmed;

/** Methods that only read, which a public page may send without the user's confirmation. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a request writes: any method but a read, which off loopback waits for a card. */
export const isWrite = (method: string): boolean => !READS.has(method.toUpperCase());

/** Whether `origin` (a request's initiator, or the hop before a redirect) is off loopback. */
export const offLoopback = (origin: string | undefined): boolean =>
  // An opaque origin (a sandboxed frame, a data: page) could have come from anywhere.
  origin !== undefined && (origin === "null" || browseTarget(origin).kind !== "loopback");

/**
 * How long after the shell sends the page an agent's input it still counts as the agent's: the
 * view's input events for it arrive after the command returns, and must not read as the user
 * taking over.
 */
export const AGENT_INPUT_GRACE_MS = 500;

/**
 * Whether an input event in the pane is the user's, taking over from the agent: any that doesn't
 * arrive while, or just after, the shell is sending the agent's own.
 */
export const isUserInput = (now: number, agentInputUntil: number): boolean => now > agentInputUntil;

/** Settings → Agent may browse, as the shell keeps it. */
export interface BrowseHostList {
  hosts(): readonly string[];
  has(host: string): boolean;
  /** Adds `host`, for an approval card's "Always for this host" only; false for one it can't hold. */
  add(host: string): boolean;
  /** Stops approving `host`; one that isn't listed is a no-op. */
  remove(host: string): void;
}

export interface BrowseHostDeps {
  /** The stored list, as saved; cleaned before use. */
  load(): unknown;
  save(hosts: readonly string[]): void;
  /** Tells every window the list changed, so an open Settings page follows. */
  changed(hosts: readonly string[]): void;
}

/** The list, read once from `deps.load` and saved on every change. */
export function createBrowseHostList(deps: BrowseHostDeps): BrowseHostList {
  let hosts = browseHostsOf(deps.load());
  const set = (next: string[]) => {
    hosts = next;
    deps.save(hosts);
    deps.changed(hosts);
  };
  return {
    hosts: () => hosts,
    has: (host) => hosts.includes(host),
    add: (host) => {
      const next = browseHostsOf([...hosts, host]);
      if (!next.includes(host)) return false;
      if (next.length !== hosts.length) set(next);
      return true;
    },
    remove: (host) => {
      if (hosts.includes(host)) set(hosts.filter((h) => h !== host));
    },
  };
}

const MAX_TEXT = 100_000;
const MAX_URL = 8_192;

const str = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const ref = (value: unknown): value is string =>
  typeof value === "string" && /^ref_\d{1,7}$/.test(value);
const point = (value: unknown): value is readonly [number, number] =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100_000);
const flag = (value: unknown) => value === true;
/** A confirmation token, kept only in the shape the shell makes them. */
const tokenOf = (c: Record<string, unknown>): { confirmToken?: string } => {
  const token = c["confirmToken"];
  return typeof token === "string" && /^[\w-]{8,64}$/.test(token) ? { confirmToken: token } : {};
};

/** A whole number from `min` to `max`. */
const int = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
/** An optional field: absent, or valid. */
const optional = (value: unknown, valid: (value: unknown) => boolean) =>
  value === undefined || valid(value);
/** `{ [key]: value }` when `value` is present, else nothing, for a command's optional fields. */
const some = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
/** A ref or a coordinate, exactly one of them. */
const pointOf = (raw: unknown): PanePoint | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  if (p["ref"] !== undefined && p["coordinate"] !== undefined) return undefined;
  if (ref(p["ref"])) return { ref: p["ref"] };
  if (point(p["coordinate"])) return { coordinate: p["coordinate"] };
  return undefined;
};
/** An optional ref or coordinate, never both; `null` when malformed. */
const optionalPoint = (c: Record<string, unknown>): Partial<PanePoint> | null => {
  if (c["ref"] === undefined && c["coordinate"] === undefined) return {};
  return pointOf({ ref: c["ref"], coordinate: c["coordinate"] }) ?? null;
};
const modifiersOf = (raw: unknown): readonly PaneKeyModifier[] | null | undefined => {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > PANE_KEY_MODIFIERS.length) return null;
  const known = raw.every((m) => PANE_KEY_MODIFIERS.includes(m as PaneKeyModifier));
  return known && new Set(raw).size === raw.length ? (raw as PaneKeyModifier[]) : null;
};
const viewportSize = (value: unknown): value is { width: number; height: number } => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    int(v["width"], BROWSER_VIEWPORT_MIN, BROWSER_VIEWPORT_MAX) &&
    int(v["height"], BROWSER_VIEWPORT_MIN, BROWSER_VIEWPORT_MAX)
  );
};
/**
 * The command's `actionSummary`, made safe to show: `{}` when absent, `null` when malformed, which
 * refuses the command.
 */
const labelOf = (c: Record<string, unknown>): { actionSummary?: string } | null => {
  const raw = c["actionSummary"];
  if (raw === undefined) return {};
  if (typeof raw !== "string" || raw.length > PANE_ACTION_SUMMARY_MAX) return null;
  const summary = visibleText(raw)
    // Tag characters, variation selectors and blank-looking letters, which can hide text.
    .replace(/[\u{E0000}-\u{E007F}\u3164\u2800\u115F\u1160\uFFA0]|\p{Variation_Selector}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return summary === "" ? {} : { actionSummary: summary };
};
const PRESETS = ["pane", "phone", "tablet", "desktop"] as const;
const presetOf = (value: unknown) => PRESETS.find((preset) => preset === value);
const readChars = (value: unknown) => int(value, PANE_READ_MIN_CHARS, PANE_READ_MAX_CHARS);

const LABELLED = new Set([
  "click",
  "type",
  "pressKey",
  "formInput",
  "hover",
  "scroll",
  "drag",
  "scrollTo",
  "evaluate",
]);

/** A pane command as the server sent it, or `undefined` for anything malformed, which is refused. */
export function parsePaneCommand(raw: unknown): PaneCommand | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const c = raw as Record<string, unknown>;
  const command = parseUnlabelled(c);
  if (command === undefined || !LABELLED.has(command.op)) return command;
  const label = labelOf(c);
  return label === null ? undefined : ({ ...command, ...label } as PaneCommand);
}

function parseUnlabelled(c: Record<string, unknown>): PaneCommand | undefined {
  switch (c["op"]) {
    case "navigate":
      return str(c["url"], MAX_URL) ? { op: "navigate", url: c["url"] } : undefined;
    case "back":
    case "diagnostics":
      return { op: c["op"] };
    case "snapshot": {
      const filter = c["filter"];
      if (
        !optional(filter, (f) => f === "all" || f === "interactive") ||
        !optional(c["depth"], (d) => int(d, 1, PANE_SNAPSHOT_MAX_DEPTH)) ||
        !optional(c["ref"], ref) ||
        !optional(c["maxChars"], readChars)
      )
        return undefined;
      return {
        op: "snapshot",
        ...some("filter", filter as "all" | "interactive" | undefined),
        ...some("depth", c["depth"] as number | undefined),
        ...some("ref", c["ref"] as string | undefined),
        ...some("maxChars", c["maxChars"] as number | undefined),
      };
    }
    case "text":
      return optional(c["maxChars"], readChars)
        ? { op: "text", ...some("maxChars", c["maxChars"] as number | undefined) }
        : undefined;
    case "screenshot": {
      if (c["ref"] !== undefined && !ref(c["ref"])) return undefined;
      const scale = c["scale"];
      if (
        !optional(scale, (n) => typeof n === "number" && Number.isFinite(n) && n >= 0.1 && n <= 1)
      )
        return undefined;
      if (!optional(c["format"], (f) => f === "png")) return undefined;
      const scaled = {
        ...some("scale", scale as number | undefined),
        ...(c["format"] === "png" ? { format: "png" as const } : {}),
      };
      const region = c["region"];
      if (region !== undefined) {
        if (typeof region !== "object" || region === null || c["ref"] !== undefined)
          return undefined;
        const r = region as Record<string, unknown>;
        if (
          !["x", "y", "width", "height"].every(
            (key) =>
              typeof r[key] === "number" &&
              Number.isFinite(r[key]) &&
              (r[key] as number) >= 0 &&
              (r[key] as number) <= 10_000,
          )
        )
          return undefined;
        return {
          op: "screenshot",
          region: {
            x: r["x"] as number,
            y: r["y"] as number,
            width: r["width"] as number,
            height: r["height"] as number,
          },
          ...scaled,
        };
      }
      return { op: "screenshot", ...some("ref", c["ref"] as string | undefined), ...scaled };
    }
    case "viewport": {
      const preset = presetOf(c["preset"]);
      const { size, mobile, colorScheme } = c as {
        size?: unknown;
        mobile?: unknown;
        colorScheme?: unknown;
      };
      if (
        (c["preset"] !== undefined && preset === undefined) ||
        (size !== undefined && (preset !== undefined || !viewportSize(size))) ||
        !optional(mobile, (m) => typeof m === "boolean") ||
        !optional(colorScheme, (s) => s === "light" || s === "dark" || s === "system") ||
        (preset === undefined &&
          size === undefined &&
          mobile === undefined &&
          colorScheme === undefined)
      )
        return undefined;
      // Mobile emulation is a phone's: a width below 768, never the pane's own size.
      const width =
        preset === undefined || preset === "pane" ? size?.width : BROWSER_VIEWPORTS[preset].width;
      // Without a size here, the driver holds it to the size already emulated.
      if (
        mobile === true &&
        (preset === "pane" || (width !== undefined && width >= BROWSER_MOBILE_MAX_WIDTH))
      )
        return undefined;
      return {
        op: "viewport",
        ...some("preset", preset),
        ...some("size", size as { width: number; height: number } | undefined),
        ...some("mobile", mobile as boolean | undefined),
        ...some("colorScheme", colorScheme as "light" | "dark" | "system" | undefined),
      };
    }
    case "find":
      return str(c["query"], 500) ? { op: "find", query: c["query"] } : undefined;
    case "click": {
      const target = ref(c["ref"])
        ? { ref: c["ref"] }
        : point(c["coordinate"])
          ? { coordinate: c["coordinate"] }
          : undefined;
      if (
        target === undefined ||
        !optional(c["button"], (b) => b === "left" || b === "right") ||
        !optional(c["double"], (d) => typeof d === "boolean")
      )
        return undefined;
      return {
        op: "click",
        ...target,
        ...(c["button"] === "right" ? { button: "right" } : {}),
        ...(c["double"] === true ? { double: true } : {}),
        ...tokenOf(c),
      };
    }
    case "type":
      if (!str(c["text"], MAX_TEXT) || (c["ref"] !== undefined && !ref(c["ref"]))) return undefined;
      return {
        op: "type",
        text: c["text"],
        ...(c["ref"] === undefined ? {} : { ref: c["ref"] }),
        submit: flag(c["submit"]),
        ...tokenOf(c),
      };
    case "pressKey": {
      const modifiers = modifiersOf(c["modifiers"]);
      if (
        !optional(c["ref"], ref) ||
        !isPaneKey(c["key"]) ||
        modifiers === null ||
        paneKeyRefusal(c["key"], modifiers) !== undefined ||
        !optional(c["repeat"], (n) => int(n, 1, PANE_KEY_REPEAT_MAX))
      )
        return undefined;
      return {
        op: "pressKey",
        ...some("ref", c["ref"] as string | undefined),
        key: c["key"],
        ...(modifiers === undefined || modifiers.length === 0 ? {} : { modifiers }),
        ...(c["repeat"] === undefined || c["repeat"] === 1
          ? {}
          : { repeat: c["repeat"] as number }),
        ...tokenOf(c),
      };
    }
    case "formInput": {
      const value = c["value"];
      if (!ref(c["ref"]) || !(typeof value === "boolean" || str(value, MAX_TEXT))) return undefined;
      return { op: "formInput", ref: c["ref"], value, ...tokenOf(c) };
    }
    case "hover": {
      const target = optionalPoint(c);
      if (target === null || (target.ref === undefined && target.coordinate === undefined))
        return undefined;
      return { op: "hover", ...(target as PanePoint), ...tokenOf(c) };
    }
    case "scroll": {
      const direction = c["direction"];
      const target = optionalPoint(c);
      if (
        target === null ||
        (direction !== "up" &&
          direction !== "down" &&
          direction !== "left" &&
          direction !== "right") ||
        !optional(c["amount"], (n) => int(n, 1, PANE_SCROLL_MAX))
      )
        return undefined;
      return {
        op: "scroll",
        direction,
        ...some("amount", c["amount"] as number | undefined),
        ...target,
        ...tokenOf(c),
      };
    }
    case "scrollTo":
      return ref(c["ref"]) ? { op: "scrollTo", ref: c["ref"], ...tokenOf(c) } : undefined;
    case "drag": {
      const from = pointOf(c["from"]);
      const to = pointOf(c["to"]);
      return from === undefined || to === undefined
        ? undefined
        : { op: "drag", from, to, ...tokenOf(c) };
    }
    case "wait":
      if (
        !int(c["ms"], 0, PANE_WAIT_MAX_MS) ||
        !optional(c["text"], (t) => str(t, 500) && t !== "") ||
        !optional(c["ref"], ref) ||
        (c["text"] !== undefined && c["ref"] !== undefined)
      )
        return undefined;
      return {
        op: "wait",
        ms: c["ms"],
        ...some("text", c["text"] as string | undefined),
        ...some("ref", c["ref"] as string | undefined),
      };
    case "console":
      return { op: "console", onlyErrors: flag(c["onlyErrors"]) };
    case "evaluate":
      return str(c["expression"], PANE_EVALUATE_MAX) && c["expression"].trim() !== ""
        ? { op: "evaluate", expression: c["expression"], ...tokenOf(c) }
        : undefined;
    case "network":
      if (
        !optional(c["requestId"], (id) => typeof id === "string" && /^[\w.#-]{1,100}$/.test(id)) ||
        !optional(c["filter"], (f) => str(f, 500))
      )
        return undefined;
      return {
        op: "network",
        ...some("requestId", c["requestId"] as string | undefined),
        ...some("filter", c["filter"] as string | undefined),
      };
    case "recordStart":
      return optional(
        c["scale"],
        (n) => typeof n === "number" && Number.isFinite(n) && n >= 0.1 && n <= 1,
      )
        ? { op: "recordStart", ...some("scale", c["scale"] as number | undefined) }
        : undefined;
    case "recordStop":
      return { op: "recordStop", ...(c["discard"] === true ? { discard: true } : {}) };
    case "grant":
      return str(c["host"], 253) && (c["scope"] === "once" || c["scope"] === "always")
        ? { op: "grant", host: c["host"], scope: c["scope"] }
        : undefined;
    default:
      return undefined;
  }
}

/** A whole pane request, or `undefined` when any part of it is malformed. */
export function parsePaneRequest(raw: unknown): PaneRequest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const limits = r["limits"];
  const command = parsePaneCommand(r["command"]);
  if (!str(r["threadId"], 200) || r["threadId"] === "" || command === undefined) return undefined;
  if (typeof limits !== "object" || limits === null) return undefined;
  // Anything but an explicit `false` holds the caller to loopback.
  const loopbackOnly = (limits as Record<string, unknown>)["actOnLoopbackOnly"] !== false;
  const origins: unknown = (limits as Record<string, unknown>)["appOrigins"];
  const appOrigins = Array.isArray(origins)
    ? origins
        .slice(0, 8)
        .filter(
          (o): o is string =>
            typeof o === "string" && browseTarget(o).kind === "loopback" && originOf(o) === o,
        )
    : [];
  return {
    threadId: r["threadId"],
    limits: { actOnLoopbackOnly: loopbackOnly, ...(appOrigins.length > 0 ? { appOrigins } : {}) },
    command,
  };
}

/** One request of an agent's page, with what the shell knows of where it came from. */
export interface AgentRequest {
  readonly url: string;
  readonly method: string;
  readonly mainFrame: boolean;
  /** The origin of the page that started it; absent for a load the app itself started. */
  readonly initiator?: string | undefined;
  /** For a main frame's redirect, the URL it was redirected from. */
  readonly before?: string | undefined;
  /** The page the request is made from: its main frame's URL now. */
  readonly page: string;
  /** The user drives, or an approved action sends this very request: it may write. */
  readonly mayWrite: boolean;
  /** The page asked for this navigation, of its main frame or a frame in it, by submitting a form. */
  readonly formSubmission?: boolean | undefined;
}

/** What happens to one request of an agent's page. */
export type AgentRequestVerdict =
  /** The preview's own loopback rules decide. */
  | { readonly kind: "defer" }
  | { readonly kind: "allow" }
  /** Allowed if `host` doesn't resolve to a private address. */
  | { readonly kind: "resolve"; readonly host: string }
  | {
      readonly kind: "block";
      /** A main-frame navigation stopped, to report to the agent. */
      readonly navigation?:
        | { readonly host: string; readonly reason?: BrowseRefusal | undefined }
        | undefined;
    }
  /**
   * A write, held until the user's card: then sent as a `resolve` is, only if `host` doesn't
   * resolve to a private address.
   */
  | { readonly kind: "hold"; readonly host: string };

/**
 * The network rule for an agent's page. No main frame reaches loopback from a page elsewhere or a
 * redirect from one. A public page loads from public hosts and nothing private, EXAMPLE's or a
 * sign-in page's. Off loopback, a write (any method but a read: a form's POST, a script's fetch)
 * or a form submitted by GET is held for the user's card, unless the user drives or it is the
 * very submission a card approved. A loopback page is the preview's.
 */
export function agentRequest(request: AgentRequest, context: BrowseContext): AgentRequestVerdict {
  const { url } = request;
  if (request.mainFrame) {
    const target = browseTarget(url);
    if (target.kind === "loopback") {
      // A page's link or a redirect into Gram's own listeners, unless the user drives: a
      // load the app starts, such as a file card's Open, has no initiator and is the preview's.
      const fromPage = request.initiator !== undefined || request.before !== undefined;
      const own = agentNavigation(url, context);
      if (fromPage && !request.mayWrite && own.kind === "refuse") {
        return { kind: "block", navigation: { host: new URL(url).host, reason: own.reason } };
      }
      if (!offLoopback(request.initiator) && !offLoopback(request.before)) return { kind: "defer" };
      return {
        kind: "block",
        navigation: { host: new URL(url).host, reason: "fromPublic" },
      };
    }
    const decision = agentNavigation(url, context);
    if (decision.kind !== "allow") {
      return {
        kind: "block",
        navigation: {
          host: decision.host ?? url,
          ...(decision.kind === "refuse" ? { reason: decision.reason } : {}),
        },
      };
    }
    if (target.kind !== "public") return { kind: "block" };
    const submits = isWrite(request.method) || request.formSubmission === true;
    if (submits && !request.mayWrite) return { kind: "hold", host: target.host };
    return { kind: "resolve", host: target.host };
  }
  if (browseTarget(request.page).kind !== "public") return { kind: "defer" };
  if (publicPageRequest(url) === "block") return { kind: "block" };
  if (url.startsWith("data:") || url.startsWith("blob:")) return { kind: "allow" };
  const host = new URL(url).hostname;
  // A form can target a frame in the page as well as the page itself.
  const submits = isWrite(request.method) || request.formSubmission === true;
  if (submits && !request.mayWrite) return { kind: "hold", host };
  return { kind: "resolve", host };
}
