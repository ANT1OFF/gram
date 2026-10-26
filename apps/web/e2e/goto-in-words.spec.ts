import { expect, test } from "@playwright/test";
import { threadRow } from "./thread-row";

test("sentence filters work offline and remain keyboard editable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    sessionStorage.setItem("gram.mock.settings", JSON.stringify({ helpers: { enabled: false } }));
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({ claudeSignIn: "signedIn", codexSignIn: "signedIn", ghSignedIn: false }),
    );
  });
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  await page.evaluate(() => window.gramMock!.simulateOrchestration("board"));
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  const input = palette.getByRole("combobox", { name: "Go to, or > for commands" });
  await input.fill("workers waiting on me");
  const kind = palette.getByRole("combobox", { name: "Kind" });
  await expect(kind).toHaveValue("worker");
  await expect(palette.getByRole("combobox", { name: "State" })).toHaveValue("waiting");
  await expect(
    palette.getByRole("group", { name: "Filtered results" }).getByRole("option").first(),
  ).toBeVisible();
  await expect(palette.getByRole("button", { name: "Suggest filters" })).toHaveCount(0);
  // Tab from typing reaches chips. Native select arrows edit; Delete removes only the chip.
  await input.press("Tab");
  await expect(kind).toBeFocused();
  await kind.press("ArrowDown");
  await expect(kind).toHaveValue("pr");
  await kind.press("Delete");
  await expect(kind).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("workers waiting on me");
  await input.press("Home");
  await expect(input).toHaveJSProperty("selectionStart", 0);
  await input.fill(">workers waiting on me");
  await expect(palette.getByLabel("Search filters")).toHaveCount(0);
  expect(errors).toEqual([]);
});
