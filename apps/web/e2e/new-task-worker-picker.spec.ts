import { expect, test, type Page } from "@playwright/test";

// New task, straight to a worker: the worker's agent and model are picked from the workspace's
// roster in the draft's composer, by keyboard as well as pointer, and at a narrow window. Mock
// state lives in memory, so every step stays inside the app.

/** A saved starting roster: new workspaces have none until the user saves one. */
const ROSTER = [
  {
    agent: "claude",
    model: "opus",
    variant: "high",
    speed: "standard",
    useFor: "implementation, anything cross-cutting",
    default: true,
  },
  {
    agent: "codex",
    model: "gpt-6.1-sol",
    variant: "high",
    speed: "standard",
    useFor: "reviews, bug hunts, audits, tightly scoped changes",
  },
  {
    agent: "claude",
    model: "haiku",
    variant: "medium",
    speed: "standard",
    useFor: "simple tasks, fast and cheap; well-specified work",
  },
];

const open = async (page: Page) => {
  await page.addInitScript((workerModels) => {
    if (sessionStorage.getItem("gram.mock.settings") === null)
      sessionStorage.setItem("gram.mock.settings", JSON.stringify({ agents: { workerModels } }));
  }, ROSTER);
  await page.goto("/new-task?way=direct");
  await page.getByRole("form", { name: "New task" }).waitFor();
  await expect(page.getByRole("combobox", { name: "Worker model" })).toBeVisible();
};

test("picks the worker's agent and model by keyboard, and starts the worker on them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 860 });
  await open(page);
  const agent = page.getByRole("combobox", { name: "Worker agent" });
  const model = page.getByRole("combobox", { name: "Worker model" });
  // The roster's default until something else is picked.
  await expect(agent).toContainText("Claude Code");
  await expect(model).toContainText("opus");

  await agent.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: /Codex/ }).focus();
  await page.keyboard.press("Enter");
  await expect(agent).toContainText("Codex");
  await expect(model).toContainText("gpt-6.1-sol");

  // Only Codex's models are offered now.
  await model.focus();
  await page.keyboard.press("Enter");
  const listed = page.getByRole("listbox").getByRole("option");
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText("reviews, bug hunts");
  await page.keyboard.press("Escape");

  await page.getByLabel("What needs doing").fill("Audit the synthetic change");
  await page.getByRole("button", { name: /Start (workspace and )?worker/ }).click();
  await expect(page).toHaveURL(/\/t\//);
  // The thread runs on what was picked, as its header and composer say.
  await expect(page.getByRole("combobox", { name: "Model" }).first()).toContainText("gpt-6.1-sol");
});

test("keeps the worker picker inside a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 860 });
  await open(page);
  const form = page.getByRole("form", { name: "New task" });
  const overflow = await form.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  for (const name of ["Worker agent", "Worker model"]) {
    const box = await page.getByRole("combobox", { name }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(520);
  }
  await page.getByRole("combobox", { name: "Worker model" }).click();
  const listed = page.getByRole("listbox").getByRole("option");
  await expect(listed).toHaveCount(2);
  for (const option of await listed.all()) {
    const box = await option.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(520);
  }
});
