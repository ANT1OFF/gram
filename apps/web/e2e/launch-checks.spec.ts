import { expect, test } from "@playwright/test";

import { openAdvancedPage } from "./settings-nav";

const MOCK_LAUNCH_CHECKS_KEY = "gram.mock.launchChecks";
const MOCK_SETTINGS_KEY = "gram.mock.settings";

test("agent details explain native Codex and immutable Claude Code update ownership", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const codexPath =
      "/mock/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin/bin/codex";
    const claudePath = "/mock/profile/bin/claude";
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [
          { tool: "claude", found: true, version: "2.1.286" },
          { tool: "git", found: true },
          { tool: "gh", found: true },
          { tool: "codex", found: true, path: codexPath, version: "0.159.2" },
          { tool: "claude", found: true, path: claudePath },
        ],
        claudeSignIn: "signedIn",
        codexSignIn: "signedIn",
        ghSignedIn: true,
      }),
    );
    sessionStorage.setItem(
      "gram.mock.agentRuntimes",
      JSON.stringify({
        agents: [
          {
            agent: "codex",
            resolved: { source: "path", path: codexPath, version: "0.159.2" },
            installation: {
              installer: "native",
              realPath: codexPath,
              updateNote:
                "Codex's standalone updater (`codex update`) installs latest and cannot pin a version. Gram can run it only when the latest release has passed its compatibility and release-age checks.",
            },
            baseline: {
              cliVersion: "0.160.1",
              binding: "codex-protocol",
              bindingVersion: "0.160.1",
            },
            verdict: "unsupported",
            installSteps: [],
          },
          {
            agent: "claude",
            resolved: { source: "path", path: claudePath },
            installation: {
              installer: "nix",
              realPath: "/nix/store/synthetic-claude-2.1.273/bin/claude",
              updateNote:
                "Nix owns this installation in its immutable store. Update your Home Manager configuration, then Re-check.",
            },
            baseline: { cliVersion: "2.1.273", binding: "claude-sdk", bindingVersion: "0.3.168" },
            verdict: "unknown",
            installSteps: [],
          },
        ],
      }),
    );
  });
  await page.goto("/settings/agents");
  const agents = page.getByTestId("agent-checks");
  for (const name of ["Codex", "Claude Code"]) {
    const row = agents.getByRole("group", { name, exact: true });
    await row.getByRole("button", { name: `${name} details` }).click();
    await expect(row.getByTestId("runtime-update-note")).toBeVisible();
    await expect(row.getByTestId("cli-update")).toHaveCount(0);
    await expect(row.getByTestId("runtime-steps")).toHaveCount(0);
    await expect(row.getByRole("button", { name: /^Copy/ })).toHaveCount(0);
  }
  await expect(agents.getByRole("group", { name: "Codex", exact: true })).toContainText(
    "cannot pin a version",
  );
  const claude = agents.getByRole("group", { name: "Claude Code", exact: true });
  await expect(claude).toContainText("Nix / Home Manager");
  await expect(claude).toContainText("/nix/store/synthetic-claude-2.1.273/bin/claude");
});

test("launch checks show what's missing, link to details and dismiss for the session", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        tools: [
          { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.273" },
          { tool: "git", found: true, path: "/usr/bin/git", version: "2.47.1" },
          { tool: "gh", found: false },
        ],
        claudeSignIn: "notSignedIn",
        ghSignedIn: false,
      }),
    );
  }, MOCK_LAUNCH_CHECKS_KEY);
  await page.goto("/");

  const banner = page.getByTestId("launch-checks-banner");
  await expect(banner).toContainText("Claude Code isn't signed in. Run claude in a terminal");
  await expect(banner).toContainText("gh isn't installed. PR badges and reviews are off.");

  // The app's link-styled buttons (`Button render={<Link />}`) carry the button role.
  await banner.getByText("Details", { exact: true }).click();
  const tools = page.getByTestId("tool-checks");
  await expect(tools).toContainText("2.1.273 at /mock/bin/claude, not signed in");
  await expect(tools).toContainText("not found on the login-shell PATH");

  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toBeHidden();
  await page.reload();
  await expect(tools).toContainText("not signed in");
  await expect(banner).toBeHidden();
});

