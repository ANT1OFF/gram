import { fieldsOf } from "@gram/contracts";

import { serverUrl } from "@/api/server-base";
import { withOriginKey } from "../api/origin-key";

/**
 * The machines joined to this Gram, managed over plain same-origin POSTs that the server's auth
 * layer answers itself, as phone access is: a paired phone or a joined machine can never reach
 * them.
 */
export class MachinesError extends Error {}

/** A joined machine as the settings page lists it. */
export interface JoinedMachine {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  /** Five groups of four hex digits, from the machine's key; `gram-host join` prints the same. */
  readonly fingerprint: string;
  readonly joinedAt: number;
  readonly confirmed: boolean;
  /** Set while it is connected. */
  readonly onlineSince?: number;
  /** When this Gram sent it a Claude token from `claude setup-token`; a time, never the token. */
  readonly claudeTokenSetAt?: number;
  /** Why it is offline, as this Gram last saw it; set only while it isn't connected. */
  readonly offline?: OfflineReason;
  /** The Gram release its host said it runs, while online or when it couldn't connect. */
  readonly release?: string;
  /** The `[user@]host` Gram installed it at over SSH, which its update runs again. */
  readonly sshTarget?: string;
  /**
   * While it is online, once asked: whether its own Claude Code is signed in to a subscription,
   * from its `claude auth status`. Only the classification reaches here.
   */
  readonly claudeSignIn?: MachineSignIn;
  readonly claudeSignInCheckedAt?: number;
  /** While it is online, once asked: whether `claude` and `git` are on its login-shell PATH. */
  readonly tools?: ReadonlyArray<MachineTool>;
  /** While it is online: its host updates itself over its connection, with no shell there. */
  readonly selfUpdate?: boolean;
  /** Its update over its connection, while one runs or since one ended. */
  readonly update?: MachineUpdate;
}

/** What keeps a machine from updating now. */
export interface MachineBusy {
  readonly turns: number;
  readonly terminals: number;
  readonly clones: number;
  readonly checks: number;
}

/** A joined machine's update to this Gram's release, as the server keeps it. Times are epoch ms. */
export type MachineUpdate =
  | { readonly phase: "waiting"; readonly release: string; readonly busy: MachineBusy }
  | {
      readonly phase: "downloading";
      readonly release: string;
      readonly received: number;
      readonly total?: number;
    }
  | {
      readonly phase: "verifying" | "unpacking" | "testing" | "switching" | "restarting";
      readonly release: string;
    }
  | { readonly phase: "updated"; readonly release: string; readonly at: number }
  | {
      readonly phase: "failed" | "rolledBack";
      readonly release: string;
      readonly message: string;
      readonly at: number;
    };

const STEPS: ReadonlySet<unknown> = new Set([
  "verifying",
  "unpacking",
  "testing",
  "switching",
  "restarting",
]);

const isUpdate = (value: unknown): value is MachineUpdate => {
  const u = fieldsOf(value);
  if (typeof u.get("release") !== "string") return false;
  switch (u.get("phase")) {
    case "waiting": {
      const busy = fieldsOf(u.get("busy"));
      return (
        typeof busy.get("turns") === "number" &&
        typeof busy.get("terminals") === "number" &&
        typeof busy.get("clones") === "number" &&
        typeof busy.get("checks") === "number"
      );
    }
    case "downloading":
      return (
        typeof u.get("received") === "number" &&
        (u.get("total") === undefined || typeof u.get("total") === "number")
      );
    case "updated":
      return typeof u.get("at") === "number";
    case "failed":
    case "rolledBack":
      return typeof u.get("at") === "number" && typeof u.get("message") === "string";
    default:
      return STEPS.has(u.get("phase"));
  }
};

/**
 * Why access over Tailscale is on but no machine can dial in: Tailscale on this computer is
 * missing, signed out, stopped, without HTTPS certificates or not answering, or Gram couldn't set
 * up its Serve listener (`serve`).
 */
export type TailscaleDown = "missing" | "signed-out" | "stopped" | "no-https" | "error" | "serve";

