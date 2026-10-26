import {
  ISSUE_KIND_LABELS,
  newIssueUrl,
  GRAM_REPO,
  type ComposedIssue,
  type IssueDraft,
} from "@gram/contracts";

/** The mock's stand-in for the server's composing: labels, the footer, the link. No redaction. */
export function composeMockIssue(draft: IssueDraft, version: string): ComposedIssue {
  const labels = [ISSUE_KIND_LABELS[draft.kind], ...(draft.area === undefined ? [] : [draft.area])];
  const title = draft.title.replace(/\s+/g, " ").trim();
  const written = draft.body.trimEnd();
  const footer = draft.includeDiagnostics
    ? [
        "**Diagnostics**",
        "",
        `- Gram ${version}`,
        "- Darwin 25.0.0 (darwin arm64)",
        ...(draft.threadId === undefined ? [] : ["- Agent: claude 2.1.273, model opus"]),
        "- Filed from Gram by the user",
      ].join("\n")
    : undefined;
  const body =
    footer === undefined ? written : written === "" ? footer : `${written}\n\n---\n\n${footer}`;
  return {
    repo: GRAM_REPO,
    labels,
    title,
    body,
    ...(footer === undefined ? {} : { diagnostics: footer }),
    newIssueUrl: newIssueUrl({ repo: GRAM_REPO, title, body, labels }),
  };
}