test("an outdated Codex in use shows the upgrade command, and Diagnostics names a stray install", async ({
  page,
}) => {
  await page.addInitScript((key) => {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        tools: [
          { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.273" },
          { tool: "git", found: true, path: "/usr/bin/git", version: "2.47.1" },
          { tool: "gh", found: true, path: "/mock/bin/gh", version: "2.63.0" },
          {
            tool: "codex",
            found: true,
            path: "/mock/nvm/bin/codex",
            version: "0.153.4",
            testedVersion: "0.154.0",
            upgradeCommand: "npm i -g @openai/codex@0.154.0",
          },
        ],
        claudeSignIn: "signedIn",
        ghSignedIn: true,
        agentsInUse: ["codex"],
      }),
    );
    // What the server's resolver makes of the same probe: an old npm install of Codex.
    sessionStorage.setItem(
      "gram.mock.agentRuntimes",
      JSON.stringify({
        agents: [
          {
            agent: "codex",
            resolved: { source: "path", path: "/mock/nvm/bin/codex", version: "0.153.4" },
            baseline: {
              cliVersion: "0.154.0",
              binding: "codex-protocol",
              bindingVersion: "0.154.0",
            },
            verdict: "graceful",
            reason: "Codex 0.153.4 is older than the 0.154.0 Gram is built for.",
            installSteps: [
              {
                installer: "npm",
                command: "npm i -g @openai/codex@0.154.0",
                exact: true,
                version: "0.154.0",
              },
            ],
          },
        ],
      }),
    );
  }, MOCK_LAUNCH_CHECKS_KEY);
  await page.goto("/");

  const banner = page.getByTestId("launch-checks-banner");
  await expect(banner).toContainText(
    "Codex 0.153.4 is older than the 0.154.0 Gram is tested with. Some features may not work. Upgrade with npm i -g @openai/codex@0.154.0.",
  );

  await banner.getByText("Details", { exact: true }).click();
  const tools = page.getByTestId("tool-checks");
  await expect(tools).toContainText(
    "0.153.4 at /mock/nvm/bin/codex, ChatGPT login, tested with 0.154.0",
  );

  await expect(tools).toContainText("gateway threads use your skills in /mock/home/.codex/skills");

  // Settings → Agents marks only the trouble, with the upgrade to copy.
  await page.goto("/settings/agents");
  const agents = page.getByTestId("agent-checks");
  await expect(agents.getByRole("group", { name: "Codex" })).toContainText("older than 0.154.0");
  await expect(
    agents.getByRole("button", { name: "Copy the fix: npm i -g @openai/codex@0.154.0" }),
  ).toBeVisible();

  await expect(agents.locator("[data-trouble]")).toHaveCount(1);
});

