// Review-bot output parsing. The bot's format is undocumented, so everything format-specific lives
// here and degrades to "unknown" instead of failing: untagged findings, missing meta, unfamiliar
// progress comments.

import { HUMAN_REVIEW_BODY_CHARS, isBotLogin, matchesBotLogin } from "@gram/contracts";
import type {
  BotReview,
  HumanReview,
  PrReviewState,
  ReviewBot,
  ReviewComment,
  ReviewMeta,
  ReviewSeverity,
  ReviewThread,
  ReviewVerdict,
} from "@gram/contracts";

type Json = Record<string, unknown>;

const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const arr = (value: unknown): Array<Json> => (Array.isArray(value) ? value.filter(isJson) : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const at = (value: unknown, path: ReadonlyArray<string | number>): unknown => {
  let current = value;
  for (const key of path) {
    if (typeof key === "number") current = Array.isArray(current) ? current[key] : undefined;
    else current = isJson(current) ? current[key] : undefined;
  }
  return current;
};
const login = (node: Json): string => str(at(node, ["author", "login"]));

const normaliseLogin = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/, "");

// The matching moved to contracts, where the web app and the helper's PR context read it too.
export { isBotLogin, matchesBotLogin } from "@gram/contracts";

const TAG = /^\s*(?:\*\*|`)?\[(blocker|suggestion|still outstanding)\](?:\*\*|`)?/i;

/** The severity tag a comment opens with, or `undefined` when untagged. */
export const parseSeverity = (body: string): ReviewSeverity | undefined => {
  const tag = TAG.exec(body)?.[1]?.toLowerCase();
  if (tag === "blocker") return "blocker";
  if (tag === "suggestion") return "suggestion";
  if (tag === "still outstanding" || /^\s*still outstanding:/i.test(body)) return "outstanding";
  return undefined;
};

/** A thread's severity: the first tag across its bot comments, else `finding`. */
export const threadSeverity = (bodies: ReadonlyArray<string>): ReviewSeverity => {
  for (const body of bodies) {
    const severity = parseSeverity(body);
    if (severity !== undefined) return severity;
  }
  return "finding";
};

const META_OPEN = /<!--\s*code-review-meta:/g;

/**
 * Every `<!-- code-review-meta: … -->` comment in `body`, as offsets. The close is found with
 * `indexOf` rather than a lazy `[\s\S]*?-->` in the pattern: that rescans to the end of the body
 * from each opening, which is quadratic in a body that opens the comment many times and never
 * closes it, and the body is whatever a PR's reviewer wrote.
 */
const metaSpans = (body: string) => {
  const spans: Array<{ start: number; contentStart: number; contentEnd: number; end: number }> = [];
  const open = new RegExp(META_OPEN);
  for (let match = open.exec(body); match !== null; match = open.exec(body)) {
    const contentStart = match.index + match[0].length;
    const contentEnd = body.indexOf("-->", contentStart);
    // Nothing after this point closes either.
    if (contentEnd === -1) break;
    spans.push({ start: match.index, contentStart, contentEnd, end: contentEnd + 3 });
    open.lastIndex = contentEnd + 3;
  }
  return spans;
};
const META_KEYS = ["model", "effort", "strictness", "scope"] as const;

/** The `<!-- code-review-meta: key=value … -->` fields, or `undefined` without a meta comment. */
export const parseMeta = (body: string): ReviewMeta | undefined => {
  const span = metaSpans(body)[0];
  if (span === undefined) return undefined;
  const content = body.slice(span.contentStart, span.contentEnd);
  const pairs = new Map<string, string>();
  for (const token of content.trim().split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq > 0) pairs.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const meta: Record<string, string> = {};
  for (const key of META_KEYS) {
    const value = pairs.get(key);
    if (value !== undefined && value !== "") meta[key] = value;
  }
  return meta;
};

export const stripMeta = (body: string): string => {
  let kept = "";
  let from = 0;
  for (const span of metaSpans(body)) {
    kept += body.slice(from, span.start);
    from = span.end;
  }
  return (kept + body.slice(from)).trim();
};

/** The text of the first ```suggestion block; `""` means "delete these lines". */
export const extractSuggestion = (body: string): string | undefined => {
  const match = /```suggestion[^\n]*\n([\s\S]*?)```/.exec(body);
  if (match === undefined || match === null) return undefined;
  return (match[1] ?? "").replace(/\n$/, "");
};

/**
 * Whether the bot's latest progress comment says a round is running: the `Reviewing...` spinner
 * image, or the "Responding to comment..." placeholder that is later edited into an answer.
 */
