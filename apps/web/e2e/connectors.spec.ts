import { expect, test } from "@playwright/test";

import { slowdown } from "./slowdown";

test("lists a thread's connectors, and reconnects, signs in to and toggles them", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Connectors", exact: true }).click();

  const connectors = panel.getByTestId("connector");
  await expect(connectors).toHaveCount(7);

  const builtIn = connectors.filter({ hasText: "gram" });
  await expect(builtIn).toContainText("built-in");
  await expect(builtIn.getByRole("button", { name: "Disable" })).toBeDisabled();
  await expect(builtIn).toContainText("Gram's app tools stay on");

  const sentry = connectors.filter({ hasText: "sentry" });
  await expect(sentry).toContainText("Failed");
  await expect(sentry).toContainText("ECONNREFUSED");
  await sentry.getByRole("button", { name: "Reconnect" }).click();
  await expect(sentry).toContainText("Connected");
  await expect(sentry).not.toContainText("ECONNREFUSED");

  const linear = connectors.filter({ hasText: "linear" });
  // A claude.ai connector the user never signed in to: a fact, signed in to from here.
  await expect(linear).toContainText("Not signed in");
  await expect(linear).toContainText("claude.ai");
  await expect(panel.getByRole("region", { name: "Not signed in" })).not.toContainText("/mcp");
  await linear.getByRole("button", { name: "Sign in" }).click();
  await expect(linear).toContainText("Waiting for sign-in…");
  expect(await page.evaluate(() => window.gramMock!.opened)).toContain(
    "https://idp.example/authorize?server=linear",
  );
  await expect(linear).toContainText("Connected", { timeout: 10_000 * slowdown });
  await expect(panel.getByRole("status")).toContainText("Signed in to linear.");

  const github = connectors.filter({ hasText: "github" });
  await github.getByRole("button", { name: "Disable" }).click();
  await expect(github).toContainText("Disabled");
  await github.getByRole("button", { name: "Enable" }).click();
  await expect(github).toContainText("Connected");
});

test("starts a cold thread's session as its Connectors tab opens, once, and lists it live", async ({
  page,
}) => {
  await page.goto("/t/t-grpc");
  await page.waitForFunction(() => window.gramMock !== undefined);
  const panel = page.getByTestId("right-panel");
  const connectorsTab = panel.getByRole("tab", { name: "Connectors", exact: true });
  const filesTab = panel.getByRole("tab", { name: "Files", exact: true });
  const tab = panel.getByTestId("connectors-panel");
  const starts = () => page.evaluate(() => window.gramMock!.sessionStarts);

  // An archived thread stays as it is: the config is shown, and nothing starts.
  await connectorsTab.click();
  await expect(tab).toContainText("Unarchive the thread to see its connectors live.");
  await expect(tab.getByTestId("connectors-snapshot")).toContainText("as of");
  expect(await starts()).toEqual([]);

  await filesTab.click();
  await page.evaluate(() => window.gramMock!.park("t-grpc" as never, false));
  await connectorsTab.click();
  await expect(tab).toContainText("Starting the session…");
  await expect(tab.getByTestId("connector")).toHaveCount(7);
  expect(await starts()).toEqual(["t-grpc"]);

  // Flipping away and back starts nothing more.
  await filesTab.click();
  await connectorsTab.click();
  await expect(tab.getByTestId("connector")).toHaveCount(7);
  expect(await starts()).toEqual(["t-grpc"]);
});

test("says once when a claude.ai connector needs signing in again, and signs in from there", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  // The mock API loads lazily, after the page's own load event.
  await page.waitForFunction(() => window.gramMock !== undefined);
  const lapse = (name: string) =>
    page.evaluate((n) => window.gramMock!.lapseConnector("t-flaky" as never, n), name);
  await lapse("claude.ai Atlassian");
  await lapse("claude.ai Snowflake");
  const notice = page.getByTestId("lapsed-connectors-notice");
  const atlassian = notice.getByTestId("lapsed-connector").filter({ hasText: "Atlassian" });
  const snowflake = notice.getByTestId("lapsed-connector").filter({ hasText: "Snowflake" });
  await expect(atlassian).toContainText("claude.ai Atlassian needs signing in again.");

  await snowflake.getByRole("button", { name: "Not now" }).click();
  await expect(snowflake).toHaveCount(0);
  // Still lapsed, so a second report brings no second notice.
  await lapse("claude.ai Snowflake");
  await expect(notice.getByTestId("lapsed-connector")).toHaveCount(1);

  await atlassian.getByRole("button", { name: "Sign in" }).click();
  await expect(atlassian).toContainText(
    "Finish signing in to claude.ai Atlassian in your browser.",
  );
  expect(await page.evaluate(() => window.gramMock!.opened)).toContain(
    "https://idp.example/authorize?server=claude.ai Atlassian",
  );
  await expect(notice).toHaveCount(0, { timeout: 10_000 * slowdown });
});
