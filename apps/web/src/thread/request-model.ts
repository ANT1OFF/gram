import {
  LIMIT_PAUSE_TOOL,
  LimitPauseInput,
  SETTINGS_PROPOSE_TOOL,
  SettingsProposalCard,
  WORKSPACE_CREATE_TOOL,
  WORKSPACE_UPDATE_TOOL,
  WorkspaceProposalCard,
  type ApprovalRequest,
  type PermissionBehavior,
  type PermissionUpdateDestination,
} from "@gram/contracts";
import * as Schema from "effect/Schema";

import { limitShareText, resetText } from "@/usage/limit-format";

export { approvalSubject } from "@gram/contracts";

/** The pause ask's words, in the viewer's own time. */
export interface LimitPauseAsk {
  /** "Claude is at 90% of its 5-hour limit". */
  readonly lead: string;
  /** "Pause new workers until it resets at 18:00? Running ones finish." */
  readonly description: string;
  /** Deny: "Pause until 18:00". */
  readonly pause: string;
  /** Allow. */
  readonly keep: string;
}

const decodePause = Schema.decodeUnknownOption(LimitPauseInput);

/**
 * The card a spawn raises at the workspace's limit threshold (`LIMIT_PAUSE_TOOL`), worded with the
 * reset on the viewer's 24-hour clock: Deny pauses new workers until then, Allow keeps going.
 * `undefined` for any other approval.
 */
export const limitPauseAsk = (
  request: ApprovalRequest,
  now = Date.now(),
  intl: { readonly locale?: string; readonly timeZone?: string } = {},
): LimitPauseAsk | undefined => {
  if (request.toolName !== LIMIT_PAUSE_TOOL) return undefined;
  const input = decodePause(request.input);
  if (input._tag === "None") return undefined;
  const { agent, window, usedPct, resetsAt } = input.value;
  const reset = resetsAt === undefined ? undefined : resetText(resetsAt, now, intl);
  return {
    lead: limitShareText({ agent, usedPct, window }),
    description: `Pause new workers until it resets${reset === undefined ? "" : ` at ${reset}`}? Running ones finish.`,
    pause: reset === undefined ? "Pause new workers" : `Pause until ${reset}`,
    keep: "Keep going",
  };
};

/** The prefix every Gram app tool's name carries on a card, whichever agent raised it. */
const APP_TOOL_PREFIX = "mcp__gram__";

const decodeSettings = Schema.decodeUnknownOption(SettingsProposalCard);

/**
 * A `settings_propose` card's change set, each row a setting before → after, or `undefined` for
 * any other approval. A card that doesn't decode reads as any other app tool's.
 */
export const settingsProposal = (request: ApprovalRequest): SettingsProposalCard | undefined => {
  if (request.toolName !== `${APP_TOOL_PREFIX}${SETTINGS_PROPOSE_TOOL}`) return undefined;
  const card = decodeSettings(request.input);
  return card._tag === "None" ? undefined : card.value;
};

const decodeWorkspace = Schema.decodeUnknownOption(WorkspaceProposalCard);

const WORKSPACE_TOOLS = [WORKSPACE_CREATE_TOOL, WORKSPACE_UPDATE_TOOL].map(
  (name) => `${APP_TOOL_PREFIX}${name}`,
);

/**
 * A `workspace_create` or `workspace_update` card's whole change: the projects, then each setting
 * before → after, or `undefined` for any other approval. A card that doesn't decode reads as any
 * other app tool's.
 */
export const workspaceProposal = (request: ApprovalRequest): WorkspaceProposalCard | undefined => {
  if (!WORKSPACE_TOOLS.includes(request.toolName)) return undefined;
  const card = decodeWorkspace(request.input);
  return card._tag === "None" ? undefined : card.value;
};

/**
 * The sentence an app tool's card leads with: the server's own description of this call
 * (`describe`), or of the tool. `undefined` for any other tool, and for an app tool that came with
 * no description, whose cards lead with `approvalSubject` as they always have.
 *
 * An app tool's input is the agent's whole argument object, so its subject is that object as one
 * line of JSON: a forced `spawn_worker` card once showed a brief of several hundred escaped words
 * under a description that had already said what was being asked.
 */
export const appToolSummary = (request: ApprovalRequest): string | undefined => {
  if (!request.toolName.startsWith(APP_TOOL_PREFIX)) return undefined;
  const description = request.description?.trim();
  return description === undefined || description === "" ? undefined : description;
};

/**
 * An approval whose whole input has to be read before it is answered: a `report_issue` posts that
 * text to a shared repo, a `settings_propose` changes Gram's own settings, a `workspace_create` or
 * `workspace_update` decides which repos a workspace reaches and what its agents may do, and an
 * agent's form submission or held page requests (`browser_*` with a `control`) send what its
 * details list to a public site. It is never answered from its summary alone, so compact cards show
 * its details and the inbox never folds it into an "Allow all".
 */