/**
 * Why a joined machine is offline: the last reason it dropped or was refused since this Gram
 * started, that access over Tailscale is off or down here, or that it hasn't dialled since. Times
 * are epoch ms.
 */
export type OfflineReason =
  | { readonly kind: "never" }
  | { readonly kind: "tailscale-off" }
  | { readonly kind: "tailscale-down"; readonly cause: TailscaleDown }
  | { readonly kind: "unconfirmed"; readonly at: number }
  | { readonly kind: "bad-signature"; readonly at: number }
  | { readonly kind: "clock"; readonly at: number; readonly skewMs: number }
  | {
      readonly kind: "mismatch";
      readonly at: number;
      readonly protocol: number;
      readonly release?: string;
      readonly missing?: ReadonlyArray<string>;
    }
  | { readonly kind: "no-hello"; readonly at: number }
  | { readonly kind: "lost"; readonly at: number }
  | { readonly kind: "moved"; readonly at: number };

/** A command a joined machine needs, as its host found it. */
export interface MachineTool {
  readonly tool: "claude" | "git";
  readonly found: boolean;
  readonly version?: string;
}

const TOOL_NAMES: Readonly<Record<MachineTool["tool"], string>> = {
  claude: "Claude Code",
  git: "Git",
};

const toolOf = (machine: JoinedMachine, tool: MachineTool["tool"]) =>
  machine.tools?.find((each) => each.tool === tool);

/** "Claude Code 2.1.319 · Git 2.47.0": the tools it found and their versions, when it said. */
export const machineToolsLine = (machine: JoinedMachine): string | undefined => {
  const found = (machine.tools ?? []).filter((tool) => tool.found);
  return found.length === 0
    ? undefined
    : found
        .map((tool) =>
          tool.version === undefined
            ? TOOL_NAMES[tool.tool]
            : `${TOOL_NAMES[tool.tool]} ${tool.version}`,
        )
        .join(" · ");
};

/** Whether signing in there is the fix: Claude Code is there, and isn't on a subscription login. */
export const machineNeedsSignIn = (machine: JoinedMachine): boolean =>
  toolOf(machine, "claude")?.found !== false &&
  (machine.claudeSignIn === "notSignedIn" ||
    machine.claudeSignIn === "apiKey" ||
    machine.claudeSignIn === "thirdParty");

/** A joined machine's Claude Code sign-in, as `app.launchChecks` names this one's. */
export type MachineSignIn = "signedIn" | "notSignedIn" | "apiKey" | "thirdParty" | "unknown";
const SIGN_INS: ReadonlySet<unknown> = new Set([
  "signedIn",
  "notSignedIn",
  "apiKey",
  "thirdParty",
  "unknown",
]);

/**
 * Why `machine` can't start a Claude session now, with the fix to make there, or `undefined`
 * when it can, or can't say (an older gram-host, or not asked yet): a tool it lacks first, then
 * its sign-in.
 */
export const machineSignInProblem = (machine: JoinedMachine): string | undefined => {
  if (toolOf(machine, "claude")?.found === false)
    return `Claude Code isn't installed on ${machine.name}, or isn't on its login shell's PATH.`;
  if (toolOf(machine, "git")?.found === false)
    return `Git isn't installed on ${machine.name}, or isn't on its login shell's PATH.`;
  switch (machine.claudeSignIn) {
    case "notSignedIn":
      return `Claude Code isn't signed in on ${machine.name}. Run \`claude /login\` there.`;
    case "apiKey":
      return `Claude Code on ${machine.name} uses an API key; Gram needs your subscription login. Run \`claude /login\` there.`;
    case "thirdParty":
      return `Claude Code on ${machine.name} is set up for a third-party API provider; Gram needs your subscription login there.`;
    default:
      return undefined;
  }
};

export interface MachinesStatus {
  readonly machines: ReadonlyArray<JoinedMachine>;
  /** A join link waiting to be used. */
  readonly joinLink?: { readonly expiresAt: number };
  /** After a Remove: the machine was offline, so the Claude token sent to it is still there. */
  readonly tokenLeft?: true;
  /** This Gram's release, absent when it runs from source. */
  readonly release?: string;
  /** The host protocol this Gram speaks. */
  readonly protocol?: number;
  /** What updates a joined machine when run there; set while access over Tailscale is on. */
  readonly updateCommand?: string;
  /** Whether joined machines update to this Gram's release on their own; on unless turned off. */
  readonly automaticUpdates?: boolean;
}

