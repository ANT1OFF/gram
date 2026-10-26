import { expect, test } from "@playwright/test";

import { clipboardText as clipboard } from "./clipboard";
import { parkSeedAsks } from "./seed-asks";
import { openOrchestrator, threadRow } from "./thread-row";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("what the agent leaves for the user waits in the tray, counts in Needs you, and goes with Done", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const tray = page.getByTestId("waiting-tray");
  const needsYou = page.getByTestId("overview-needs-you");
  await expect(threadRow(page, "t-deps")).toBeVisible();
  await parkSeedAsks(page);
  await expect(tray).toHaveCount(0);
  await expect(needsYou).toHaveText("Nothing needs you");

  await page.evaluate(() => {
    const mock = window.gramMock!;
    mock.simulateWaitOnUser("t-deps" as never, {
      kind: "draft",
      title: "Teams message to Kari: the bump",
      copy: "Hi Kari, the dependencies are bumped and the tests pass.",
    });
    mock.simulateWaitOnUser("t-deps" as never, {
      kind: "review",
      title: "example/api#431",
      link: "https://github.com/example/api/pull/431",
    });
  });

  // Folded to one line under the header, with the count in the overview's Needs you.
  await expect(tray.getByTestId("waiting-count")).toContainText("2 waiting on you");
  await expect(tray).toContainText("Teams message to Kari · example/api#431");
  await expect(needsYou).toHaveAttribute("data-count", "2");
  // With ⌘⌥3's hint, which opens its popover.
  await expect(needsYou).toHaveText(/^2 need you/);
  // Each item marks the reply it was added in.
  const chips = page.getByTestId("transcript").getByTestId("wait-chip");
  await expect(chips).toHaveCount(2);
  await expect(chips.first()).toHaveAttribute("data-state", "open");

  await tray.getByRole("button", { name: /^2 waiting on you/ }).click();
  const items = tray.getByTestId("waiting-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toContainText("github.com");

  await items.first().getByTestId("waiting-copy").click();
  await expect
    .poll(() => clipboard(page))
    .toBe("Hi Kari, the dependencies are bumped and the tests pass.");
  await items.first().getByTestId("waiting-jump").click();
  await expect(chips.first()).toBeInViewport();

  // Done takes it off, restyles its chip, and offers Undo for a while.
  await items.first().getByTestId("waiting-done").click();
  await expect(items).toHaveCount(1);
  await expect(needsYou).toHaveAttribute("data-count", "1");
  await expect(chips.first()).toHaveAttribute("data-state", "done");
  await tray.getByTestId("waiting-undo").click();
  await expect(items).toHaveCount(2);
  await expect(chips.first()).toHaveAttribute("data-state", "open");

  await items.nth(1).getByTestId("waiting-done").click();
  await items.first().getByTestId("waiting-done").click();
  await expect(needsYou).toHaveAttribute("data-count", "0");
  await expect(chips.and(page.locator("[data-state=done]"))).toHaveCount(2);
});

test("a helper's suggestion waits dashed and uncounted until kept, and its resolves can be undone", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const tray = page.getByTestId("waiting-tray");
  const needsYou = page.getByTestId("overview-needs-you");
  await expect(threadRow(page, "t-deps")).toBeVisible();
  await parkSeedAsks(page);
  await expect(needsYou).toHaveAttribute("data-count", "0");

  const id = await page.evaluate(
    () =>
      window.gramMock!.simulateHelperSuggestion("t-deps" as never, {
        kind: "draft",
        title: "Teams message to Kari",
        copy: "Hi Kari, the bump is in.",
      }).id,
  );
  await expect(tray.getByTestId("waiting-count")).toContainText("0 waiting on you");
  await expect(tray).toContainText("1 suggested");
  await expect(needsYou).toHaveAttribute("data-count", "0");

  await tray.getByRole("button", { name: /^0 waiting on you/ }).click();
  const item = tray.getByTestId("waiting-item");
  await expect(item).toHaveAttribute("data-suggested", "true");
  await expect(item).toContainText("suggested");
  await expect(item.getByTestId("waiting-done")).toHaveCount(0);
  await item.getByTestId("waiting-keep").click();
  await expect(needsYou).toHaveAttribute("data-count", "1");
  await expect(item).toHaveAttribute("data-suggested", "false");

  // The user said they sent it: the helper resolves it, with an Undo of its own.
  await page.evaluate(
    (wait) => window.gramMock!.simulateHelperResolve("t-deps" as never, wait as never),
    id,
  );
  await expect(needsYou).toHaveAttribute("data-count", "0");
  const resolved = tray.getByTestId("waiting-helper-resolved");
  await expect(resolved).toContainText("Resolved by the helper from what you wrote (1)");
  await resolved.getByRole("button", { name: /Resolved by the helper/ }).click();
  await resolved.getByTestId("waiting-helper-undo").click();
  await expect(needsYou).toHaveAttribute("data-count", "1");
  await expect(resolved).toHaveCount(0);

  // A second suggestion, dismissed, goes without counting.
  await page.evaluate(() =>
    window.gramMock!.simulateHelperSuggestion("t-deps" as never, {
      kind: "action",
      title: "Run harbor --version",
      copy: "harbor --version",
    }),
  );
  await tray.locator("[data-suggested=true]").getByTestId("waiting-dismiss").click();
  await expect(tray.locator("[data-suggested=true]")).toHaveCount(0);
  await expect(needsYou).toHaveAttribute("data-count", "1");
});