export const mustReadDetails = (request: ApprovalRequest): boolean =>
  request.toolName === `${APP_TOOL_PREFIX}report_issue` ||
  request.toolName === `${APP_TOOL_PREFIX}${SETTINGS_PROPOSE_TOOL}` ||
  WORKSPACE_TOOLS.includes(request.toolName) ||
  (request.toolName.startsWith(`${APP_TOOL_PREFIX}browser_`) &&
    typeof request.input["control"] === "string");

export interface ApprovalDetailField {
  readonly label: string;
  readonly value: string;
}

/** The input field `approvalSubject` leads with, or `undefined` when it shows the whole input. */
const subjectKey = (input: ApprovalRequest["input"]): string | undefined =>
  ["command", "file_path", "url"].find((key) => typeof input[key] === "string");

/** How much of an argument's value the line under the subject shows; Details has all of it. */
const EXTRA_VALUE_MAX = 80;

/**
 * The input's other arguments, beside the one `approvalSubject` shows: an Allow covers all of them,
 * and they are what tells two approvals of the same command apart, such as a `timeout`. A
 * `description` the card already shows is left out, and a long value is cut short.
 */
export const approvalExtras = (request: ApprovalRequest): ApprovalDetailField[] => {
  const key = subjectKey(request.input);
  if (key === undefined) return [];
  return Object.entries(request.input).flatMap(([label, value]) => {
    if (label === key || value === undefined) return [];
    if (label === "description" && value === request.description) return [];
    const text = (typeof value === "string" ? value : JSON.stringify(value)).replace(/\s+/g, " ");
    return [
      {
        label,
        value: text.length > EXTRA_VALUE_MAX ? `${text.slice(0, EXTRA_VALUE_MAX - 1)}…` : text,
      },
    ];
  });
};

/**
 * An app tool's input behind its card's "Details": a spawn as labelled fields, its scope and its
 * brief, anything else as indented JSON. Every string in it is agent-authored and is shown as
 * plain text.
 */
export type ApprovalDetails =
  | {
      readonly kind: "spawn";
      readonly fields: readonly ApprovalDetailField[];
      readonly scope: readonly string[];
      readonly brief: string;
    }
  | {
      readonly kind: "issue";
      readonly fields: readonly ApprovalDetailField[];
      /** The issue's body exactly as it is posted, diagnostics footer included. */
      readonly body: string;
    }
  | { readonly kind: "json"; readonly text: string };

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const texts = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.flatMap((item) => text(item) ?? []) : [];

/** A `report_issue` card's issue as the server composed it, or `undefined` if it isn't one. */
const issueDetails = (input: ApprovalRequest["input"]): ApprovalDetails | undefined => {
  const repo = text(input["repo"]);
  const title = text(input["title"]);
  const body = input["body"];
  if (repo === undefined || title === undefined || typeof body !== "string") return undefined;
  return {
    kind: "issue",
    fields: [
      { label: "Repo", value: repo },
      { label: "Labels", value: texts(input["labels"]).join(", ") },
      { label: "Title", value: title },
    ],
    body,
  };
};

/** The folded details of an app tool's card. A spawn missing its project or brief reads as JSON. */
export const approvalDetails = (request: ApprovalRequest): ApprovalDetails => {
  const { input } = request;
  const json: ApprovalDetails = { kind: "json", text: JSON.stringify(input, null, 2) };
  if (request.toolName === `${APP_TOOL_PREFIX}report_issue`) return issueDetails(input) ?? json;
  if (request.toolName !== `${APP_TOOL_PREFIX}spawn_worker`) return json;
  const project = text(input["project"]);
  const brief = text(input["brief"]);
  if (project === undefined || brief === undefined) return json;
  const alsoIn = texts(input["alsoIn"]);
  const model = [text(input["model"]), text(input["effort"])].flatMap((part) => part ?? []);
  const readAlso = texts(input["readAlso"]);
  const rows: ReadonlyArray<readonly [string, string | undefined]> = [
    [alsoIn.length === 0 ? "Project" : "Projects", [project, ...alsoIn].join(", ")],
    ["Feature", text(input["feature"])],
    ["Group", text(input["group"])],
    ["Title", text(input["title"])],
    ["Branch", text(input["branch"])],
    ["Base", text(input["base"])],
    ["Model", model.length === 0 ? undefined : model.join(" · ")],
    ["May read", readAlso.length === 0 ? undefined : readAlso.join(", ")],
  ];
  return {
    kind: "spawn",
    fields: rows.flatMap(([label, value]) => (value === undefined ? [] : [{ label, value }])),
    scope: texts(input["scope"]),
    brief,
  };
};

/** How far a saved "always" reaches, from narrowest to widest. */
export type AlwaysReach = "thread" | "repository" | "project" | "everywhere";