export interface JoinLink {
  readonly url: string;
  readonly expiresAt: number;
}

const post = (path: string, body?: unknown): Promise<Response> =>
  fetch(
    serverUrl(path),
    withOriginKey({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
  );

const refusal = async (response: Response, fallback: string): Promise<MachinesError> => {
  const text = await response.text().catch(() => "");
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && "message" in value)
      return new MachinesError(String(value.message));
  } catch (_plainText) {}
  return new MachinesError(text.trim() !== "" && text.length < 200 ? text : fallback);
};

const isTool = (value: unknown): value is MachineTool => {
  const t = fieldsOf(value);
  return (
    (t.get("tool") === "claude" || t.get("tool") === "git") &&
    typeof t.get("found") === "boolean" &&
    (t.get("version") === undefined || typeof t.get("version") === "string")
  );
};

const isNumber = (field: unknown) => typeof field === "number";
const isString = (field: unknown) => typeof field === "string";

const isMachine = (value: unknown): value is JoinedMachine => {
  const m = fieldsOf(value);
  const optional = (key: string, is: (field: unknown) => boolean) =>
    m.get(key) === undefined || is(m.get(key));
  return (
    typeof m.get("id") === "string" &&
    typeof m.get("name") === "string" &&
    typeof m.get("platform") === "string" &&
    typeof m.get("fingerprint") === "string" &&
    typeof m.get("joinedAt") === "number" &&
    typeof m.get("confirmed") === "boolean" &&
    optional("onlineSince", isNumber) &&
    optional("claudeTokenSetAt", isNumber) &&
    optional("claudeSignIn", (field) => SIGN_INS.has(field)) &&
    optional("claudeSignInCheckedAt", isNumber) &&
    optional("tools", (field) => Array.isArray(field) && field.every(isTool)) &&
    optional("offline", isOffline) &&
    optional("release", isString) &&
    optional("sshTarget", isString) &&
    optional("selfUpdate", (field) => typeof field === "boolean") &&
    optional("update", isUpdate)
  );
};

const REASONS = new Set([
  "never",
  "tailscale-off",
  "tailscale-down",
  "unconfirmed",
  "bad-signature",
  "clock",
  "mismatch",
  "no-hello",
  "lost",
  "moved",
]);

const DOWN_CAUSES = new Set(["missing", "signed-out", "stopped", "no-https", "error", "serve"]);

const isOffline = (value: unknown): value is OfflineReason => {
  const r = fieldsOf(value);
  const kind = r.get("kind");
  if (typeof kind !== "string" || !REASONS.has(kind)) return false;
  if (kind === "never" || kind === "tailscale-off") return true;
  if (kind === "tailscale-down") {
    const cause = r.get("cause");
    return typeof cause === "string" && DOWN_CAUSES.has(cause);
  }
  if (typeof r.get("at") !== "number") return false;
  if (kind === "clock") return typeof r.get("skewMs") === "number";
  if (kind === "mismatch") {
    const missing = r.get("missing");
    return (
      typeof r.get("protocol") === "number" &&
      (r.get("release") === undefined || typeof r.get("release") === "string") &&
      (missing === undefined ||
        (Array.isArray(missing) && missing.every((m) => typeof m === "string")))
    );
  }
  return true;
};

const status = async (response: Response, fallback: string): Promise<MachinesStatus> => {
  if (!response.ok) throw await refusal(response, fallback);
  const value = fieldsOf(await response.json());
  const machines = value.get("machines");
  if (!Array.isArray(machines) || !machines.every(isMachine)) throw new MachinesError(fallback);
  const expiresAt = fieldsOf(value.get("joinLink")).get("expiresAt");
  const release = value.get("release");
  const protocol = value.get("protocol");
  const updateCommand = value.get("updateCommand");
  const automaticUpdates = value.get("automaticUpdates");
  return {
    machines,
    ...(typeof expiresAt === "number" ? { joinLink: { expiresAt } } : {}),
    ...(value.get("tokenLeft") === true ? { tokenLeft: true } : {}),
    ...(typeof release === "string" ? { release } : {}),
    ...(typeof protocol === "number" ? { protocol } : {}),
    ...(typeof updateCommand === "string" ? { updateCommand } : {}),
    ...(typeof automaticUpdates === "boolean" ? { automaticUpdates } : {}),
  };
};

