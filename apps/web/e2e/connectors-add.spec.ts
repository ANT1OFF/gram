import { expect, test } from "@playwright/test";

import { slowdown } from "./slowdown";

import { openAdvancedPage } from "./settings-nav";
import { threadRow } from "./thread-row";

test("adds an MCP server from the Connectors panel and removes it again", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Connectors", exact: true }).click();
  const connectors = panel.getByTestId("connector");
  await expect(connectors).toHaveCount(7);

  await panel.getByRole("button", { name: "Add server…" }).click();
  const form = panel.getByRole("form", { name: "Add MCP server" });
  await form.getByRole("textbox", { name: "Server name" }).fill("docs");
  await form.getByRole("textbox", { name: "URL" }).fill("https://personal.example.invalid/mcp");
  await form.getByRole("textbox", { name: "Headers" }).fill("Authorization: Bearer sekrit-token");
  await form.getByRole("radio", { name: "Project" }).click();
  await expect(form.getByRole("checkbox", { name: "Claude Code" })).toBeChecked();
  await expect(form.getByTestId("scope-hint")).toContainText(".mcp.json");
  await form.getByRole("button", { name: "Add server" }).click();

  await expect(panel.getByRole("status")).toContainText("Added docs.");
  await expect(form).toBeHidden();
  const docs = panel.getByRole("listitem", { name: "docs", exact: true });
  await expect(docs).toContainText("Connected");
  await expect(docs).toContainText("project");
  await expect(panel).not.toContainText("sekrit-token");

  await docs.getByRole("button", { name: "Remove" }).click();
  await expect(panel.getByRole("status")).toContainText("Removed docs.");
  await expect(connectors).toHaveCount(7);
});

test("adds an OAuth server for two agents, then signs in through the agent", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Connectors", exact: true }).click();
  await expect(panel.getByTestId("connector")).toHaveCount(7);

  await panel.getByRole("button", { name: "Add server…" }).click();
  const form = panel.getByRole("form", { name: "Add MCP server" });
  await form.getByRole("textbox", { name: "Server name" }).fill("example");
  await form.getByRole("textbox", { name: "URL" }).fill("https://personal.example.invalid/example");
  await form.getByRole("checkbox", { name: "Codex" }).click();
  await expect(form.getByTestId("scope-hint")).toContainText("Codex: its config.toml");
  await expect(form.getByTestId("scope-hint")).toContainText("Each agent keeps its own sign-in");
  await form.getByRole("button", { name: "Add server" }).click();
  await expect(panel.getByRole("status")).toContainText("Added example to Claude Code, Codex.");

  const added = await page.evaluate(() => window.gramMock!.connectorAdds.at(-1));
  expect(added).toMatchObject({ name: "example", targets: ["claude", "codex"] });

  // No credentials of its own, so it comes up waiting for its OAuth sign-in.
  const example = panel.getByTestId("connector").filter({ hasText: "example" });
  await expect(example).toContainText("Not signed in");
  await example.getByRole("button", { name: "Sign in" }).click();
  await expect(example).toContainText("Waiting for sign-in…");
  await expect(panel.getByRole("status")).toContainText("Gram never sees it");
  expect(await page.evaluate(() => window.gramMock!.opened)).toContain(
    "https://idp.example/authorize?server=example",
  );

  // The panel keeps asking the agent until it has the token.
  await expect(example).toContainText("Connected", { timeout: 10_000 * slowdown });
  await expect(panel.getByRole("status")).toContainText("Signed in to example.");
});