test("what the user adds by hand waits too, and their next message tells the agent", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  await expect(threadRow(page, "t-deps")).toBeVisible();
  await parkSeedAsks(page);
  const tray = page.getByTestId("waiting-tray");
  const transcript = page.getByTestId("transcript");
  const reply = transcript.getByTestId("message-assistant").first();
  await reply.hover();
  await reply.getByTestId("message-wait").click();
  await expect(tray.getByTestId("waiting-count")).toContainText("1 waiting on you");
  await expect(tray).toContainText("Bumped 14 packages. All tests pass.");
  await expect(reply.getByRole("button", { name: "Waiting on you", exact: true })).toBeDisabled();
  await expect(reply.getByTestId("wait-chip")).toHaveAttribute("data-state", "open");

  // The next message tells the agent, in a line under it that unfolds to what it read.
  const composer = page.getByRole("combobox", { name: "Message" });
  await composer.fill("Thanks, I'll send it");
  await composer.press("Enter");
  const sent = transcript.getByTestId("message-user").last();
  await expect(sent).toContainText("Thanks, I'll send it");
  await sent.getByRole("button", { name: "Gram told the agent" }).click();
  await expect(sent.getByTestId("wait-note-text")).toHaveText(
    /^The user added to Waiting on you, to act on themselves: "Bumped 14 packages\. All tests pass\." \(w-[\w-]+\)\.$/,
  );
  await expect(transcript.getByTestId("message-assistant")).toHaveCount(2);

  // ⌘K adds the last reply.
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  await palette.getByRole("combobox").fill(">Add reply");
  await palette.getByText("Add reply to Waiting on you", { exact: true }).click();
  await expect(tray.getByTestId("waiting-count")).toContainText("2 waiting on you");

  // Done elsewhere, it is under Resolved, which reopens it.
  const first = await page.evaluate(async () => {
    const mock = window.gramMock!;
    const [item] = await mock.listWaits("t-deps" as never);
    await mock.resolveWait("t-deps" as never, item!.id);
    return item!.title;
  });
  await expect(tray.getByTestId("waiting-count")).toContainText("1 waiting on you");
  await tray.getByRole("button", { name: /^1 waiting on you/ }).click();
  await tray.getByRole("button", { name: "Resolved (1)" }).click();
  await expect(tray.getByTestId("waiting-resolved-item")).toContainText(first);
  await tray.getByTestId("waiting-reopen").click();
  await expect(tray.getByTestId("waiting-count")).toContainText("2 waiting on you");
  await expect(tray.getByTestId("waiting-resolved")).toHaveCount(0);

  // Done in the tray goes in the next note, with what still waits.
  await tray.getByTestId("waiting-item").first().getByTestId("waiting-done").click();
  // Done is a request: sending before its result reaches the tray captures the old open state.
  await expect(tray.getByTestId("waiting-count")).toContainText("1 waiting on you");
  await expect(tray.getByTestId("waiting-undo-row")).toContainText(first);
  await composer.fill("Sent it");
  await composer.press("Enter");
  const next = transcript.getByTestId("message-user").last();
  await expect(next).toContainText("Sent it");
  await next.getByRole("button", { name: "Gram told the agent" }).click();
  await expect(next.getByTestId("wait-note-text")).toContainText(
    'The user marked done: "Bumped 14 packages. All tests pass."',
  );
  await expect(next.getByTestId("wait-note-text")).toContainText(
    "The user added to Waiting on you",
  );

  // Once it is done elsewhere too, ⌘K reopens it from the last day's resolved items.
  const last = await page.evaluate(async () => {
    const mock = window.gramMock!;
    const [item] = await mock.listWaits("t-deps" as never);
    await mock.resolveWait("t-deps" as never, item!.id);
    return item!.title;
  });
  await expect(page.getByTestId("overview-needs-you")).toHaveAttribute("data-count", "0");
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill(">Reopen Waiting");
  await palette.getByText("Reopen Waiting on you item…", { exact: true }).click();
  await expect(palette.getByText("Reopen in Waiting on you")).toBeVisible();
  await palette.getByText(last, { exact: true }).click();
  await expect(palette).toBeHidden();
  await expect(tray.getByTestId("waiting-count")).toContainText("1 waiting on you");

  // Closing warns of what is left.
  await page.keyboard.press("ControlOrMeta+Alt+w");
  await expect(
    page.getByTestId("close-thread-dialog").getByTestId("close-waiting-warning"),
  ).toContainText("1 thing still waits on you here");
});