export const isRoundInFlight = (
  comments: ReadonlyArray<Json>,
  bots: ReadonlyArray<ReviewBot>,
): boolean => {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]!;
    if (!isBotLogin(bots, login(comment))) continue;
    const body = str(comment["body"]);
    const progress = /###\s*Code review/i.test(body) || /Responding to comment/i.test(body);
    if (!progress) continue;
    return /alt="Reviewing\.\.\."/i.test(body) || /_Responding to comment\.\.\._/i.test(body);
  }
  return false;
};

export const verdictOf = (state: string): ReviewVerdict | undefined => {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changesRequested";
    case "COMMENTED":
      return "commented";
    default:
      return undefined;
  }
};

/** Bot reviews with a summary body; empty-body reviews are GitHub's wrappers around thread replies. */
const summaryReviews = (node: Json, bots: ReadonlyArray<ReviewBot>) =>
  arr(at(node, ["reviews", "nodes"])).filter(
    (r) => isBotLogin(bots, login(r)) && str(r["body"]).trim() !== "" && r["state"] !== "PENDING",
  );

const threadComments = (thread: Json) => arr(at(thread, ["comments", "nodes"]));

const startedByBot = (thread: Json, bots: ReadonlyArray<ReviewBot>) => {
  const first = threadComments(thread)[0];
  return first !== undefined && isBotLogin(bots, login(first));
};

/**
 * Each person's standing verdict, oldest first: their latest review that approved, requested changes
 * or was dismissed, kept unless dismissed. A comment-only review leaves the verdict before it standing,
 * as GitHub does. Configured bots, GitHub App accounts and `author` are not people here.
 */
