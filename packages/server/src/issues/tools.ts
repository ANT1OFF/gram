import { AppToolError, IssueArea, IssueKind, type ComposedIssue } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { defineAppTool } from "../app-tools/definition.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { IssueReporter, MAX_ISSUE_HITS } from "./reporter.ts";

const describeIssue = (issue: ComposedIssue): string =>
  `File “${issue.title}” on ${issue.repo} (${issue.labels.join(", ")})`;

/**
 * `report_issue` and `search_issues`: an agent in any harness can check Gram's tracker for
 * a duplicate and file a bug, feature request or question on it.
 */
export const IssueAppToolsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* AppToolRegistry;
    const reporter = yield* IssueReporter;

    const reportIssue = defineAppTool({
      descriptor: {
        name: "report_issue",
        class: "outward",
        description:
          "File an issue about Gram itself (this app, not the user's project) on its GitHub repo: a bug, a feature request or a question. File only what the user asked for or clearly wants, and search_issues first so you don't file a duplicate. Write it concretely. Leave out secrets, private code and anything from the conversation the user wouldn't post. For a failure, quote read_app_logs lines as evidence. With includeDiagnostics (the default) a footer names the Gram version, OS, agent and model. The user sees the exact text on a card and approves every call.",
      },
      input: Schema.Struct({
        kind: IssueKind,
        title: Schema.NonEmptyString,
        /** Markdown. */
        body: Schema.String,
        area: Schema.optionalKey(IssueArea),
        includeDiagnostics: Schema.optionalKey(Schema.Boolean),
      }),
      alwaysAsks: true,
      approvalReach: "deployment",
      resolve: (threadId, { includeDiagnostics = true, ...text }) =>
        reporter.compose(text, { filer: "agent", diagnostics: includeDiagnostics, threadId }),
      describe: (_threadId, issue) => Effect.succeed(describeIssue(issue)),
      cardDetails: ({ repo, labels, title, body }) => ({ repo, labels, title, body }),
      handle: (_threadId, issue) =>
        reporter.file(issue).pipe(
          Effect.mapError(
            (error) =>
              new AppToolError({
                tool: "report_issue",
                message: `${error.message}. The user can file it by hand from ${issue.newIssueUrl}`,
              }),
          ),
        ),
    });

    const searchIssues = defineAppTool({
      descriptor: {
        name: "search_issues",
        class: "read",
        description: `Search the open issues on Gram's GitHub repo, to check for a duplicate before report_issue. Returns up to ${MAX_ISSUE_HITS}: number, title, state and URL.`,
      },
      input: Schema.Struct({
        query: Schema.NonEmptyString,
        limit: Schema.optionalKey(Schema.Int),
      }),
      handle: (_threadId, { query, limit }) =>
        reporter.search(query, limit).pipe(
          Effect.map((issues) => ({ issues })),
          Effect.mapError(
            (error) => new AppToolError({ tool: "search_issues", message: error.message }),
          ),
        ),
    });

    yield* registry.register([reportIssue, searchIssues]);
  }),
);
