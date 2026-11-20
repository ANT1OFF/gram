// Whether a headless server's GitHub route reaches a repository, asked before a clone is filed.
//
// A headless server files a clone's origin and reaches nothing (`projects.clone`): the machine a
// thread is placed on clones it later. A repository the route can't reach would then fail only
// there, long after the person who added it moved on. So, where `gh` goes through the route
// (`github-relay.ts`), the clone asks GitHub for the repository first, as any `gh api` would, and
// a refusal is the clone's: what the route or GitHub said, and where to put it right when the
// route says (`help_url`, `help_label` beside GitHub's `message`).
//
// Only a refusal refuses. A route that is down, slow or answers something else says nothing about
// the repository, and the clone is filed as before.

import { splitGhInclude, type ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";

/** Why the route won't reach a repository, and where the person can change that. */
export interface RouteRefusal {
  readonly message: string;
  readonly help?: { readonly url: string; readonly label: string };
}

/** What the clone waits for the answer: past it, the clone is filed without one. */
export const ROUTE_REACH_TIMEOUT_MS = 10_000;
/** The answers that say the repository can't be had: GitHub's own for one it won't show. */
const REFUSED = new Set([401, 403, 404, 451]);
const MAX_MESSAGE = 300;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() !== ""
    ? value.trim().replace(/\s+/g, " ").slice(0, max)
    : undefined;

/** A page the person can open: https only, and no credential in it. */
const helpUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

/** The status a `gh api --include` answer opens with, e.g. `HTTP/2.0 404 Not Found`. */
const statusOf = (stdout: string): number | undefined => {
  const match = /^HTTP\/[\d.]+ (\d{3})/.exec(stdout);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

/** The refusal in a `gh api --include` answer, or undefined for any other answer. */
export const routeRefusalOf = (stdout: string): RouteRefusal | undefined => {
  const status = statusOf(stdout);
  if (status === undefined || !REFUSED.has(status)) return undefined;
  const { body } = splitGhInclude(stdout);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const fields = typeof parsed === "object" && parsed !== null ? parsed : {};
  const message =
    text(Reflect.get(fields, "message"), MAX_MESSAGE) ??
    (status === 404 ? "Not Found" : `refused (HTTP ${status})`);
  const url = helpUrl(Reflect.get(fields, "help_url"));
  if (url === undefined) return { message };
  const label = text(Reflect.get(fields, "help_label"), 80) ?? "How to fix this";
  return { message, help: { url, label } };
};

/**
 * Asks the route for `owner/repo`: the refusal when it won't reach it, undefined when it does or
 * when it gave no answer that says.
 */
export const routeRefusal = (
  proc: ProcShape,
  cwd: string,
  owner: string,
  repo: string,
): Effect.Effect<RouteRefusal | undefined> =>
  proc
    .run(
      "gh",
      ["api", `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, "--include"],
      { cwd, timeoutMs: ROUTE_REACH_TIMEOUT_MS },
    )
    .pipe(
      Effect.map((out) => (out.status === 0 ? undefined : routeRefusalOf(out.stdout))),
      Effect.orElseSucceed(() => undefined),
    );