/** One thing an "Always allow" saves: the rule as its agent stores it, and where. */
export interface AlwaysRule {
  /** The rule in the agent's own spelling: `Bash(git push:*)`, a folder, a mode, or a host. */
  readonly rule: string;
  /** "Allow", "Deny" or "Ask": what the rule does to a matching call. */
  readonly behavior: string;
  readonly reach: AlwaysReach;
  /** How it reaches there, in words: "until its agent session ends". */
  readonly scope: string;
  /** Where it is kept, when that is a file or a setting the user can open. */
  readonly kept: string | undefined;
}

/**
 * Claude Code's settings destinations, as an "always" answer writes them (`resolveRequest` in
 * `packages/agents/src/claude/permissions.ts` passes the suggestion's own destination through),
 * each stated at the widest reach Claude Code gives it (code.claude.com/docs/en/settings and
 * /worktrees), never narrower:
 * - `session`, `cliArg`: held by the session alone, gone when it ends.
 * - `localSettings`: since Claude Code v2.1.211, `.claude/settings.local.json` at the repository's
 *   root, the main checkout's root for a worktree, so the rule applies in the main checkout and
 *   every worktree of the repository and outlives the worktree that saved it. It stays in the
 *   working folder only in narrower cases (outside git, Windows, a home-directory repository).
 * - `projectSettings`: `.claude/settings.json` in the session's working folder, read by everyone
 *   working there, and by everyone with the repository once the file is committed.
 * - `userSettings`: the Claude config's `settings.json` (`~/.claude`, or `CLAUDE_CONFIG_DIR`),
 *   which every project on this machine using that config reads, inside Gram and out.
 */
const DESTINATION: Readonly<
  Record<PermissionUpdateDestination, { reach: AlwaysReach; scope: string; kept?: string }>
> = {
  session: { reach: "thread", scope: "until its agent session ends" },
  cliArg: { reach: "thread", scope: "until its agent session ends" },
  localSettings: {
    reach: "repository",
    scope: "the main checkout and all its worktrees, for you only, after this worktree is gone too",
    kept: ".claude/settings.local.json at the repository root",
  },
  projectSettings: {
    reach: "project",
    scope: "everyone working in this folder, and everyone with the repository once it is committed",
    kept: ".claude/settings.json",
  },
  userSettings: {
    reach: "everywhere",
    scope: "every project on this machine that uses this Claude configuration, inside Gram and out",
    kept: "Claude Code user settings",
  },
};

const BEHAVIOR: Readonly<Record<PermissionBehavior, string>> = {
  allow: "Allow",
  deny: "Deny",
  ask: "Ask",
};

const MODE_WORDS: Readonly<Record<string, string>> = {
  default: "Ask before edits and commands",
  acceptEdits: "Accept edits without asking",
  plan: "Plan mode",
  bypassPermissions: "Bypass permissions",
  dontAsk: "Don't ask",
  auto: "Auto",
};

/**
 * What the card's "Always allow…" would save, rule by rule, exactly as the agent's suggestions say,
 * so the user reads the rule and its reach before it is kept. A browse card's "always" is the host
 * in Settings → General → Agent may browse, which every workspace shares. Empty when the card has
 * nothing to save: a Codex card, whose cards never carry a rule (`suggestions: []`), offers no
 * "always" at all.
 */
export const alwaysRules = (request: ApprovalRequest): AlwaysRule[] => {
  if (request.browseHost !== undefined) {
    return [
      {
        rule: request.browseHost,
        behavior: "Browse",
        reach: "everywhere",
        scope: "any agent may open it without asking",
        kept: "Settings → General → Agent may browse",
      },
    ];
  }
  return request.suggestions.flatMap((update): AlwaysRule[] => {
    const where = DESTINATION[update.destination];
    const at = { reach: where.reach, scope: where.scope, kept: where.kept };
    switch (update.type) {
      case "addRules":
      case "replaceRules":
        return update.rules.map((rule) => ({
          rule:
            rule.ruleContent === undefined
              ? rule.toolName
              : `${rule.toolName}(${rule.ruleContent})`,
          behavior: BEHAVIOR[update.behavior],
          ...at,
        }));
      case "removeRules":
        return update.rules.map((rule) => ({
          rule:
            rule.ruleContent === undefined
              ? rule.toolName
              : `${rule.toolName}(${rule.ruleContent})`,
          behavior: "Remove",
          ...at,
        }));
      case "addDirectories":
        return update.directories.map((directory) => ({
          rule: directory,
          behavior: "Add folder",
          ...at,
        }));
      case "removeDirectories":
        return update.directories.map((directory) => ({
          rule: directory,
          behavior: "Remove folder",
          ...at,
        }));
      case "setMode":
        return [{ rule: MODE_WORDS[update.mode] ?? update.mode, behavior: "Mode", ...at }];
    }
  });
};
