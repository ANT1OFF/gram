import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { startHarness, type FakeReviewComment, type Harness } from "./harness";
import { threadRow } from "../e2e/thread-row";

// A PR through review, babysit and cleanup. The flows share one server, one page and one thread.
test.describe.configure({ mode: "serial" });

const BOT = "example-code-review";
const BRANCH_NAME = "review-e2e";
const FILE = "src/greeting.ts";

let h: Harness;
let page: Page;
let threadId = "";
let worktree = "";
let head = "";

test.beforeAll(async ({ browser }) => {
  h = await startHarness();
  page = await browser.newPage();
  // This synthetic reviewer is opt-in, just like an external bot in a user's installation.
  await h.open(page, "/settings/review-bots");
  const bots = page.getByTestId("review-bots");
  await expect(
    bots.getByText("No external review bots configured.", { exact: false }),
  ).toBeVisible();
  await bots.getByRole("button", { name: "Add bot", exact: true }).click();
  await bots.getByLabel("Login pattern", { exact: true }).fill(`${BOT}[bot]`);
  await bots.getByLabel("Re-review command", { exact: true }).fill("/agent review");
  await bots.getByRole("switch", { name: "Can approve", exact: true }).check();
  await bots.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Review bots saved.", { exact: true })).toBeVisible();
});

test.afterAll(async () => {
  await page?.close();
  await h?.stop();
});

const now = () => new Date().toISOString();

const comment = (id: string, login: string, body: string): FakeReviewComment => ({
  id,
  author: { login, __typename: login === BOT ? "Bot" : "User" },
  body,
  createdAt: now(),
  url: `https://github.com/acme/web/pull/1#discussion_${id}`,
});

/** A thread on a worktree branch with its commit published and PR #1 open. */
async function threadWithPr() {
  await h.open(page, "/new");
  await page.getByRole("combobox", { name: "Project path" }).fill(h.repo);
  await expect(page.getByTestId("folder-status")).toBeVisible();
  await page
    .getByRole("radiogroup", { name: "Checkout" })
    .getByRole("radio", { name: "New worktree" })
    .click();
  await page.getByRole("textbox", { name: "Branch name" }).fill(BRANCH_NAME);
  await page.getByRole("combobox", { name: "First prompt" }).fill("Greet the reviewers");
  await page.getByRole("button", { name: "Create thread" }).click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/, { timeout: 30_000 });
  threadId = new URL(page.url()).pathname.split("/").at(-1)!;

  worktree = h.worktreeOnBranch(BRANCH_NAME);
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, FILE), 'export let greeting = "hello";\n');
  h.git(worktree, "add", "-A");
  h.git(worktree, "commit", "-qm", "Add a greeting");
  head = h.git(worktree, "rev-parse", "HEAD");

  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "PR", exact: true }).click();
  await panel.getByTestId("push-button").click();
  await expect(panel.getByTestId("push-button")).toBeHidden();
  await panel.getByTestId("create-pr-button").click();
  await page.getByTestId("create-pr-dialog").getByRole("button", { name: "Create PR" }).click();
  await expect(page.getByTestId("pane-pr-badge")).toContainText("#1");
}