test("one Waiting on you across threads: Needs you counts it, the Board groups a workspace's by thread", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  await expect(threadRow(page, "t-deps")).toBeVisible();
  const needsYou = page.getByTestId("overview-needs-you");
  const seeded = await page.evaluate(() => window.gramMock!.simulateOrchestration("board"));
  // The board's own asks and failures, before anything waits in a tray: once two reads agree.
  let before = -1;
  await expect
    .poll(
      async () => {
        const now = Number(await needsYou.getAttribute("data-count"));
        const settled = now > 0 && now === before;
        before = now;
        return settled;
      },
      { intervals: [400] },
    )
    .toBe(true);
  const made = await page.evaluate(async (board) => {
    const mock = window.gramMock!;
    mock.simulateWaitOnUser(board.orchestratorThreadId, {
      kind: "action",
      title: "Run assume example-prod",
    });
    mock.simulateWaitOnUser(board.inReview, {
      kind: "draft",
      title: "PR description",
      copy: "Adds the mail trigger.",
    });
    mock.simulateWaitOnUser("t-deps" as never, { kind: "review", title: "example/api#431" });
    // A helper's suggestion waits in its own thread's tray only, until it is kept.
    mock.simulateHelperSuggestion(board.inReview, { kind: "draft", title: "Suggested note" });
    // No copy text: Copy reads it from the reply, in a thread no pane has open.
    mock.simulateWaitOnUser(board.working, {
      kind: "draft",
      title: "Reply to Kari",
      body: "Ask Kari for a date",
    });
    return board;
  }, seeded);

  // One count at the top of the overview: the asks and failures, and the four kept items, not the
  // helper's suggestion.
  await expect(needsYou).toHaveAttribute("data-count", String(before + 4));

  // The Board: the orchestrator's own and its questions first, then each worker's.
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.keyboard.press("ControlOrMeta+Shift+D");
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(page.getByTestId("rail-board")).toBeVisible();
  const chip = page.getByTestId("rail-waiting-chip");
  await expect(chip).toHaveAttribute("aria-label", "5 waiting on you");
  await chip.click();
  const band = page.getByTestId("rail-waiting");
  const groups = band.getByTestId("board-waiting-group");
  await expect(groups).toHaveCount(3);
  await expect(groups.first()).toHaveAttribute("data-thread", made.orchestratorThreadId);
  await expect(groups.first()).toContainText("Run assume example-prod");
  await expect(band.getByTestId("memory-question")).toHaveCount(2);
  const reviewing = groups.and(page.locator(`[data-thread="${made.inReview}"]`));
  await expect(reviewing).toContainText("PR description");
  await expect(band.getByText("Suggested note")).toHaveCount(0);

  await reviewing.getByTestId("waiting-done").click();
  await expect(groups).toHaveCount(2);
  await expect(chip).toHaveAttribute("aria-label", "4 waiting on you");
  await expect(needsYou).toHaveAttribute("data-count", String(before + 3));
});