const toolsWithGh = (gh: object) => [
  { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.273" },
  { tool: "git", found: true, path: "/usr/bin/git", version: "2.47.1" },
  { tool: "gh", ...gh },
];

test("a dismissed problem shows again when the check result changes", async ({ page }) => {
  await page.addInitScript(
    ({ key, checks }) => {
      // Only the first load: later ones keep whatever the spec changed it to.
      if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, checks);
    },
    {
      key: MOCK_LAUNCH_CHECKS_KEY,
      checks: JSON.stringify({ tools: toolsWithGh({ found: false }), ghSignedIn: false }),
    },
  );
  await page.goto("/");

  const banner = page.getByTestId("launch-checks-banner");
  await expect(banner).toHaveText(/gh isn't installed/);
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toBeHidden();
  await page.reload();
  await expect(page.getByTestId("welcome")).toBeVisible();
  await expect(banner).toBeHidden();

  await page.evaluate(({ key, checks }) => sessionStorage.setItem(key, checks), {
    key: MOCK_LAUNCH_CHECKS_KEY,
    checks: JSON.stringify({
      tools: toolsWithGh({ found: true, path: "/mock/bin/gh", version: "2.63.0" }),
      ghSignedIn: false,
    }),
  });
  await page.reload();
  await expect(banner).toContainText("gh isn't signed in. Run gh auth login");
  await expect(banner).not.toContainText("gh isn't installed");
});

test("first run is one screen: pick a repository, with the tools beside it", async ({ page }) => {
  // Only Codex, signed in: set here, never the machine's own CLIs.
  await page.addInitScript(({ key, checks }) => sessionStorage.setItem(key, checks), {
    key: MOCK_LAUNCH_CHECKS_KEY,
    checks: JSON.stringify({
      tools: [
        { tool: "codex", found: true, version: "0.160.0" },
        { tool: "git", found: true, version: "2.47.1" },
        { tool: "gh", found: true, version: "2.63.0" },
      ],
      claudeSignIn: "notSignedIn",
      codexSignIn: "signedIn",
      ghSignedIn: true,
      localAgentsInUse: ["codex"],
    }),
  });
  await page.goto("/");
  const welcome = page.getByTestId("welcome");
  await expect(welcome.getByRole("heading", { name: "Pick a repository to start" })).toBeVisible();
  const tools = welcome.getByRole("list", { name: "Tools" }).getByRole("listitem");
  await expect(tools).toHaveText([/Claude Code/, /Codex/, /git/, /GitHub CLI/]);
  // Codex alone is enough: Claude Code missing is nothing to fix.
  await expect(tools.first()).toHaveAttribute("data-state", "optional");
  await expect(tools.nth(1)).toHaveAttribute("data-state", "ready");
  await expect(welcome.getByRole("button", { name: "Check again" })).toHaveCount(0);
  await expect(page.getByTestId("launch-checks-banner")).toBeHidden();
  await expect(page.getByText("Select a thread, or start a new one.")).toHaveCount(0);
  await expect(welcome.getByRole("form", { name: "Connect the AI gateway" })).toHaveCount(0);

  // Looking at it isn't finishing it: it is back after a reload, and after leaving the sheet.
  await page.reload();
  await welcome.getByRole("button", { name: /^web/ }).click();
  await expect(page).toHaveURL(/\/new-workspace\?repo=p-web$/);
  const sheet = page.getByRole("form", { name: "New workspace" });
  await expect(sheet.getByTestId("new-workspace-repo")).toHaveText(["web"]);
  await expect(sheet.getByLabel("What should it work on?")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(welcome).toBeVisible();

  // Making the workspace finishes it.
  await welcome.getByRole("button", { name: /^web/ }).click();
  await sheet.getByTestId("new-workspace-start").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName("Orchestrator: web");
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) ?? "{}").onboarding?.welcomeSeen,
        MOCK_SETTINGS_KEY,
      ),
    )
    .toBe(true);
  // Optional gateways stay in Settings; subscription onboarding never prompts for a key.
  await expect(page.getByTestId("gateway-offer")).toHaveCount(0);
});

test("first run can be skipped for good", async ({ page }) => {
  await page.goto("/");
  const welcome = page.getByTestId("welcome");
  await welcome.getByRole("button", { name: "Skip" }).click();
  await expect(welcome).toBeHidden();
  await expect(page.getByText("Select a thread, or start a new one.")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(sessionStorage.getItem(key) ?? "{}").onboarding?.welcomeSeen,
        MOCK_SETTINGS_KEY,
      ),
    )
    .toBe(true);
  await page.reload();
  await expect(page.getByText("Select a thread, or start a new one.")).toBeVisible();
  await expect(welcome).toBeHidden();
});

