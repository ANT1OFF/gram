import { readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "../e2e/slowdown";
import { terminalText } from "../e2e/terminal";
import { REPO_SLUG, startHarness, type Harness } from "./harness";
import { threadRow } from "../e2e/thread-row";

// The flows share one server, one page and the thread the first one creates.
test.describe.configure({ mode: "serial" });

const PROMPT = "Add a note about the needle";
const BRANCH_NAME = "real-e2e";

let h: Harness;
let page: Page;
let threadId = "";
let worktree = "";

test.beforeAll(async ({ browser }) => {
  h = await startHarness();
  page = await browser.newPage();
});

test.afterAll(async () => {
  await page?.close();
  await h?.stop();
});

/** The worktree checked out on a branch ending in `name`, from `git worktree list`. */
const worktreeOnBranch = (name: string): string => {
  let path: string | undefined;
  for (const line of h.git(h.repo, "worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line.startsWith("branch refs/heads/") && line.endsWith(name) && path) return path;
  }
  throw new Error(`no worktree on a branch named like ${name}`);
};

test("/new in a new worktree streams the echo, and Files finds a seeded file", async () => {
  await h.open(page, "/new");
  await page.getByRole("combobox", { name: "Project path" }).fill(h.repo);
  await expect(page.getByTestId("folder-status")).toBeVisible();
  await page
    .getByRole("radiogroup", { name: "Checkout" })
    .getByRole("radio", { name: "New worktree" })
    .click();
  await page.getByRole("textbox", { name: "Branch name" }).fill(BRANCH_NAME);
  await page.getByRole("combobox", { name: "First prompt" }).fill(PROMPT);
  await page.getByRole("button", { name: "Create thread" }).click();

  await expect(page).toHaveURL(/\/t\/[^/]+$/, { timeout: 30_000 });
  threadId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByText(`echo: ${PROMPT}`)).toBeVisible();
  worktree = worktreeOnBranch(BRANCH_NAME);

  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Files", exact: true }).click();
  // The shared find box switches from names to contents with a leading `?`.
  await panel.getByRole("textbox", { name: "Filter files" }).fill("?needle-7431");
  await expect(panel.getByRole("textbox", { name: "Search in files" })).toHaveValue("?needle-7431");
  const result = panel
    .getByRole("list", { name: "Search results" })
    .getByRole("button", { name: "notes/seeded.md, line 1: The needle-7431 lives here." });
  await result.click();
  const preview = panel.getByTestId("file-preview");
  await expect(preview).toContainText("notes/seeded.md");
  await expect(preview.locator("[data-highlighted]")).toContainText("needle-7431");
  await page.screenshot({ path: test.info().outputPath("content-search.png") });
  await preview.getByRole("button", { name: "Close preview" }).click();
});

// The one place the emulator's WebAssembly meets the header the real server sends: the mock-API
// specs run on Vite, which has no CSP, so only here would a policy that blocks it show.
test("the Terminal tab runs a real shell under the server's CSP", async () => {
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Terminal", exact: true }).click();
  const terminal = panel.getByTestId("terminal").first();
  await expect(terminal.getByRole("alert")).toHaveCount(0);
  await expect(terminal.getByTestId("terminal-surface").locator("canvas")).toBeVisible();
  await terminal.getByTestId("terminal-surface").click();
  // Computed by the shell, so the echoed command line can't match.
  await page.keyboard.type("echo $((6*7))-ghostty");
  await page.keyboard.press("Enter");
  await expect(terminalText(terminal)).toContainText("42-ghostty", { timeout: 15_000 });
});

test("Diff shows the change, Publish and Create PR show the badge, red CI lifts into Needs you", async () => {
  writeFileSync(join(worktree, "notes", "agent.md"), "Written by the agent.\n");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Diff", exact: true }).click();
  // The watcher pushes the change; no refresh.
  await expect(panel.getByTestId("diff-file")).toHaveCount(1);
  await expect(panel.getByText("notes/agent.md")).toBeVisible();
  h.git(worktree, "add", "-A");
  h.git(worktree, "commit", "-qm", "Add agent note");

  await panel.getByRole("tab", { name: "PR", exact: true }).click();
  await panel.getByTestId("push-button").click();
  await expect(panel.getByTestId("push-button")).toBeHidden();
  expect(h.git(h.origin, "branch", "--list")).toContain(BRANCH_NAME);

  await panel.getByTestId("create-pr-button").click();
  const dialog = page.getByTestId("create-pr-dialog");
  await expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Add agent note");
  await dialog.getByRole("button", { name: "Create PR" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("pane-pr-badge")).toContainText("#1");
  expect(h.prs()).toMatchObject([
    { number: 1, title: "Add agent note", base: "main", state: "OPEN" },
  ]);

  // Look at something else, so viewing the thread doesn't acknowledge the red build. A reload
  // starts from the server's snapshot, which once had no git state, so a red build published as
  // the page reconnected never reached the thread.
  await page.goto(`${h.origin_url()}/new`);
  await expect(threadRow(page, threadId)).toBeVisible();
  h.setChecks(1, "failing");
  await expect(page.getByText("CI failed on #1")).toBeVisible({ timeout: 20_000 });
});

test("after a restart ↑ recalls the prompt, ⌘⇧T reopens a closed thread, a second draft warns", async () => {
  await h.restart();
  await h.open(page, `/t/${threadId}`);
  const composer = page.getByRole("combobox", { name: "Message" });
  await expect(composer).toBeVisible();
  await composer.click();
  await expect(async () => {
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(PROMPT, { timeout: 500 });
  }).toPass({ timeout: 15_000 });
  await composer.fill("");

  await page.keyboard.press("ControlOrMeta+Alt+KeyW");
  // Clean, pushed worktrees now default to deletion. This scenario deliberately keeps it to reopen.
  const keepWorktree = page.getByRole("checkbox", { name: /Also delete the worktree on disk/ });
  await keepWorktree.uncheck();
  await expect(keepWorktree).not.toBeChecked();
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(threadRow(page, threadId)).toBeHidden();

  // Reopening brings the thread back in its worktree under its own id, with its conversation.
  await page.keyboard.press("ControlOrMeta+Shift+KeyT");
  await expect(page).toHaveURL(new RegExp(`/t/${threadId}$`));
  await expect(page.getByTestId("pane-header")).toContainText(PROMPT);
  await expect(threadRow(page, threadId)).toBeVisible();
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByTestId("message-user").first()).toContainText(PROMPT);
  await expect(transcript.getByText(`echo: ${PROMPT}`)).toBeVisible();
  await composer.click();
  await expect(async () => {
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(PROMPT, { timeout: 500 });
  }).toPass({ timeout: 15_000 });

  // Cold since the restart, the thread opens an agent for this send, which goes straight to the
  // feed: never a queue card, however briefly.
  await page.evaluate(() => {
    const seen = window as unknown as { queueSeen?: boolean };
    seen.queueSeen = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="queue"]') !== null) seen.queueSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await composer.fill("And the haystack");
  await composer.press("ControlOrMeta+Enter");
  await expect(transcript.getByText("echo: And the haystack")).toBeVisible();
  await expect(transcript.getByTestId("message-user").last()).toContainText("And the haystack");
  expect(await page.evaluate(() => (window as { queueSeen?: boolean }).queueSeen)).toBe(false);

  await page.goto(`${h.origin_url()}/new`);
  await page.getByRole("combobox", { name: "Project path" }).fill(h.repo);
  await expect(page.getByTestId("folder-status")).toBeVisible();
  await page.getByRole("radio", { name: "Existing worktree" }).click();
  // The open thread's worktree can't be picked from the list; typing its path warns instead.
  const inUse = page
    .getByRole("radiogroup", { name: "Existing worktrees" })
    .getByRole("radio")
    .filter({ hasText: BRANCH_NAME });
  await expect(inUse).toBeDisabled();
  await expect(inUse).toContainText("open in a thread");
  await page.getByRole("textbox", { name: "Worktree path" }).fill(worktree);
  await expect(page.getByTestId("checkout-in-use")).toBeVisible();
});

test("⌘N's New task makes the repo's workspace, hands its orchestrator the task, or starts a worker", async () => {
  await h.open(page, `/t/${threadId}`);
  await expect(page.getByTestId("pane-header")).toContainText(PROMPT);
  await page.keyboard.press("ControlOrMeta+KeyN");
  await expect(page).toHaveURL(/\/new-task$/);
  await expect(page.getByTestId("task-target")).toHaveText(basename(h.repo));
  await page.getByLabel("What needs doing").fill("Plan the needle notes");
  await page.getByRole("button", { name: /Start workspace and send/ }).click();

  await expect(page.getByTestId("pane-role")).toHaveText("Orchestrator", { timeout: 30_000 });
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("echo: Plan the needle notes")).toBeVisible({
    timeout: 30_000,
  });

  // On an orchestrator, New task's shortcut now focuses its composer; the sidebar opens the draft.
  const orchestratorUrl = page.url();
  await page.keyboard.press("ControlOrMeta+KeyN");
  await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeFocused();
  await expect(page).toHaveURL(orchestratorUrl);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await expect(page).toHaveURL(/\/new-task$/);
  await page.getByRole("radio", { name: "Straight to a worker" }).click();
  await page.getByLabel("What needs doing").fill("Write the needle notes");
  await page.getByRole("button", { name: /Start worker/ }).click();
  await expect(page.getByTestId("pane-header")).toContainText("Write the needle notes", {
    timeout: 30_000,
  });
  await expect(transcript.getByText("echo: Write the needle notes")).toBeVisible();
  // You wrote its first input, so it starts yours, with the way to hand it back.
  const hold = page.getByTestId("worker-hold");
  await expect(hold).toContainText("You hold it");
  await expect(hold.getByTestId("worker-hand-back")).toBeVisible();
  expect(worktreeOnBranch("feat/write-the-needle-notes")).not.toBe("");
});

test("a GitHub name typed on /new is cloned into the clone folder, and adopted after", async () => {
  await h.open(page, "/new");
  const path = page.getByRole("combobox", { name: "Project path" });
  // The field starts on the most recent project once the projects load; a fill that lands as it
  // does selects the empty text and then types after the project's path.
  const fillPath = (value: string) =>
    expect(async () => {
      await path.fill(value);
      await expect(path).toHaveValue(value, { timeout: 1_000 });
    }).toPass();
  await fillPath(REPO_SLUG);
  const offer = page.getByTestId("clone-offer");
  await expect(offer).toContainText("Clones into ~/Documents/code/web");
  await offer.getByRole("button", { name: `Clone ${REPO_SLUG}` }).click();
  const code = join(h.root, "home", "Documents", "code");
  const clone = join(code, "web");
  await expect(path).toHaveValue(clone, { timeout: 30_000 * slowdown });
  await expect(page.getByTestId("folder-status")).toBeVisible();
  // Renamed into place from its temp folder, which is gone; `origin` names the repository.
  expect(readdirSync(code)).toEqual(["web"]);
  expect(h.git(clone, "log", "-1", "--format=%s")).toBe("initial");
  expect(h.git(clone, "config", "remote.origin.url")).toBe(`git@github.com:${REPO_SLUG}.git`);

  await page.goto(`${h.origin_url()}/settings/general`);
  await expect(page.getByLabel("Where new clones go")).toHaveAttribute(
    "placeholder",
    "~/Documents/code",
  );

  // Added again by its URL from the palette's "Add repository…", the clone there is the project,
  // and the New thread already open moves to it.
  await page.goto(`${h.origin_url()}/new`);
  await fillPath(h.repo);
  await expect(page.getByTestId("folder-status")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">add repository");
  await palette.getByText("Add repository…", { exact: true }).click();
  const dialog = page.getByTestId("add-repo-dialog");
  const field = dialog.getByRole("combobox", { name: "Folder, GitHub repo or URL" });
  // The palette's exit restores focus; it must leave it in the dialog it just opened, or Enter
  // goes to the underlying Project path and never starts adoption (main run 37644193242).
  await expect(palette).toBeHidden();
  await expect(field).toBeFocused();
  await field.fill(`https://github.com/${REPO_SLUG}`);
  await field.press("Enter");
  // Selecting the registered project is the completion signal, even for an instant adoption.
  await expect(path).toHaveValue(clone, { timeout: 30_000 * slowdown });
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByTestId("folder-status")).toBeVisible();
  expect(readdirSync(code)).toEqual(["web"]);
});
