#!/usr/bin/env node
// A stand-in `gh` for the real-server e2e flows. It answers the invocations Gram makes from a
// JSON state file (`FAKE_GH_STATE`), so specs can open a PR, review it, rerun its checks, merge it
// and flip its checks without GitHub.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);

const load = () => JSON.parse(readFileSync(statePath, "utf8"));
const save = (state) => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
/** A `-f name=value` or `-F name=value` field. */
const fields = (name) =>
  args
    .filter((_, i) => args[i - 1] === "-f" || args[i - 1] === "-F")
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const out = (value) =>
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8" }).trim();

/** Each PR's CI runs as one GitHub Actions run, so "Rerun failed" has a run id to rerun. */
const runIdOf = (pr) => String(9000 + pr.number);

/** A check context in GraphQL's shape, from the fixture's `pending | failing | passing`. */
const context = (state, pr) => {
  const detailsUrl = `https://github.com/${state.repo}/actions/runs/${runIdOf(pr)}/job/1`;
  return pr.checks === "pending"
    ? { __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null, detailsUrl }
    : {
        __typename: "CheckRun",
        name: "test",
        status: "COMPLETED",
        conclusion: pr.checks === "failing" ? "FAILURE" : "SUCCESS",
        detailsUrl,
      };
};

const urlOf = (state, pr) => `https://github.com/${state.repo}/pull/${pr.number}`;
const reviewsOf = (pr) => pr.reviews ?? [];
const threadsOf = (pr) => pr.threads ?? [];
const issueCommentsOf = (pr) => pr.issueComments ?? [];

/** `gh pr list --json` / reshaped GraphQL node. */
const listed = (state, pr) => ({
  number: pr.number,
  state: pr.state,
  url: urlOf(state, pr),
  isDraft: pr.draft,
  headRefOid: pr.headRefOid,
  title: pr.title,
  baseRefName: pr.base,
  updatedAt: pr.updatedAt,
  statusCheckRollup: [context(state, pr)],
});

/** Every fixture PR is the e2e user's, so their own reviews are never a person's verdict. */
const PR_AUTHOR = { login: "e2e" };

/** A PullRequest node for the batched badge query. */
const node = (state, pr) => ({
  number: pr.number,
  state: pr.state,
  url: urlOf(state, pr),
  author: PR_AUTHOR,
  isDraft: pr.draft,
  headRefOid: pr.headRefOid,
  title: pr.title,
  baseRefName: pr.base,
  updatedAt: pr.updatedAt,
  mergeStateStatus: pr.mergeState ?? "CLEAN",
  baseRef: { target: { oid: "" } },
  commits: {
    nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [context(state, pr)] } } } }],
  },
  reviews: { nodes: reviewsOf(pr) },
  reviewThreads: {
    nodes: threadsOf(pr).map((thread) => ({
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      comments: { nodes: thread.comments.slice(0, 3) },
    })),
  },
  comments: { nodes: issueCommentsOf(pr) },
});

/** The Review tab's pull request, with threads and their comments. */
const reviewNode = (state, pr) => ({
  number: pr.number,
  url: urlOf(state, pr),
  state: pr.state,
  viewerDidAuthor: true,
  author: PR_AUTHOR,
  headRefOid: pr.headRefOid,
  reviewDecision: "",
  mergeStateStatus: pr.mergeState ?? "CLEAN",
  reviews: { nodes: reviewsOf(pr) },
  reviewThreads: {
    nodes: threadsOf(pr).map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      line: thread.line ?? null,
      startLine: thread.startLine ?? null,
      comments: { nodes: thread.comments },
    })),
  },
  comments: { nodes: issueCommentsOf(pr) },
});

/** Finds the PR and thread for a review thread id, and saves after `update`. */
const withThread = (threadId, update) => {
  const state = load();
  for (const pr of state.prs) {
    const thread = threadsOf(pr).find((t) => t.id === threadId);
    if (thread) {
      const result = update(thread, pr);
      pr.updatedAt = new Date().toISOString();
      save(state);
      return result;
    }
  }
  return fail(`fake gh: no review thread ${threadId}`);
};

const [command, sub] = args;