test("a review round shows bot and human threads, applies a suggestion, replies and resolves", async () => {
  await threadWithPr();
  h.updatePr(1, (pr) => {
    pr.reviews = [
      {
        id: "R_1",
        author: { login: BOT },
        state: "COMMENTED",
        submittedAt: now(),
        commit: { oid: head },
        body: "### Code review\nOne suggestion.",
      },
    ];
    pr.threads = [
      {
        id: "T_bot",
        path: FILE,
        line: 1,
        startLine: null,
        isResolved: false,
        isOutdated: false,
        comments: [
          comment(
            "C_bot",
            BOT,
            '[suggestion] Nothing reassigns it.\n```suggestion\nexport const greeting = "hello";\n```',
          ),
        ],
      },
      {
        id: "T_human",
        path: FILE,
        line: 1,
        startLine: null,
        isResolved: false,
        isOutdated: false,
        comments: [comment("C_human", "octocat", "Could this greet people by name?")],
      },
    ];
  });

  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: /^Review/ }).click();
  const review = panel.getByTestId("review-panel");
  await expect(review.getByTestId("review-counts")).toContainText("1 suggestion · 1 unresolved", {
    timeout: 15_000,
  });
  await expect(review.getByTestId("review-counts-human")).toHaveText("1 reviewer thread");

  // Publishing just toasted; the toast docks below the panel, so this button is clickable now.
  const botThread = review.getByRole("article", { name: `Suggestion: ${FILE}:1` });
  await botThread.getByRole("button", { name: "Apply suggestion" }).click();
  await expect(botThread.getByText(`Applied to ${FILE}:1-1 (not committed)`)).toBeVisible();
  expect(readFileSync(join(worktree, FILE), "utf8")).toBe('export const greeting = "hello";\n');

  const humanThread = review.getByRole("article", { name: `Reviewer: ${FILE}:1` });
  await humanThread.getByRole("button", { name: "Reply…" }).click();
  await humanThread.getByRole("textbox", { name: "Reply" }).fill("It will once we have users.");
  await humanThread.getByRole("button", { name: "Send reply" }).click();
  await expect(humanThread.getByText("Reply posted")).toBeVisible();
  await humanThread.getByRole("button", { name: "Resolve" }).click();
  await expect(review.getByTestId("review-counts-human")).toBeHidden({ timeout: 15_000 });
  const human = h.prs()[0]!.threads!.find((t) => t.id === "T_human")!;
  expect(human.isResolved).toBe(true);
  expect(human.comments.at(-1)).toMatchObject({ body: "It will once we have users." });

  await panel.getByRole("tab", { name: "Diff", exact: true }).click();
  await expect(panel.getByTestId("diff-file").filter({ hasText: FILE })).toBeVisible();
});

