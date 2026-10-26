import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";

/** This project's issue tracker. Uses the user's own GitHub CLI authentication. */
export const GRAM_REPO = "ANT1OFF/gram";

export const IssueKind = Schema.Literals(["bug", "feature", "question"]);
export type IssueKind = typeof IssueKind.Type;

/** The part of the app an issue is about; each is also a label on the repo. */
export const IssueArea = Schema.Literals(["web", "desktop", "server", "agents"]);
export type IssueArea = typeof IssueArea.Type;

/** The repo's existing label for each kind. Labels are never created. */
export const ISSUE_KIND_LABELS: Readonly<Record<IssueKind, string>> = {
  bug: "bug",
  feature: "enhancement",
  question: "question",
};

/** An issue as written, before redaction and the diagnostics footer. */
export const IssueDraft = Schema.Struct({
  kind: IssueKind,
  title: Schema.String.check(Schema.isMinLength(1)),
  /** Markdown. */
  body: Schema.String,
  area: Schema.optionalKey(IssueArea),
  includeDiagnostics: Schema.Boolean,
  /** The thread the user is looking at, whose agent and model the diagnostics name. */
  threadId: Schema.optionalKey(ThreadId),
});
export type IssueDraft = typeof IssueDraft.Type;

/** `issues.preview`: exactly what `issues.file` would post for the same draft. */
export const ComposedIssue = Schema.Struct({
  /** `owner/repo`. */
  repo: Schema.String,
  labels: Schema.Array(Schema.String),
  title: Schema.String,
  /** The body as posted: redacted, home paths as `~`, and the diagnostics footer when included. */
  body: Schema.String,
  /** The footer on its own, as it appears at the end of `body`; absent without diagnostics. */
  diagnostics: Schema.optionalKey(Schema.String),
  /** GitHub's new-issue page with all of the above filled in, for when `gh` can't file it. */
  newIssueUrl: Schema.String,
});
export type ComposedIssue = typeof ComposedIssue.Type;

export const FiledIssue = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
});
export type FiledIssue = typeof FiledIssue.Type;

/**
 * Longest body GitHub's new-issue page is given in its URL: longer URLs are refused, so the rest is
 * cut and marked.
 */
const URL_BODY_LIMIT = 6000;

/** GitHub's new-issue page for `repo`, pre-filled with the title, body and labels. */
export const newIssueUrl = (issue: {
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly labels: ReadonlyArray<string>;
}): string => {
  const body =
    issue.body.length > URL_BODY_LIMIT
      ? `${issue.body.slice(0, URL_BODY_LIMIT)}\n\n…(cut to fit the link)`
      : issue.body;
  const query = new URLSearchParams({ title: issue.title, body, labels: issue.labels.join(",") });
  return `https://github.com/${issue.repo}/issues/new?${query.toString()}`;
};