test("settings navigation reaches optional gateways and persists review bots", async ({ page }) => {
  await page.goto("/settings");
  await openAdvancedPage(page, "Gateways");
  await expect(page).toHaveURL(/\/settings\/gateways$/);
  await page.goBack();

  await page.getByTestId("settings-subpages").getByRole("link", { name: "Review bots" }).click();
  const bots = page.getByTestId("review-bots");
  await expect(bots.getByRole("listitem")).toHaveCount(0);
  await bots.getByRole("button", { name: "Add bot" }).click();
  const added = bots.getByRole("listitem", { name: "Review bot 1" });
  await added.getByLabel("Login pattern").fill("copilot bot");
  await bots.getByRole("button", { name: "Save" }).click();
  await expect(added.getByRole("alert")).toHaveText(
    "Use letters, digits, hyphens and * wildcards, optionally ending in [bot].",
  );
  await added.getByLabel("Login pattern").fill("copilot[bot]");
  await added.getByLabel("Re-review command").fill("@copilot review");
  await bots.getByRole("button", { name: "Save" }).click();
  await expect(bots.getByRole("status")).toHaveText("Review bots saved.");

  await page.reload();
  await expect(
    page
      .getByTestId("review-bots")
      .getByRole("listitem", { name: "Review bot 1" })
      .getByLabel("Login pattern"),
  ).toHaveValue("copilot[bot]");
});

test("Settings → Agents shows newer releases, their wait and steps, and updates Codex in its store", async ({
  page,
}) => {
  const day = 86_400_000;
  await page.addInitScript(
    ({ key, day: d }) => {
      const now = Date.now();
      sessionStorage.setItem(
        key,
        JSON.stringify({
          agents: [
            {
              agent: "claude",
              resolved: { source: "path", path: "/mock/bin/claude", version: "2.1.284" },
              baseline: {
                cliVersion: "2.1.284",
                binding: "claude-agent-sdk",
                bindingVersion: "0.3.284",
              },
              verdict: "supported",
              newer: {
                version: "2.1.286",
                channel: "stable",
                publishedAt: now - d / 4,
                eligibleAt: now + (3 * d) / 4,
                eligible: false,
                verdict: "supported",
              },
              installSteps: [],
            },
            {
              agent: "codex",
              resolved: { source: "path", path: "/mock/bin/codex", version: "0.159.2" },
              baseline: {
                cliVersion: "0.159.2",
                binding: "codex-protocol",
                bindingVersion: "0.159.2",
              },
              verdict: "supported",
              newer: {
                version: "0.159.4",
                channel: "stable",
                publishedAt: now - 2 * d,
                eligibleAt: now - d,
                eligible: true,
                verdict: "supported",
              },
              installSteps: [
                {
                  installer: "npm",
                  command: "npm i -g @openai/codex@0.159.4",
                  exact: true,
                  version: "0.159.4",
                },
              ],
              managed: { candidate: { version: "0.159.4", channel: "stable" } },
            },
          ],
        }),
      );
    },
    { key: "gram.mock.agentRuntimes", day },
  );
  await page.goto("/settings/agents");
  const agents = page.getByTestId("agent-checks");
  const claude = agents.getByRole("group", { name: "Claude Code" });
  const codex = agents.getByRole("group", { name: "Codex" });

  await expect(claude.getByTestId("runtime-newer")).toHaveAttribute("data-kind", "waiting");
  await expect(claude).toContainText(/2\.1\.286 after/);

  await expect(codex).toContainText("0.159.4 available");

  await codex.getByRole("button", { name: "Codex details" }).click();
  const details = codex.getByTestId("runtime-details");
  await expect(details).toContainText("/mock/bin/codex");
  await expect(details).toContainText("app-server protocol generated from Codex 0.159.2");
  await expect(details.getByTestId("runtime-steps")).toContainText(
    "npm i -g @openai/codex@0.159.4",
  );

  await codex.getByTestId("runtime-update").click();
  await expect(codex.getByTestId("runtime-progress")).toBeVisible();
  await expect(codex.getByTestId("runtime-update")).toBeHidden();
  // Installed, but the user's own codex stays in use until they choose the verified one.
  const store = details.getByTestId("managed-runtime");
  const useManaged = store.getByRole("switch", { name: "Use Gram-managed Codex" });
  await expect(store).toContainText("A verified Codex (0.159.4) for when yours is missing");
  await expect(useManaged).not.toBeChecked();
  await expect(codex.getByTestId("runtime-source")).toBeHidden();
  await useManaged.click();
  await expect(codex.getByTestId("runtime-source")).toHaveText("managed");
  await expect(codex).toContainText("0.159.4");
  await expect(codex.getByTestId("runtime-newer")).toBeHidden();
  await expect(useManaged).toBeChecked();
  await useManaged.click();
  await expect(codex.getByTestId("runtime-source")).toBeHidden();
  await expect(useManaged).not.toBeChecked();
  // One version installed: nothing to roll back to yet.
  await expect(store.getByTestId("runtime-rollback")).toBeHidden();
  // Claude Code isn't in the store, so their details carry no store controls.
  await claude.getByRole("button", { name: "Claude Code details" }).click();
  await expect(claude.getByTestId("managed-runtime")).toHaveCount(0);
});

