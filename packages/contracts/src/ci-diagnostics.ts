import * as Schema from "effect/Schema";

/** A selected Actions job. No URL or repository supplied by a client is used as an API endpoint. */
export const CiDiagnosticSelection = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  headOid: Schema.String,
  runId: Schema.String,
  jobId: Schema.String,
  attempt: Schema.optionalKey(Schema.Int),
  includeLog: Schema.optionalKey(Schema.Boolean),
});
export type CiDiagnosticSelection = typeof CiDiagnosticSelection.Type;

export const CiJobDiagnostic = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  headOid: Schema.String,
  runId: Schema.String,
  attempt: Schema.Int,
  jobId: Schema.String,
  name: Schema.String,
  link: Schema.String,
  status: Schema.String,
  conclusion: Schema.optionalKey(Schema.String),
  runner: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.String),
  completedAt: Schema.optionalKey(Schema.String),
  failingStep: Schema.optionalKey(Schema.String),
  explanation: Schema.String,
  /** Redacted, bounded evidence only; never a complete job log. */
  evidence: Schema.Array(
    Schema.Struct({ source: Schema.Literals(["annotation", "log"]), text: Schema.String }),
  ),
  note: Schema.optionalKey(Schema.String),
});
export type CiJobDiagnostic = typeof CiJobDiagnostic.Type;

/** Only github.com Actions job links, with no credentials, query or fragment. */
export function actionsJobSelection(
  link: string,
  repo: string,
): { runId: string; jobId: string } | undefined {
  try {
    const url = new URL(link);
    if (
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return;
    const path = url.pathname.toLowerCase();
    const prefix = `/${repo.toLowerCase()}/`;
    if (!path.startsWith(prefix)) return;
    const match =
      /^(?:actions\/runs\/(\d+)(?:\/attempts\/\d+)?\/job\/(\d+)|runs\/(\d+)\/jobs\/(\d+))\/?$/.exec(
        path.slice(prefix.length),
      );
    return match ? { runId: match[1] ?? match[3]!, jobId: match[2] ?? match[4]! } : undefined;
  } catch {
    return;
  }
}
