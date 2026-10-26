import { expect, test, type Page } from "@playwright/test";

const HOST = "docs.example.com";

/** Sends a prompt the mock echoes back, so its reply carries a link to `url` named `name`. */
async function replyWithLink(page: Page, name: string, url: string) {
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill(`Read [${name}](${url})`);
  await composer.press("Enter");
  const link = page.getByTestId("transcript").getByRole("button", { name, exact: true }).last();
  await expect(link).toBeVisible();
  return link;
}

test("a trusted host's links open without asking until it's removed in Settings", async ({
  page,
  context,
}) => {
  await context.route(/^https:\/\/docs\.example\.com/, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>wiki</title>" }),
  );
  await page.goto("/t/t-deps");
  const link = await replyWithLink(page, "the design page", `https://${HOST}/wiki/spaces/AI`);

  // The first click asks, naming the host, and ticking the box trusts it.
  await link.click();
  const dialog = page.getByTestId("link-dialog");
  await expect(dialog.getByTestId("link-dialog-host")).toHaveText(HOST);
  await dialog.getByLabel(`Always open links to ${HOST} without asking`).check();
  const trusted = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "Open link" }).click();
  await (await trusted).close();
  await expect(dialog).toBeHidden();

  // The next opens straight away.
  const direct = page.waitForEvent("popup");
  await link.click();
  await (await direct).close();
  await expect(dialog).toBeHidden();

  // A look-alike built on the trusted name still asks.
  const lookAlike = await replyWithLink(page, "the lookalike", `https://${HOST}.evil.test/login`);
  await lookAlike.click();
  await expect(dialog.getByTestId("link-dialog-host")).toHaveText(`${HOST}.evil.test`);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  // Settings lists the host, and removing it makes its links ask again.
  await page.goto("/settings/general");
  const row = page.getByTestId("trusted-links").getByRole("listitem", { name: HOST });
  await row.getByRole("button", { name: `Trusted host ${HOST} actions` }).click();
  await page.getByRole("menuitem", { name: "Stop trusting" }).click();
  await expect(page.getByText("No trusted hosts: every link asks before it opens.")).toBeVisible();

  await page.goto("/t/t-deps");
  const again = await replyWithLink(page, "the design page", `https://${HOST}/wiki/spaces/AI`);
  await again.click();
  await expect(dialog.getByTestId("link-dialog-host")).toHaveText(HOST);
  await expect(dialog.getByLabel(`Always open links to ${HOST} without asking`)).not.toBeChecked();
});

test("an http link or one with a user name asks every time, with no way to trust it", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  const link = await replyWithLink(page, "the sign-in", `https://${HOST}@evil.test/`);
  await link.click();
  const dialog = page.getByTestId("link-dialog");
  await expect(dialog.getByTestId("link-dialog-host")).toHaveText("evil.test");
  await expect(dialog.getByText("is a user name, not the site")).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const plain = await replyWithLink(page, "the old wiki", `http://${HOST}/wiki`);
  await plain.click();
  await expect(dialog.getByText("It isn't https, so it asks every time.")).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
});

test("a link in a previewed file asks too", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Files", exact: true }).click();
  const tree = panel
    .getByTestId("files-tree-pane")
    .getByRole("tree", { name: "Files", exact: true });
  await tree.getByRole("treeitem", { name: "docs", exact: true }).click();
  await tree.getByRole("treeitem", { name: "architecture.md", exact: true }).click();
  await panel
    .getByTestId("markdown-preview")
    .getByRole("button", { name: "upstream docs", exact: true })
    .click();
  const dialog = page.getByTestId("link-dialog");
  await expect(dialog.getByTestId("link-dialog-host")).toHaveText("organization.example.invalid");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  // Nothing in the preview is left as a raw anchor to middle-click past the question.
  await expect(panel.getByTestId("markdown-preview").locator("a[href^='http']")).toHaveCount(0);
});
