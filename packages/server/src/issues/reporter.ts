// The one path to Gram's issue tracker, for the `report_issue` tool and the in-app form
// alike. Everything goes through the user's own `gh` over REST, so the GitHub token never enters
// this process and the scarce GraphQL allowance isn't spent (D-GH-1).

import { homedir, release, type as osType } from "node:os";
import {
  GitError,
  GRAM_REPO,
  type ComposedIssue,
  type FiledIssue,
  type ThreadId,
} from "@gram/contracts";
import { ghApi, gitFailMsg, Proc } from "@gram/git";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { LaunchChecksCache } from "../launch-checks/handler.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { DEV_VERSION } from "../rpc/handlers/app.ts";
import {
  composeIssue,
  confineIssueQuery,
  parseFiledIssue,
  parseIssueSearch,
  type IssueDiagnostics,
  type IssueFiler,
  type IssueHit,
  type IssueText,
} from "./compose.ts";

/** Most hits `search` returns. */
export const MAX_ISSUE_HITS = 10;

export interface IssueReporterShape {
  /**
   * The issue as it would be posted. With `diagnostics`, the footer names `threadId`'s agent and
   * model when there is one.
   */
  readonly compose: (
    text: IssueText,
    options: {
      readonly filer: IssueFiler;
      readonly diagnostics: boolean;
      readonly threadId?: ThreadId | undefined;
    },
  ) => Effect.Effect<ComposedIssue>;
  /** Posts `issue` as composed, through `gh api`. */
  readonly file: (issue: ComposedIssue) => Effect.Effect<FiledIssue, GitError>;
  /** Open issues on the repo matching `query`, most relevant first. */
  readonly search: (
    query: string,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<IssueHit>, GitError>;
}

export class IssueReporter extends Context.Service<IssueReporter, IssueReporterShape>()(
  "@gram/server/IssueReporter",
) {
  static readonly layer: Layer.Layer<IssueReporter, never, Proc | ServerConfig | ThreadStore> =
    Layer.effect(
      IssueReporter,
      Effect.gen(function* () {
        const proc = yield* Proc;
        const config = yield* ServerConfig;
        const store = yield* ThreadStore;
        // Absent in test layers, where the footer just goes without the agent's version.
        const checks = Option.getOrUndefined(yield* Effect.serviceOption(LaunchChecksCache));
        const home = homedir();
        // gh is always told the repo, so the folder it runs in doesn't matter.
        const run = (args: ReadonlyArray<string>, stdin?: string) =>
          ghApi(home, args, { timeoutMs: 30_000, ...(stdin === undefined ? {} : { stdin }) }).pipe(
            Effect.provideService(Proc, proc),
            Effect.mapError(
              (error) => new GitError({ message: `gh couldn't reach GitHub: ${error.message}` }),
            ),
          );

        const diagnosticsFor = (filer: IssueFiler, threadId: ThreadId | undefined) =>
          Effect.gen(function* () {
            const thread =
              threadId === undefined
                ? undefined
                : yield* store.getThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
            const kind = thread?.model.agent;
            const tools =
              kind === undefined || checks === undefined ? [] : (yield* checks.get(false)).tools;
            const version = tools.find((tool) => tool.tool === kind)?.version;
            const info: IssueDiagnostics = {
              version: config.appVersion ?? DEV_VERSION,
              os: `${osType()} ${release()} (${process.platform} ${process.arch})`,
              ...(thread === undefined
                ? {}
                : { agent: { kind: thread.model.agent, version, model: thread.model.model } }),
              filer,
            };
            return info;
          });

        return IssueReporter.of({
          compose: (text, { filer, diagnostics, threadId }) =>
            Effect.gen(function* () {
              const info = diagnostics ? yield* diagnosticsFor(filer, threadId) : undefined;
              return composeIssue(text, info, home);
            }),

          file: (issue) =>
            Effect.gen(function* () {
              const payload = JSON.stringify({
                title: issue.title,
                body: issue.body,
                labels: issue.labels,
              });
              // The body goes on stdin: no argument length limit, and no `@file` reading of a value.
              const out = yield* run(
                [`repos/${issue.repo}/issues`, "--method", "POST", "--input", "-"],
                payload,
              );
              const filed = out.status === 0 ? parseFiledIssue(out.stdout) : undefined;
              if (filed === undefined) {
                return yield* new GitError({
                  message: gitFailMsg(out, "gh couldn't file the issue"),
                  command: "gh api issues",
                });
              }
              return filed;
            }),

          search: (query, limit = MAX_ISSUE_HITS) =>
            Effect.gen(function* () {
              const capped = Math.max(1, Math.min(limit, MAX_ISSUE_HITS));
              const out = yield* run([
                "search/issues",
                "--method",
                "GET",
                "-f",
                `q=repo:${GRAM_REPO} is:issue is:open ${confineIssueQuery(query)}`,
                "-f",
                `per_page=${capped}`,
              ]);
              if (out.status !== 0) {
                return yield* new GitError({
                  message: gitFailMsg(out, "gh couldn't search the issues"),
                  command: "gh api search/issues",
                });
              }
              return parseIssueSearch(out.stdout, capped, GRAM_REPO);
            }),
        });
      }),
    );
}