test("Update runs an outdated Claude Code's own upgrade after a confirm, then shows the new version", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [
          { tool: "git", found: true, path: "/usr/bin/git", version: "2.47.1" },
          { tool: "gh", found: true, path: "/mock/bin/gh", version: "2.63.0" },
          {
            tool: "claude",
            found: true,
            path: "/mock/.claude/bin/claude",
            version: "2.1.272",
            testedVersion: "2.1.273",
          },
        ],
        claudeSignIn: "signedIn",
        ghSignedIn: true,
      }),
    );
    sessionStorage.setItem(
      "gram.mock.agentRuntimes",
      JSON.stringify({
        agents: [
          {
            agent: "claude",
            resolved: { source: "path", path: "/mock/.claude/bin/claude", version: "2.1.272" },
            baseline: { cliVersion: "2.1.273", binding: "claude-sdk", bindingVersion: "0.3.168" },
            verdict: "graceful",
            reason: "Claude Code 2.1.272 is older than the 2.1.273 Gram is built for.",
            installSteps: [
              {
                installer: "native",
                command: "claude update",
                latest: true,
                exact: false,
                version: "2.1.273",
                run: ["claude", "update"],
              },
              {
                installer: "npm",
                command: "npm i -g @anthropic-ai/claude-code@2.1.273",
                exact: true,
                version: "2.1.273",
              },
            ],
          },
        ],
      }),
    );
  });
  await page.goto("/settings/agents");
  const claude = page.getByTestId("agent-checks").getByRole("group", { name: "Claude Code" });
  await expect(claude).toContainText("2.1.272");
  // Copying the command stays the fallback beside Update.
  await expect(claude.getByRole("button", { name: /^Copy .*claude update/ })).toBeVisible();

  await claude.getByTestId("cli-update").click();
  const panel = claude.getByTestId("cli-update-panel");
  // One confirm, showing exactly what will run; Cancel closes it with nothing run.
  await expect(panel).toHaveAttribute("data-state", "confirm");
  await expect(panel).toContainText("claude update");
  await expect(panel.getByTestId("cli-update-executable")).toHaveText(
    "as /mock/.claude/bin/claude",
  );
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel).toBeHidden();

  await claude.getByTestId("cli-update").click();
  await panel.getByTestId("cli-update-run").click();
  await expect(panel).toHaveAttribute("data-state", "running");
  await expect(panel.getByTestId("cli-update-output")).toContainText("Checking for claude updates");
  await expect(panel).toHaveAttribute("data-state", "succeeded");
  await expect(panel.getByTestId("cli-update-message")).toHaveText(
    "Updated Claude Code to 2.1.273.",
  );
  // The row probed again by itself: the new version, and nothing left to update.
  await expect(claude).toContainText("2.1.273");
  await expect(claude).toContainText("New threads use 2.1.273.");
  await expect(claude).toContainText("they keep 2.1.272 until restarted.");
  await expect(claude.getByTestId("cli-update")).toBeHidden();
  await panel.getByRole("button", { name: "Dismiss" }).click();
  await expect(panel).toBeHidden();
});