test("babysit asks for a re-review, relays a round, then reports ready to merge", async () => {
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "PR", exact: true }).click();
  const babysit = panel.getByTestId("pr-watch");
  await babysit.getByRole("spinbutton", { name: "Max babysit rounds" }).fill("3");
  await babysit.getByRole("switch", { name: "Babysit this PR" }).click();
  await expect(
    page.getByTestId("pane-pr-badge").getByRole("img", { name: /^Babysitting/ }),
  ).toBeVisible();
  // The review already on the PR still has its suggestion thread open, so it is handed over as
  // round 0: acted on, but not counted toward the budget.
  const notices = page.getByRole("article", { name: "Review update on #1" });
  const inRound = (round: number) =>
    notices.filter({ has: page.getByText(`Round ${round}`, { exact: true }) });
  await expect(notices).toHaveCount(1, { timeout: 20_000 });
  await expect(inRound(0).getByRole("region", { name: "Suggestions" })).toContainText(`${FILE}:1`);
  await expect(babysit.getByTestId("babysit-status")).toHaveText("Watching · round 0 of 3");

  // The agent pushes the applied suggestion: a new head with green checks and no bot verdict on it.
  h.git(worktree, "commit", "-qam", "Make greeting a const");
  head = h.git(worktree, "rev-parse", "HEAD");
  const push = panel.getByTestId("pr-panel-push").getByRole("button", { name: "Push 1 commit" });
  await push.click();
  // The button reads "Pushing…" while in flight, so wait on origin rather than the label.
  await expect
    .poll(() => h.git(h.origin, "rev-parse", `refs/heads/feat/${BRANCH_NAME}`), { timeout: 15_000 })
    .toBe(head);
  await expect(panel.getByTestId("pr-panel-push")).toBeHidden();
  h.updatePr(1, (pr) => {
    pr.headRefOid = head;
    pr.checks = "passing";
  });
  // The checks settling is relayed too, in a notice of its own that uses up no round.
  await expect(inRound(0)).toHaveCount(2, { timeout: 20_000 });
  await expect(babysit.getByTestId("babysit-status")).toHaveText("Watching · round 0 of 3");
  // After the quiet window babysit posts the bot's re-review command.
  await expect
    .poll(() => h.prs()[0]!.issueComments?.map((c) => c.body) ?? [], { timeout: 20_000 })
    .toContain("/agent review");

  // The bot's round lands; after its debounce babysit relays it to the agent and counts it.
  h.updatePr(1, (pr) => {
    pr.reviews = [
      ...(pr.reviews ?? []),
      {
        id: "R_2",
        author: { login: BOT },
        state: "CHANGES_REQUESTED",
        submittedAt: now(),
        commit: { oid: head },
        body: "### Code review\nOne blocker.",
      },
    ];
    pr.threads = [
      ...(pr.threads ?? []),
      {
        id: "T_blocker",
        path: FILE,
        line: 1,
        startLine: null,
        isResolved: false,
        isOutdated: false,
        comments: [comment("C_blocker", BOT, "[blocker] Export a function, not a value.")],
      },
    ];
  });
  await expect(inRound(1)).toHaveCount(1, { timeout: 20_000 });
  await expect(inRound(1).getByTestId("notice-verdict")).toHaveText("Changes requested");
  await expect(inRound(1).getByRole("region", { name: "Blockers" })).toContainText(
    "Export a function, not a value.",
  );
  await expect(babysit.getByTestId("babysit-status")).toHaveText("Watching · round 1 of 3");

  h.updatePr(1, (pr) => {
    pr.reviews = [
      ...(pr.reviews ?? []),
      {
        id: "R_3",
        author: { login: BOT },
        state: "APPROVED",
        submittedAt: now(),
        commit: { oid: head },
        body: "### Code review\nLooks good.",
      },
    ];
  });
  await expect(babysit.getByTestId("babysit-status")).toHaveText("Done · ready to merge", {
    timeout: 20_000,
  });
  await expect(page.getByText("#1 is ready to merge")).toBeVisible();
});

test("the Worktrees dialog removes an unused worktree, and closing deletes the thread's", async () => {
  const spare = join(h.root, "spare");
  h.git(h.repo, "worktree", "add", "-q", "-b", "spare", spare);

  await h.open(page, `/t/${threadId}`);
  await expect(threadRow(page, threadId)).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">Worktrees");
  await palette.getByRole("combobox").press("Enter");
  const dialog = page.getByTestId("worktrees-dialog");
  await expect(dialog.getByRole("listitem", { name: "spare" })).toContainText("No thread");
  await dialog.getByRole("checkbox", { name: "Select spare" }).check();
  await dialog.getByRole("button", { name: "Remove 1 worktree…" }).click();
  await dialog
    .getByTestId("worktree-bulk-remove")
    .getByRole("button", { name: /^Delete 1 worktree/ })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Removed the worktree folder spare");
  expect(existsSync(spare)).toBe(false);
  expect(h.git(h.repo, "branch", "--list", "spare")).toContain("spare");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  // Uncommitted work in the worktree makes removal ask before discarding it.
  writeFileSync(join(worktree, "notes", "wip.md"), "Half a thought.\n");
  await page.keyboard.press("ControlOrMeta+Alt+KeyW");
  const close = page.getByTestId("close-thread-dialog");
  await close.getByRole("checkbox", { name: /Also delete the worktree/ }).check();
  await close.getByRole("button", { name: "Close and delete worktree" }).click();
  await close.getByRole("button", { name: "Delete anyway" }).click();
  await expect(close).toBeHidden();
  await expect(threadRow(page, threadId)).toBeHidden();
  expect(existsSync(worktree)).toBe(false);
  expect(h.git(h.repo, "branch", "--list", `*${BRANCH_NAME}`)).toContain(BRANCH_NAME);
});