/**
 * What a start carries to show the person agreed to the consent dialog; the server refuses a start
 * without it.
 */
export const TOKEN_CONSENT = "send-claude-token-to-these-machines";

/** One machine's answer once the token was sent. */
export interface TokenSent {
  readonly id: string;
  readonly ok: boolean;
  readonly message?: string;
}

/** A `claude setup-token` run, as the server reports it; its output never reaches the page. */
export type TokenRun =
  | { readonly state: "waiting"; readonly signInLink?: string; readonly asksForCode: boolean }
  | { readonly state: "sending" }
  | { readonly state: "done"; readonly results: ReadonlyArray<TokenSent> }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "cancelled" };

const isTokenRun = (value: unknown): value is TokenRun => {
  const run = fieldsOf(value);
  switch (run.get("state")) {
    case "waiting": {
      const link = run.get("signInLink");
      return (
        typeof run.get("asksForCode") === "boolean" &&
        (link === undefined || (typeof link === "string" && link.startsWith("https://")))
      );
    }
    case "sending":
    case "cancelled":
      return true;
    case "failed":
      return typeof run.get("message") === "string";
    case "done": {
      const results = run.get("results");
      return (
        Array.isArray(results) &&
        results.every((result: unknown) => {
          const sent = fieldsOf(result);
          return typeof sent.get("id") === "string" && typeof sent.get("ok") === "boolean";
        })
      );
    }
    default:
      return false;
  }
};

const jsonFields = (text: string): ReadonlyMap<string, unknown> => {
  try {
    return fieldsOf(JSON.parse(text));
  } catch (_plainText) {
    return new Map();
  }
};

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

/** The query the Machines page and the new-thread machine picker share. */
export const MACHINES_KEY = ["machines.status"] as const;