test("the banner updates an outdated Codex in one click, shows a failure inline, and goes once updated", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        tools: [
          { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.273" },
          { tool: "git", found: true, path: "/usr/bin/git", version: "2.47.1" },
          { tool: "gh", found: true, path: "/mock/bin/gh", version: "2.63.0" },
          {
            tool: "codex",
            found: true,
            path: "/mock/.codex/bin/codex",
            version: "0.162.0",
            testedVersion: "0.162.1",
            upgradeCommand: "codex update",
          },
        ],
        claudeSignIn: "signedIn",
        codexSignIn: "signedIn",
        ghSignedIn: true,
        agentsInUse: ["codex"],
      }),
    );
    sessionStorage.setItem(
      "gram.mock.agentRuntimes",
      JSON.stringify({
        agents: [
          {
            agent: "codex",
            resolved: { source: "path", path: "/mock/.codex/bin/codex", version: "0.162.0" },
            baseline: {
              cliVersion: "0.162.1",
              binding: "codex-protocol",
              bindingVersion: "0.162.1",
            },
            verdict: "graceful",
            installSteps: [
              {
                installer: "native",
                command: "codex update",
                latest: true,
                exact: false,
                version: "0.162.1",
                run: ["codex", "update"],
              },
            ],
          },
        ],
      }),
    );
  });
  await page.goto("/");
  const banner = page.getByTestId("launch-checks-banner");
  await expect(banner).toContainText("Codex 0.162.0 is older than the 0.162.1");
  const update = banner.getByRole("button", { name: "Update Codex" });

  await page.evaluate(() => {
    window.gramMock!.cliUpdates.fail = true;
  });
  await update.click();
  const outcome = banner.getByTestId("banner-cli-update");
  await expect(outcome).toHaveAttribute("data-state", "failed");
  await expect(outcome).toContainText("npm registry sign-in expired: run npm login");
  await expect(banner.getByRole("button", { name: "Copy codex update" })).toBeVisible();

  await page.evaluate(() => {
    window.gramMock!.cliUpdates.stepMs = 600;
  });
  await update.click();
  await expect(outcome).toHaveAttribute("data-state", "running");
  await expect(banner).toBeHidden();
});

test("an update that finishes while Settings → Agents is closed shows its outcome on return", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "gram.mock.agentRuntimes",
      JSON.stringify({
        agents: [
          {
            agent: "claude",
            resolved: { source: "path", path: "/mock/bin/claude", version: "2.1.273" },
            baseline: { cliVersion: "2.1.273", binding: "claude-sdk", bindingVersion: "0.3.168" },
            verdict: "supported",
            installSteps: [
              {
                installer: "npm",
                command: "npm i -g @anthropic-ai/claude-code@2.1.274",
                exact: true,
                version: "2.1.274",
                run: ["npm", "i", "-g", "@anthropic-ai/claude-code@2.1.274"],
              },
            ],
          },
        ],
      }),
    );
  });
  await page.goto("/settings/agents");
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  const claude = page.getByTestId("agent-checks").getByRole("group", { name: "Claude Code" });
  await claude.getByTestId("cli-update").click();
  await claude.getByTestId("cli-update-run").click();
  await expect(claude.getByTestId("cli-update-panel")).toHaveAttribute("data-state", "running");
  // In-app navigation, so the listing stays cached while the run carries on without the page.
  await sections.getByRole("link", { name: "Appearance" }).click();
  await page.waitForFunction(
    () => JSON.parse(sessionStorage.getItem("gram.mock.updatedClis") ?? "{}").claude === "2.1.274",
  );
  await sections.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(claude.getByTestId("cli-update-panel")).toHaveAttribute("data-state", "succeeded");
  await expect(claude).toContainText("New threads use 2.1.274.");
  await expect(claude).toContainText("they keep 2.1.273 until restarted.");
  await expect(claude.getByTestId("cli-update")).toBeHidden();
});

test("sign-in guidance names the local commands", async ({ page }) => {
  await page.addInitScript((key) => {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        tools: [
          { tool: "claude", found: true, path: "/usr/bin/claude", version: "2.1.273" },
          { tool: "git", found: true, path: "/usr/bin/git", version: "2.47.1" },
          { tool: "gh", found: true, path: "/usr/bin/gh", version: "2.63.0" },
        ],
        claudeSignIn: "notSignedIn",
        ghSignedIn: false,
      }),
    );
  }, MOCK_LAUNCH_CHECKS_KEY);
  await page.goto("/");
  const banner = page.getByTestId("launch-checks-banner");
  await expect(banner).toContainText("claude");
  await expect(banner).toContainText("gh auth login");
});
