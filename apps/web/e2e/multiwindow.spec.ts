import { expect, test } from "@playwright/test";

import { openMore } from "./more-menu";
import { threadRow } from "./thread-row";

test("Open in new window opens a tab on that thread only when asked", async ({ context }) => {
  const main = await context.newPage();
  await main.goto("/t/t-flaky");
  await expect(main.getByTestId("pane-header")).toContainText("Fix flaky retry test");
  expect(context.pages()).toHaveLength(1);

  // The tab trades its `?window=…&open=…` address for the thread's route as soon as it opens, so
  // check the address it was opened with rather than racing that replace on a slow runner.
  const documents: string[] = [];
  context.on("request", (request) => {
    if (request.resourceType() === "document") documents.push(request.url());
  });
  const more = await openMore(main, threadRow(main, "t-deps"));
  const opened = context.waitForEvent("page");
  await more.getByRole("option", { name: "Open in new window" }).click();
  const tab = await opened;
  await expect
    .poll(() => documents)
    .toContainEqual(expect.stringMatching(/window=tab-.*open=t-deps/));
  await expect(tab.getByTestId("pane-header")).toContainText("Bump dependencies");
  await expect(tab).toHaveURL(/\/t\/t-deps$/);
});
