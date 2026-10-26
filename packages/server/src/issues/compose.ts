import {
  ISSUE_KIND_LABELS,
  newIssueUrl,
  GRAM_REPO,
  type ComposedIssue,
  type FiledIssue,
  type IssueArea,
  type IssueKind,
} from "@gram/contracts";
import { tildeHome } from "../diagnostics/report.ts";
import { redactText } from "../logging/redact.ts";

/** Who is filing: an agent through `report_issue`, or the user through the form. */
export type IssueFiler = "agent" | "user";

/** What the footer says about the machine and the thread. Never transcript text, logs or settings. */
export interface IssueDiagnostics {
  readonly version: string;
  /** `Darwin 25.0.0 (darwin arm64)`. */
  readonly os: string;
  readonly agent?:
    | {
        readonly kind: string;
        /** The CLI's version, when the launch checks read one. */
        readonly version?: string | undefined;
        readonly model: string;
      }
    | undefined;
  readonly filer: IssueFiler;
}

/** An issue as the tool or the form gives it. */
export interface IssueText {
  readonly kind: IssueKind;
  readonly title: string;
  readonly body: string;
  readonly area?: IssueArea | undefined;
}

/** The repo's labels for an issue: its kind's, then its area's. */
export const issueLabels = (kind: IssueKind, area?: IssueArea): ReadonlyArray<string> => [
  ISSUE_KIND_LABELS[kind],
  ...(area === undefined ? [] : [area]),
];

/** The characters `plainCardText` drops from a card, which would let a body read differently there. */
const HIDDEN = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu;

/** `text` as it may be posted: tokens redacted, the home directory as `~`, no hidden reordering. */
export const scrubIssueText = (text: string, home: string | undefined): string =>
  tildeHome(redactText(text.replace(HIDDEN, "")), home);

/** The footer's markdown, from values Gram knows rather than anything from a conversation. */
export const diagnosticsFooter = (diagnostics: IssueDiagnostics): string => {
  const { agent } = diagnostics;
  const lines = [
    "**Diagnostics**",
    "",
    `- Gram ${diagnostics.version}`,
    `- ${diagnostics.os}`,
    ...(agent === undefined
      ? []
      : [
          `- Agent: ${agent.kind}${agent.version === undefined ? "" : ` ${agent.version}`}` +
            (agent.model === "" ? "" : `, model ${agent.model}`),
        ]),
    `- Filed from Gram by ${diagnostics.filer === "agent" ? "an agent in a thread" : "the user"}`,
  ];
  return lines.join("\n");
};

/**
 * The issue exactly as it is posted, for the approval card, the form's preview and `gh` alike:
 * title and body scrubbed, and the footer after a rule when there are diagnostics.
 */
export const composeIssue = (
  text: IssueText,
  diagnostics: IssueDiagnostics | undefined,
  home: string | undefined,
): ComposedIssue => {
  const title = scrubIssueText(text.title, home).replace(/\s+/g, " ").trim();
  const written = scrubIssueText(text.body, home).trimEnd();
  const footer =
    diagnostics === undefined ? undefined : scrubIssueText(diagnosticsFooter(diagnostics), home);
  // The blank line keeps the rule from turning the line above it into a heading.
  const body =
    footer === undefined ? written : written === "" ? footer : `${written}\n\n---\n\n${footer}`;
  const labels = issueLabels(text.kind, text.area);
  return {
    repo: GRAM_REPO,
    labels,
    title,
    body,
    ...(footer === undefined ? {} : { diagnostics: footer }),
    newIssueUrl: newIssueUrl({ repo: GRAM_REPO, title, body, labels }),
  };
};

/** One hit of `search_issues`. */
export interface IssueHit {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly url: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A REST issue as `number` and `url`, or `undefined` when the response isn't one. */
export const parseFiledIssue = (stdout: string): FiledIssue | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // gh printed something other than the issue; the caller reports the call as failed.
    return undefined;
  }
  const issue = record(parsed);
  const number = issue?.["number"];
  const url = issue?.["html_url"];
  return typeof number === "number" && typeof url === "string" ? { number, url } : undefined;
};

/**
 * An agent's search words with every qualifier that names where to search (`repo:`, `org:`,
 * `user:`) taken out, since GitHub widens a search to every repo it names and gh searches as the
 * user.
 */
export const confineIssueQuery = (query: string): string =>
  query
    .split(/\s+/)
    .filter((word) => !/^-?(?:repo|org|user|owner):/i.test(word))
    .join(" ")
    .trim();

/**
 * The issues of a REST search response on `repo`, at most `limit`: pull requests are left out, and
 * so is anything from another repo, whatever the query managed to ask for.
 */
export const parseIssueSearch = (
  stdout: string,
  limit: number,
  repo: string,
): ReadonlyArray<IssueHit> => {
  const prefix = `https://github.com/${repo}/issues/`.toLowerCase();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not a search response: no hits rather than a guess.
    return [];
  }
  const items = record(parsed)?.["items"];
  if (!Array.isArray(items)) return [];
  return items
    .flatMap((item): ReadonlyArray<IssueHit> => {
      const issue = record(item);
      if (issue === undefined || issue["pull_request"] !== undefined) return [];
      const { number, title, state, html_url: url } = issue;
      return typeof number === "number" &&
        typeof title === "string" &&
        typeof state === "string" &&
        typeof url === "string" &&
        url.toLowerCase().startsWith(prefix)
        ? [{ number, title, state, url }]
        : [];
    })
    .slice(0, limit);
};