test("Settings → Connectors shows every agent's servers and copies one across", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/settings");
  await openAdvancedPage(page, "Connectors");
  await expect(page).toHaveURL(/\/settings\/connectors$/);
  const settings = page.getByTestId("connectors-settings");
  // The folded group keeps its rows in the page, hidden.
  const rows = settings.getByTestId("configured-connector").filter({ visible: true });
  const row = (name: string) => settings.getByRole("row", { name, exact: true });

  // The short two-harness list starts expanded; folding retains the hidden historical row.
  await expect(rows).toHaveCount(5);
  await expect(row("github")).toContainText("Signed in");
  const fold = settings.getByRole("button", { name: /Not signed in/ });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(fold).toContainText("1");
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(rows).toHaveCount(4);
  await fold.click();
  await expect(row("linear")).toContainText("claude.ai");
  // Opening the page asked nobody to connect anything.
  expect(
    await page.evaluate(() =>
      window.gramMock!.configuredConnectorReads.some((read) => read.checkSignIn !== undefined),
    ),
  ).toBe(false);

  await expect(settings.getByRole("searchbox", { name: "Filter connectors" })).toHaveCount(0);
  await row("registry").getByRole("button", { name: "Add registry to Codex" }).click();
  await expect(settings.getByRole("status")).toContainText("Added registry to Codex.");
  const added = await page.evaluate(() => window.gramMock!.connectorAdds.at(-1));
  expect(added).toEqual({
    scope: "user",
    name: "registry",
    config: { type: "http", url: "https://personal.example.invalid/registry" },
    targets: ["codex"],
  });

  // Codex signs in on request; the page waits for the result.
  await row("registry").getByRole("button", { name: "Sign in to registry in Codex" }).click();
  await expect(row("registry")).toContainText("Waiting for sign-in…");
  // Codex discovers sign-ins only on request; advance the invented OAuth completion timer.
  await page.clock.runFor(500);
  await settings.getByRole("button", { name: "Check sign-ins", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("Signed in to registry.", {
    timeout: 10_000 * slowdown,
  });

  await row("registry").getByRole("button", { name: "registry in Codex actions" }).click();
  await page.getByRole("menuitem", { name: "Remove from Codex…" }).click();
  await row("registry").getByRole("button", { name: "Remove server" }).click();
  await expect(settings.getByRole("status")).toContainText("Removed registry from Codex.");
  await expect(
    row("registry").getByRole("button", { name: "Add registry to Codex" }),
  ).toBeVisible();

  // Claude Code signs in with no thread running: it opens the browser itself.
  await row("example").getByRole("button", { name: "Sign in to example in Claude Code" }).click();
  await expect(settings.getByRole("status")).toContainText("Signed in to example.", {
    timeout: 10_000 * slowdown,
  });

  // A project brings Claude Code's per-project servers into view.
  await settings.getByRole("combobox", { name: "Show servers for" }).click();
  // The picker's own list: the sidebar's PR filters are native selects with options too.
  await page.getByRole("listbox").getByRole("option").nth(1).click();
  await expect(row("files")).toContainText("local");
});

test("Settings → Connectors shows claude.ai connectors as last seen and signs in on claude.ai", async ({
  page,
}) => {
  await page.goto("/settings/connectors");
  const settings = page.getByTestId("connectors-settings");
  const linear = settings.getByRole("row", { name: "linear", exact: true });
  await expect(settings.getByRole("button", { name: /Not signed in/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  // No Claude thread runs: the row is what one last said, and when.
  await expect(linear).toContainText("Signed out");
  await expect(linear).toContainText("as of");
  await expect(settings).toContainText("as a Claude thread last reported them");

  await linear.getByRole("button", { name: "Sign in to linear in Claude Code" }).click();
  await expect(settings.getByRole("status")).toContainText(
    "Finish signing in to linear on claude.ai",
  );
  expect(await page.evaluate(() => window.gramMock!.opened)).toContain(
    "https://claude.ai/api/organizations/o/mcp/start-auth/linear",
  );
  // Nothing hears when claude.ai is done, so the row doesn't wait for it.
  await expect(linear).not.toContainText("Waiting for sign-in…");
});

test("Settings → Connectors adds a personal server to each chosen agent", async ({ page }) => {
  await page.goto("/settings/connectors");
  const settings = page.getByTestId("connectors-settings");
  await expect(settings.getByTestId("configured-connector").first()).toBeVisible();
  await expect(settings.getByRole("button", { name: "Browse servers" })).toHaveCount(0);
  expect(await page.evaluate(() => window.gramMock!.catalogueReads.length)).toBe(0);

  await settings.getByRole("button", { name: "Add server…" }).click();
  const form = settings.getByRole("form", { name: "Add MCP server" });
  await form.getByRole("textbox", { name: "Server name" }).fill("personal-docs");
  await form.getByRole("textbox", { name: "URL" }).fill("https://docs.example.invalid/mcp");
  await form.getByRole("checkbox", { name: "Codex" }).check();
  await expect(form.getByTestId("scope-hint")).toContainText("Each agent keeps its own sign-in");
  await form.getByRole("button", { name: "Add server" }).click();
  await expect(settings.getByRole("status")).toContainText(
    "Added personal-docs to Claude Code, Codex.",
  );
  expect(await page.evaluate(() => window.gramMock!.connectorAdds.at(-1))).toEqual({
    scope: "user",
    name: "personal-docs",
    config: { type: "http", url: "https://docs.example.invalid/mcp" },
    targets: ["claude", "codex"],
  });
  const row = settings.getByRole("row", { name: "personal-docs", exact: true });
  await expect(row).toContainText("Not signed in");
  for (const agent of ["Claude Code", "Codex"]) {
    await expect(
      row.getByRole("button", { name: `Sign in to personal-docs in ${agent}` }),
    ).toBeVisible();
  }
  expect(await page.evaluate(() => window.gramMock!.catalogueReads.length)).toBe(0);
});

test("a Claude session loads an added server in place, and restarts after a removal", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.gramMockHoldGates = true;
  });
  await page.goto("/t/t-flaky");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Connectors", exact: true }).click();
  await panel.getByRole("button", { name: "Add server…" }).click();
  const form = panel.getByRole("form", { name: "Add MCP server" });
  await form.getByRole("textbox", { name: "Server name" }).fill("docs");
  await form.getByRole("textbox", { name: "URL" }).fill("https://personal.example.invalid/mcp");
  await form.getByRole("radio", { name: "Project" }).click();
  await form.getByRole("button", { name: "Add server" }).click();
  await expect(panel.getByRole("status")).toContainText("Added docs. The session loaded it.");
  const pending = page.getByTestId("pending-restart");
  await expect(pending).toBeHidden();

  // A removal can't be loaded in place: the composer says a restart waits for the turn.
  const docs = panel.getByRole("listitem", { name: "docs", exact: true });
  await docs.getByRole("button", { name: "Remove" }).click();
  await expect(panel.getByRole("status")).toContainText("Removed docs.");
  await expect(pending).toBeVisible();
  const markers = page.getByTestId("session-restart");
  await expect(markers).toHaveCount(0);
  await page.evaluate(() => window.gramMock?.release("flaky-read"));
  await page.getByTestId("approval-card").getByTestId("approval-allow").click({ timeout: 20_000 });
  await expect(markers).toHaveText(/^Session restarted · MCP config changed · \d\d:\d\d/, {
    timeout: 30_000 * slowdown,
  });
  await expect(pending).toBeHidden();
});

test("signing in from Settings restarts the agent's idle sessions", async ({ page }) => {
  await page.clock.install();
  await page.goto("/t/t-release");
  // The mock is up once the sidebar has its threads.
  await expect(threadRow(page, "t-release")).toBeVisible();
  const threadId = await page.evaluate(
    async () =>
      (
        await window.gramMock!.createThread({
          projectRoot: "/Users/dev/code/api",
          checkout: { kind: "current" },
          model: { agent: "codex", model: "gpt-5.5" },
          title: "On Codex",
        })
      ).id,
  );
  await threadRow(page, threadId).click();
  await expect(page).toHaveURL(new RegExp(`/t/${threadId}$`));

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await openAdvancedPage(page, "Connectors");
  const settings = page.getByTestId("connectors-settings");
  const example = settings.getByRole("row", { name: "example", exact: true });
  await example.getByRole("button", { name: "Sign in to example in Codex" }).click();
  await page.clock.runFor(500);
  await settings.getByRole("button", { name: "Check sign-ins", exact: true }).click();
  await expect(settings.getByRole("status")).toContainText("Signed in to example.", {
    timeout: 10_000 * slowdown,
  });

  // Connectors, Advanced, then the page Settings opened on.
  await page.goBack();
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/t/${threadId}$`));
  await expect(page.getByTestId("session-restart")).toHaveText(
    /^Session restarted · MCP config changed · \d\d:\d\d/,
  );
  // A Claude thread, which the sign-in doesn't touch, kept its session.
  await threadRow(page, "t-release").click();
  await expect(page.getByTestId("session-restart")).toHaveCount(0);
});

test("gives a claude.ai connector's server to Codex, which signs in itself", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Connectors", exact: true }).click();
  const kb = panel.getByRole("listitem", { name: "claude.ai Personal Docs" });
  await expect(kb).toContainText("Connected");

  // Its tools, folded to a count, with the hints the server gives.
  await kb.getByRole("button", { name: "4 tools of claude.ai Personal Docs" }).click();
  const tools = kb.getByRole("list", { name: "Tools of claude.ai Personal Docs" });
  await expect(tools.getByRole("listitem")).toHaveCount(4);
  await expect(tools.getByRole("img", { name: /^Read-only/ })).toHaveCount(2);
  await expect(tools.getByRole("img", { name: /^Destructive/ })).toHaveCount(1);

  await kb.getByRole("button", { name: "Use claude.ai Personal Docs with another agent" }).click();
  await kb.getByRole("button", { name: "Use with Codex" }).click();
  const form = panel.getByRole("form", { name: "Add MCP server" });
  await expect(form.getByRole("textbox", { name: "Server name" })).toHaveValue("personal-docs");
  await expect(form.getByRole("textbox", { name: "URL" })).toHaveValue(
    "https://mcp.example.invalid/personal-docs",
  );
  await expect(form.getByRole("checkbox", { name: "Codex" })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: "Claude Code" })).not.toBeChecked();
  await expect(panel).toContainText("your Claude sign-in isn't shared");
  // The server may require claude.ai; copying its address never copies that sign-in.
  await expect(panel).toContainText("accept only claude.ai's sign-in");
  await form.getByRole("button", { name: "Add server" }).click();

  await expect(panel.getByRole("status")).toContainText("Added personal-docs to Codex.");
  const added = await page.evaluate(() => window.gramMock!.connectorAdds.at(-1));
  expect(added).toEqual({
    scope: "user",
    name: "personal-docs",
    config: { type: "http", url: "https://mcp.example.invalid/personal-docs" },
    targets: ["codex"],
  });
});