if (command === "--version") {
  out("gh version 2.99.0 (fake)");
} else if (command === "auth" && sub === "status") {
  out("github.com\n  ✓ Logged in to github.com account e2e (fake)");
} else if (command === "repo" && sub === "clone") {
  // `gh repo clone <owner/repo> <dir>`: the local bare origin stands in for GitHub, spelled as the
  // harness's own checkout has it, so the clone's `origin` names the repository it came from.
  const state = load();
  const [, , slug, dir] = args;
  if (slug !== state.repo)
    fail(`GraphQL: Could not resolve to a Repository with the name '${slug}'.`);
  git("clone", "-q", state.origin, dir);
  git("-C", dir, "remote", "set-url", "origin", `git@github.com:${slug}.git`);
  git("-C", dir, "config", `url.${state.origin}.insteadOf`, `git@github.com:${slug}.git`);
} else if (command === "repo" && sub === "view") {
  const state = load();
  const settings = {
    squashMergeAllowed: true,
    mergeCommitAllowed: false,
    rebaseMergeAllowed: true,
  };
  const requested = (flag("--json") ?? "").split(",");
  const supported = new Set(["nameWithOwner", ...Object.keys(settings)]);
  const unknown = requested.find((field) => !supported.has(field));
  if (unknown !== undefined) fail(`Unknown JSON field: "${unknown}"`);
  if (requested.some((field) => Object.hasOwn(settings, field))) {
    out(Object.fromEntries(requested.map((field) => [field, settings[field] ?? state.repo])));
  } else {
    out(state.repo);
  }
} else if (command === "api" && sub === `repos/${load().repo}`) {
  out(flag("--jq") === ".allow_auto_merge" ? "true" : { allow_auto_merge: true });
} else if (command === "api" && sub === "graphql") {
  const query = fields("query") ?? "";
  if (query.includes("e0:repository(")) {
    // The batched badge document: block `i` is a branch's PRs (`b<i>`) or one PR by number (`p<i>`).
    const state = load();
    const data = {};
    for (let i = 0; fields(`o${i}`) !== undefined; i++) {
      const branch = fields(`b${i}`);
      if (branch !== undefined) {
        const nodes = state.prs.filter((pr) => pr.branch === branch).map((pr) => node(state, pr));
        data[`e${i}`] = { pullRequests: { nodes } };
      } else {
        const pr = state.prs.find((p) => p.number === Number(fields(`p${i}`)));
        data[`e${i}`] = { pullRequest: pr ? node(state, pr) : null };
      }
    }
    out({ data });
  } else if (query.includes("detailsUrl") && fields("p") !== undefined) {
    // One PR's checks by name: what "Rerun failed" and the CI-failure notices read.
    const state = load();
    const pr = state.prs.find((p) => p.number === Number(fields("p")));
    const commits = pr && {
      nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [context(state, pr)] } } } }],
    };
    out({ data: { repository: { pullRequest: pr ? { commits } : null } } });
  } else if (query.includes("pullRequests(states:OPEN")) {
    // The repo's open PRs by head branch, for the "PR on another worktree" cue.
    const state = load();
    const nodes = state.prs
      .filter((pr) => pr.state === "OPEN")
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: urlOf(state, pr),
        headRefName: pr.branch,
        isCrossRepository: false,
      }));
    out({ data: { repository: { pullRequests: { nodes } } } });
  } else if (query.includes("pullRequest(number:")) {
    const state = load();
    const pr = state.prs.find((p) => p.number === Number(fields("num")));
    out({ data: { repository: { pullRequest: pr ? reviewNode(state, pr) : null } } });
  } else if (query.includes("addPullRequestReviewThreadReply")) {
    const comment = withThread(fields("t"), (thread) => {
      const reply = {
        id: `C_${thread.id}_${thread.comments.length + 1}`,
        author: { login: "e2e", __typename: "User" },
        body: fields("b") ?? "",
        createdAt: new Date().toISOString(),
        url: `https://github.com/acme/web/pull/1#discussion_${thread.id}_${thread.comments.length + 1}`,
      };
      thread.comments.push(reply);
      return reply;
    });
    out({ data: { addPullRequestReviewThreadReply: { comment } } });
  } else if (query.includes("resolveReviewThread")) {
    const thread = withThread(fields("t"), (t) => {
      t.isResolved = true;
      return { id: t.id, isResolved: true };
    });
    out({ data: { resolveReviewThread: { thread } } });
  } else {
    out({ data: {} });
  }
} else if (command === "api" && /\/issues\/\d+\/comments$/.test(sub ?? "")) {
  const state = load();
  const pr = state.prs.find((p) => p.number === Number(/\/issues\/(\d+)\//.exec(sub)[1]));
  if (!pr) fail(`fake gh: no PR for ${sub}`);
  pr.issueComments = [
    ...issueCommentsOf(pr),
    {
      id: `IC_${Date.now()}`,
      author: { login: "e2e" },
      body: fields("body") ?? "",
      createdAt: new Date().toISOString(),
    },
  ];
  save(state);
  out("{}");
} else if (command === "api" && (sub ?? "").startsWith("user/repos")) {
  // Clone suggestions, `--jq .[].full_name`'d: the one repository there is.
  out(load().repo);
} else if (command === "api") {
  out("[]");
} else if (command === "run" && sub === "rerun") {
  // `gh run rerun <run id> --failed --repo <slug>`: the run's failed jobs start again.
  const state = load();
  const runId = args[2];
  const pr = state.prs.find((p) => runIdOf(p) === runId);
  if (!pr) fail(`could not find any workflow run with ID ${runId}`);
  pr.reruns = [...(pr.reruns ?? []), runId];
  pr.checks = "pending";
  pr.updatedAt = new Date().toISOString();
  save(state);
  out("");
} else if (command === "pr" && sub === "merge") {
  // `gh pr merge <n> --squash|--merge|--rebase [--auto] --repo <slug>`.
  const state = load();
  const pr = state.prs.find((p) => p.number === Number(args[2]));
  if (!pr) fail(`no pull requests found for #${args[2]}`);
  if (pr.state !== "OPEN") fail(`Pull request ${state.repo}#${pr.number} is not open`);
  pr.mergeMethod = args.includes("--squash")
    ? "squash"
    : args.includes("--rebase")
      ? "rebase"
      : "merge";
  if (args.includes("--auto")) {
    pr.autoMerge = true;
  } else {
    pr.state = "MERGED";
  }
  pr.updatedAt = new Date().toISOString();
  save(state);
  out(pr.autoMerge ? "" : `✓ Merged pull request ${state.repo}#${pr.number}`);
} else if (command === "pr" && sub === "list") {
  const state = load();
  const head = flag("--head");
  out(state.prs.filter((pr) => pr.branch === head).map((pr) => listed(state, pr)));
} else if (command === "pr" && sub === "view") {
  const state = load();
  const pr = state.prs.find((p) => p.number === Number(args[2]));
  if (!pr) fail(`no pull requests found for #${args[2]}`);
  out({
    ...listed(state, pr),
    body: pr.body,
    author: { login: "e2e" },
    headRefName: pr.branch,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    commits: [],
    reviews: [],
    reviewDecision: "",
    comments: [],
    reviewRequests: [],
    latestReviews: [],
    labels: [],
  });
} else if (command === "pr" && sub === "diff") {
  out("");
} else if (command === "pr" && sub === "create") {
  const state = load();
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (state.prs.some((pr) => pr.branch === branch && pr.state === "OPEN")) {
    fail(`a pull request for branch "${branch}" into branch "${flag("--base")}" already exists`);
  }
  const body = args.includes("--body-file") ? readFileSync(0, "utf8") : (flag("--body") ?? "");
  const pr = {
    number: state.nextNumber,
    branch,
    headRefOid: git("rev-parse", "HEAD"),
    title: flag("--title") ?? "",
    body,
    base: flag("--base") ?? "main",
    draft: args.includes("--draft"),
    state: "OPEN",
    checks: "pending",
    mergeState: "CLEAN",
    updatedAt: new Date().toISOString(),
    reviews: [],
    threads: [],
    issueComments: [],
  };
  state.prs.push(pr);
  state.nextNumber += 1;
  save(state);
  out(urlOf(state, pr));
} else {
  fail(`fake gh: unsupported invocation: ${args.slice(0, 3).join(" ")}`);
}
