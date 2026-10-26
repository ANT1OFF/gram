import { expect, type Page } from "@playwright/test";
import { threadRow } from "./thread-row";

/**
 * Invented offline state with the overview `width` px wide in a 1440 px window: the mock's board
 * scenario, two workers given long titles and the one at work a failing PR, and its stage recorded.
 */
export async function openOverviewDensity(page: Page, width: number) {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.addInitScript((paneWidth) => {
    const settings = JSON.parse(sessionStorage.getItem("gram.mock.settings") ?? "{}");
    settings.sidebar = { ...settings.sidebar, width: paneWidth, collapsed: false };
    settings.panel = { ...settings.panel, open: false };
    sessionStorage.setItem("gram.mock.settings", JSON.stringify(settings));
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [
          { tool: "git", found: true, path: "/mock/bin/git" },
          { tool: "gh", found: true, path: "/mock/bin/gh" },
          { tool: "codex", found: true, path: "/mock/bin/codex" },
          { tool: "claude", found: true, path: "/mock/bin/claude" },
        ],
        ghSignedIn: false,
        codexSignIn: "signedOut",
        claudeSignIn: "signedOut",
      }),
    );
  }, width);
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(async () => {
    const mock = window.gramMock!;
    const board = await mock.simulateOrchestration("board");
    mock.world.updateThread(board.working, {
      title: "Improve workspace navigation and preserve approval boundaries",
    });
    mock.world.updateThread(board.briefed, {
      title: "Independently review registry pagination and API compatibility",
    });
    const git = mock.world.summary(board.inReview).git;
    // This worker is executing while its PR fails CI; neither fact replaces the other.
    if (git?.pr)
      mock.world.publishGit(board.working, {
        ...git,
        pr: { ...git.pr, number: 214, checks: "failing" },
      });
    await mock.setOrchestratorStage(board.workspaceId, {
      feature: "mail-trigger",
      stage: "Qualify layout and approval behavior",
      plan: ["Build", "Qualify layout and approval behavior", "Merge"],
      note: "Recorded plan; independent review is still required.",
    });
    return board;
  });
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  await expect(page.getByRole("separator", { name: "Resize overview" })).toHaveAttribute(
    "aria-valuenow",
    String(width),
  );
  return made;
}