export const humanReviewsOf = (
  node: Json,
  bots: ReadonlyArray<ReviewBot>,
  author: string,
): Array<HumanReview> => {
  const latest = new Map<string, Json>();
  for (const review of arr(at(node, ["reviews", "nodes"]))) {
    const who = login(review);
    const state = review["state"];
    if (
      who === "" ||
      normaliseLogin(who) === normaliseLogin(author) ||
      at(review, ["author", "__typename"]) === "Bot" ||
      isBotLogin(bots, who) ||
      (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED")
    )
      continue;
    latest.delete(who);
    latest.set(who, review);
  }
  return [...latest.values()].flatMap((review): Array<HumanReview> => {
    const verdict = verdictOf(str(review["state"]));
    if (verdict !== "approved" && verdict !== "changesRequested") return [];
    const body = str(review["body"]).trim();
    return [
      {
        id: str(review["id"]),
        author: login(review),
        verdict,
        commitOid: str(at(review, ["commit", "oid"])),
        submittedAt: str(review["submittedAt"]),
        body:
          body.length > HUMAN_REVIEW_BODY_CHARS
            ? `${body.slice(0, HUMAN_REVIEW_BODY_CHARS)}…`
            : body,
      },
    ];
  });
};

/**
 * Review state from a PullRequest node carrying `headRefOid`, `reviews`, `reviewThreads` and
 * `comments`: the bots' verdicts and counts, plus people's unresolved threads and standing verdicts.
 * `undefined` when no configured bot reviewed, commented or started a thread, and no person has a
 * thread open or a verdict standing. `author` is the PR's, whose own reviews are nobody's verdict.
 */
export const buildReviewState = (
  node: Json,
  bots: ReadonlyArray<ReviewBot>,
  author = "",
): PrReviewState | undefined => {
  const head = str(node["headRefOid"]);
  const allReviews = arr(at(node, ["reviews", "nodes"])).filter((r) => isBotLogin(bots, login(r)));
  const summaries = summaryReviews(node, bots);
  const threads = arr(at(node, ["reviewThreads", "nodes"]));
  const botThreads = threads.filter((t) => startedByBot(t, bots));
  // A person's thread: started by neither a configured bot nor any GitHub App account.
  const humanUnresolved = threads.filter((t) => {
    const first = threadComments(t)[0];
    return (
      first !== undefined &&
      at(first, ["author", "__typename"]) !== "Bot" &&
      !startedByBot(t, bots) &&
      t["isResolved"] !== true
    );
  }).length;
  const comments = arr(at(node, ["comments", "nodes"]));
  const botComments = comments.filter((c) => isBotLogin(bots, login(c)));
  const humanReviews = humanReviewsOf(node, bots, author);
  if (
    allReviews.length === 0 &&
    botThreads.length === 0 &&
    botComments.length === 0 &&
    humanUnresolved === 0 &&
    humanReviews.length === 0
  ) {
    return undefined;
  }

  const onHead = summaries.filter((r) => str(at(r, ["commit", "oid"])) === head);
  const approvingOnHead = onHead.filter((review) =>
    bots.some((bot) => bot.canApprove && matchesBotLogin(bot.loginPattern, login(review))),
  );
  const decisiveOnHead = approvingOnHead.toReversed().find((review) => {
    const verdict = verdictOf(str(review["state"]));
    return verdict === "approved" || verdict === "changesRequested";
  });
  const verdictOnHead =
    decisiveOnHead === undefined
      ? undefined
      : decisiveOnHead["state"] === "APPROVED"
        ? "approved"
        : "changesRequested";
  const latest = summaries.toReversed().find((r) => r["state"] !== "DISMISSED");
  const latestVerdict = latest === undefined ? undefined : verdictOf(str(latest["state"]));
  const latestId = str(summaries.at(-1)?.["id"]);

  const unresolved = botThreads.filter((t) => t["isResolved"] !== true);
  const severities = unresolved.map((t) =>
    threadSeverity(
      threadComments(t)
        .filter((c) => isBotLogin(bots, login(c)))
        .map((c) => str(c["body"])),
    ),
  );
  const logins = new Set(
    [...allReviews, ...botComments, ...botThreads.map((t) => threadComments(t)[0]!)].map(login),
  );

  return {
    bots: [...logins],
    ...(verdictOnHead === undefined
      ? {}
      : { verdictOnHead, verdictOnHeadBy: login(decisiveOnHead!) }),
    ...(latestVerdict === undefined ? {} : { latestVerdict }),
    reviewedHead: onHead.length > 0,
    roundInFlight: isRoundInFlight(comments, bots),
    ...(latestId === "" ? {} : { latestReviewId: latestId }),
    ...(summaries.length === 0 ? {} : { rounds: summaries.length }),
    threads: {
      unresolved: unresolved.length,
      blockers: severities.filter((s) => s === "blocker").length,
      suggestions: severities.filter((s) => s === "suggestion").length,
      outdatedUnresolved: unresolved.filter((t) => t["isOutdated"] === true).length,
      ...(humanUnresolved === 0 ? {} : { humanUnresolved }),
    },
    ...(humanReviews.length === 0 ? {} : { humanReviews }),
  };
};

/** The latest bot summary review, meta parsed out; dismissed approvals are skipped. */
export const buildLatestReview = (
  node: Json,
  bots: ReadonlyArray<ReviewBot>,
): BotReview | undefined => {
  const head = str(node["headRefOid"]);
  const latest = summaryReviews(node, bots)
    .toReversed()
    .find((r) => r["state"] !== "DISMISSED" && verdictOf(str(r["state"])) !== undefined);
  if (latest === undefined) return undefined;
  const body = str(latest["body"]);
  const meta = parseMeta(body);
  const commitOid = str(at(latest, ["commit", "oid"]));
  return {
    id: str(latest["id"]),
    author: login(latest),
    verdict: verdictOf(str(latest["state"]))!,
    body: stripMeta(body),
    commitOid,
    submittedAt: str(latest["submittedAt"]),
    onHead: commitOid !== "" && commitOid === head,
    ...(meta === undefined ? {} : { meta }),
  };
};

const positiveInt = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** Every review thread on the PR, bot-started or not, with parsed severity and suggestions. */
export const buildReviewThreads = (
  node: Json,
  bots: ReadonlyArray<ReviewBot>,
): Array<ReviewThread> =>
  arr(at(node, ["reviewThreads", "nodes"])).map((thread) => {
    const comments = threadComments(thread).map((c): ReviewComment => {
      const body = str(c["body"]);
      const suggestion = extractSuggestion(body);
      return {
        id: str(c["id"]),
        author: login(c),
        body,
        createdAt: str(c["createdAt"]),
        url: str(c["url"]),
        ...(suggestion === undefined ? {} : { suggestion }),
      };
    });
    const byBot = startedByBot(thread, bots);
    const line = positiveInt(thread["line"]);
    const startLine = positiveInt(thread["startLine"]);
    return {
      id: str(thread["id"]),
      path: str(thread["path"]),
      ...(line === undefined ? {} : { line }),
      ...(startLine === undefined ? {} : { startLine }),
      isResolved: thread["isResolved"] === true,
      isOutdated: thread["isOutdated"] === true,
      severity: byBot
        ? threadSeverity(comments.filter((c) => isBotLogin(bots, c.author)).map((c) => c.body))
        : "finding",
      byBot,
      comments,
    };
  });
