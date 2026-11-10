import { expect, test, type Page } from "@playwright/test";
import { openMoreOptions } from "./new-thread-options";

/** A synthetic joined machine, online and signed in: no host, tailnet or account behind it. */
const MACHINE = {
  id: "m-0123456789abcdef01234567",
  name: "build box",
  platform: "linux",
  fingerprint: "0123-4567-89AB-CDEF-0123",
  joinedAt: 1,
  confirmed: true,
  onlineSince: 2,
  claudeSignIn: "signedIn",
};

/** Settings → Machines' list, answered here: the mock's folders on it are one synthetic home. */
const joinMachine = (page: Page) =>
  page.route("**/machines/list", (route) =>
    route.fulfill({ json: { machines: [MACHINE] }, headers: { "cache-control": "no-store" } }),
  );

test("a one-off chat starts in a joined machine's home, and its header says where", async ({
  page,
}) => {
  await joinMachine(page);
  await page.goto("/new");
  const form = page.getByRole("form", { name: "New thread" });
  const where = form.getByTestId("new-where");

  await where.getByTestId("where-machine").click();
  await page.getByRole("option", { name: "build box" }).click();
  // Home there by default, said in full before it starts.
  await expect(where.getByTestId("where-folder")).toHaveText("~");
  await expect(form.getByTestId("machine-folder-note")).toHaveText(
    "Runs on build box in /home/dev, as it is: no worktree, diff or pull request outside a repository.",
  );
  await expect(form.getByRole("radio", { name: "Current checkout" })).toHaveCount(0);

  await form.getByLabel("First prompt").fill("check the disk usage of ~/Downloads");
  await form.getByRole("button", { name: /Start chat/ }).click();
  await expect(page).toHaveURL(/\/t\/t-/);
  const chip = page.getByTestId("pane-machine");
  await expect(chip).toContainText("build box");
  await expect(chip).toContainText("~");
  await expect(chip).toHaveAttribute("aria-label", "Runs on build box in /home/dev");
});

test("a folder there is typed or browsed through its host, and a credential folder refused", async ({
  page,
}) => {
  await joinMachine(page);
  await page.goto("/new");
  const form = page.getByRole("form", { name: "New thread" });
  await form.getByTestId("where-machine").click();
  await page.getByRole("option", { name: "build box" }).click();

  // The folder's own field is under More options; its home is picked until another is typed.
  await openMoreOptions(page);
  const field = form.getByRole("combobox", { name: "Folder on build box" });
  await field.fill("~/.ssh");
  await expect(form.getByTestId("folder-problem").first()).toHaveText(
    "Gram doesn't run a chat in /home/dev/.ssh: it holds keys or credentials.",
  );
  await expect(form.getByRole("button", { name: /Start chat/ })).toBeDisabled();

  await field.fill("~/code/");
  await form.getByRole("button", { name: "Browse" }).click();
  const browser = form.getByTestId("folder-browser");
  await expect(browser.getByRole("option")).toHaveText([/^dotfiles/, /^homelab/, "sandbox"]);
  await browser.getByRole("option", { name: /^dotfiles/ }).dblclick();
  await browser.getByRole("button", { name: "Choose this folder" }).click();
  await expect(form.getByTestId("where-folder")).toHaveText("~/code/dotfiles");
  await expect(form.getByTestId("machine-folder-note")).toHaveText(
    "Runs on build box in /home/dev/code/dotfiles, as it is, on its branch main.",
  );
  await expect(form.getByRole("button", { name: /Start chat/ })).toBeEnabled();
});