export const machinesApi = {
  list: async () => status(await post("/machines/list"), "Couldn't read the machines"),
  confirm: async (id: string) =>
    status(await post("/machines/confirm", { id }), "Couldn't confirm the machine"),
  remove: async (id: string) =>
    status(await post("/machines/remove", { id }), "Couldn't remove the machine"),
  /** Asks the machine again what it can run (sign-in, tools), and answers with the fresh listing. */
  checkSignIn: async (id: string) =>
    status(await post("/machines/check-sign-in", { id }), "Couldn't check the machine's sign-in"),
  /** A one-time join link, or `tailscale-off` while access over Tailscale is off. */
  joinLink: async (): Promise<JoinLink | "tailscale-off" | "ssh-running"> => {
    const response = await post("/machines/join-link");
    if (response.status === 409)
      return (await response.text().catch(() => "")).includes('"ssh-running"')
        ? "ssh-running"
        : "tailscale-off";
    if (!response.ok) throw await refusal(response, "Couldn't make a join link");
    const value = fieldsOf(await response.json());
    const url = value.get("url");
    const expiresAt = value.get("expiresAt");
    if (typeof url !== "string" || typeof expiresAt !== "number")
      throw new MachinesError("Couldn't make a join link");
    return { url, expiresAt };
  },
  /**
   * The Claude token from `claude setup-token` on this machine, for joined machines the person
   * consented to send it to. Only the run's state comes back: never its output or the token.
   */
  claudeToken: {
    start: async (ids: ReadonlyArray<string>): Promise<string> => {
      const response = await post("/machines/claude-token/start", {
        ids,
        consent: TOKEN_CONSENT,
      });
      if (!response.ok) throw await refusal(response, "Couldn't start claude setup-token");
      const captureId = fieldsOf(await response.json()).get("captureId");
      if (typeof captureId !== "string")
        throw new MachinesError("Couldn't start claude setup-token");
      return captureId;
    },
    status: async (captureId: string): Promise<TokenRun> => {
      const response = await post("/machines/claude-token/status", { captureId });
      if (!response.ok) throw await refusal(response, "Couldn't read the sign-in");
      const value: unknown = await response.json();
      if (!isTokenRun(value)) throw new MachinesError("Couldn't read the sign-in");
      return value;
    },
    code: async (captureId: string, code: string): Promise<void> => {
      const response = await post("/machines/claude-token/code", { captureId, code });
      if (!response.ok) throw await refusal(response, "Couldn't send the code");
    },
    cancel: async (captureId: string): Promise<void> => {
      await post("/machines/claude-token/cancel", { captureId });
    },
    forget: async (id: string) =>
      status(await post("/machines/claude-token/forget", { id }), "Couldn't forget the token"),
  },
  /**
   * Updates every machine whose host updates itself and runs an earlier release, each once it is
   * idle; the rows show how each goes.
   */
  /** Turns joined machines updating on their own on or off; only this computer's app can. */
  setAutomaticUpdates: async (enabled: boolean) =>
    status(
      await post("/machines/automatic-updates", { enabled }),
      "Couldn't change automatic updates",
    ),
  updateAll: async () => status(await post("/machines/update-all"), "Couldn't update the machines"),
  /**
   * Updates the machine to this Gram's release. A host that updates itself starts at once and its
   * row shows how it goes (`started`); otherwise this runs the install over SSH again on a machine
   * Gram added that way, which moves its service and keeps the join. Minutes, while it downloads
   * Gram there.
   */
  update: async (
    id: string,
  ): Promise<MachinesStatus & { readonly output: string; readonly started?: boolean }> => {
    const response = await post("/machines/update", { id });
    const text = await response.text().catch(() => "");
    const value = jsonFields(text);
    const output = stringOr(value.get("output"), "");
    if (!response.ok)
      throw new SshJoinError(
        stringOr(value.get("message"), "Couldn't update the machine"),
        output,
        value.get("reason") === "ssh-running",
      );
    return {
      ...(await status(new Response(text, { status: 200 }), "Couldn't update the machine")),
      output,
      ...(value.get("started") === true ? { started: true } : {}),
    };
  },
  /** The hosts in this computer's SSH config, for the Add over SSH picker. */
  sshHosts: async (): Promise<ReadonlyArray<string>> => {
    const response = await post("/machines/ssh-hosts");
    if (!response.ok) return [];
    const hosts = fieldsOf(await response.json()).get("hosts");
    return Array.isArray(hosts)
      ? hosts.filter((host): host is string => typeof host === "string")
      : [];
  },
  /**
   * Installs and joins `target` over this computer's SSH, confirming it when the key that joined is
   * the one the install printed. Minutes, while it downloads Gram there.
   */
  sshJoin: async (
    target: string,
  ): Promise<
    MachinesStatus & {
      /** The machine confirmed, or `rejoined` when it had joined before and its service moved. */
      readonly joined: string;
      /** What went wrong after it joined and was confirmed, such as its service not starting. */
      readonly problem?: string;
      readonly output: string;
    }
  > => {
    const response = await post("/machines/ssh-join", { target });
    const text = await response.text().catch(() => "");
    const value = jsonFields(text);
    const output = stringOr(value.get("output"), "");
    if (!response.ok)
      throw new SshJoinError(
        stringOr(value.get("message"), "Couldn't add the machine over SSH"),
        output,
        value.get("reason") === "ssh-running",
      );
    const parsed = await status(new Response(text, { status: 200 }), "Couldn't add the machine");
    const problem = value.get("problem");
    return {
      ...parsed,
      joined: stringOr(value.get("joined"), ""),
      ...(typeof problem === "string" ? { problem } : {}),
      output,
    };
  },
};

/** Why adding over SSH failed, and the end of what the session printed. */
export class SshJoinError extends MachinesError {
  readonly output: string;
  /** Refused because another install over SSH is running, which this one left alone. */
  readonly busy: boolean;
  constructor(message: string, output: string, busy = false) {
    super(message);
    this.output = output;
    this.busy = busy;
  }
}
