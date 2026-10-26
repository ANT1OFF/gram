import type { IssueDraft } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { Handlers } from "../rpc/handlers/common.ts";
import { IssueReporter } from "./reporter.ts";

/** `issues.preview` and `issues.file`: the in-app form, down the same path as `report_issue`. */
export const issueHandlers = Effect.gen(function* () {
  const reporter = yield* IssueReporter;
  const compose = ({ includeDiagnostics, threadId, ...text }: IssueDraft) =>
    reporter.compose(text, { filer: "user", diagnostics: includeDiagnostics, threadId });

  return {
    "issues.preview": compose,
    "issues.file": (draft) => compose(draft).pipe(Effect.flatMap(reporter.file)),
  } satisfies Partial<Handlers>;
});
