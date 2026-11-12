import { expect, test, type Page } from "@playwright/test";

// The acceptance run for mounting Gram in an app of another's: the fixture app consumes only the
// built package, mounts it against the in-memory server, and adds two pages, a navigation group
// and a switcher.

const mounted = async (page: Page, path = "/") => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(path);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-embed-shell", "on");
  return errors;
};

test("the whole app mounts from the built package, with its styles and theme", async ({ page }) => {
  const errors = await mounted(page);
  // Gram's own first screen, drawn by Gram's own code against the in-memory server.
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  await expect(page.getByTestId("shell-titlebar")).toBeVisible();
  // The theme attributes the styles hang on, which Gram's own page sets in its HTML.
  await expect(page.locator("html")).toHaveAttribute("data-palette", "neutral-dark");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme-booting", "");
  // The stylesheet is the package's: the sidebar has its token's colour, not the page default.
  const sidebar = await page
    .getByTestId("overview-sidebar")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(sidebar).not.toBe("rgba(0, 0, 0, 0)");
  // One of Gram's own pages, loaded as a lazy chunk of the package.
  await page.goto("/settings/about");
  await expect(page.getByRole("heading", { name: "About" }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("the sidebar lists the added group, and its page opens inside Gram's shell", async ({
  page,
}) => {
  const errors = await mounted(page);
  const navigation = page.getByTestId("embed-navigation");
  await expect(navigation.getByRole("heading", { name: "Govern" })).toBeVisible();
  const policies = navigation.getByRole("link", { name: "Policies" });
  await expect(policies).not.toHaveAttribute("aria-current", "page");
  await policies.click();

  await expect(page).toHaveURL(/\/govern\/policies$/);
  await expect(page.getByTestId("fixture-policies")).toBeVisible();
  await expect(page.getByTestId("fixture-pathname")).toHaveText("/govern/policies");
  await expect(policies).toHaveAttribute("aria-current", "page");
  // Gram's shell is still around the page: its sidebar and title bar.
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  await expect(page.getByTestId("shell-titlebar")).toBeVisible();
  // The title bar names the page, where Gram's own pages name the workspace and its views.
  await expect(page.getByTestId("embed-page-title")).toHaveText("Policies");
  await expect(page.getByTestId("workspace-switcher-button")).toHaveCount(0);

  // A link of the page's own moves the window without loading it again, and carries a parameter.
  await page.evaluate(() => {
    (window as unknown as { stayed: boolean }).stayed = true;
  });
  await page.getByRole("link", { name: "Agent 42" }).click();
  await expect(page.getByTestId("fixture-agent")).toHaveText("Agent a-42");
  // A page added with no name leaves the title bar as Gram's own pages have it.
  await expect(page.getByTestId("embed-page-title")).toHaveCount(0);
  // Under the group's destination, so it stays marked.
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);

  // A destination may be one of Gram's own pages, and the added page can send the window to one.
  await navigation.getByRole("link", { name: "Spend" }).click();
  await expect(page.getByTestId("usage-overview")).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId("fixture-agent")).toBeVisible();
  expect(errors).toEqual([]);
});

test("an added page opens from its address, and from the palette", async ({ page }) => {
  const errors = await mounted(page, "/govern/agents/a-7");
  await expect(page.getByTestId("fixture-agent")).toHaveText("Agent a-7");

  await page.getByTestId("overview-search").click();
  await page.getByRole("combobox").fill("Policies");
  await page
    .getByRole("option", { name: /Policies/ })
    .first()
    .click();
  await expect(page.getByTestId("fixture-policies")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the switcher is the embedding app's, in the sidebar and then in the title bar", async ({
  page,
}) => {
  const errors = await mounted(page);
  const inSidebar = page.locator('[data-testid="embed-switcher"][data-placement="sidebar"]');
  await expect(inSidebar.getByTestId("fixture-switcher")).toHaveText("Acme / Platform");
  // Its state is its own component's.
  await inSidebar.getByTestId("fixture-switcher").click();
  await expect(inSidebar.getByTestId("fixture-switcher")).toHaveText("Acme / Data");
  await expect(page.locator('[data-placement="titlebar"]')).toHaveCount(0);

  // Compact: a tile in the rail, and the group's destinations as icons.
  await page.getByTestId("overview-compact").click();
  await expect(page.locator('[data-testid="embed-switcher"][data-placement="rail"]')).toBeVisible();
  await expect(
    page.getByTestId("embed-rail-navigation").getByRole("link", { name: "Govern: Policies" }),
  ).toBeVisible();

  // Hidden (the strip leaves hiding to the key): the title bar carries it instead.
  await page.locator("main").click({ position: { x: 600, y: 300 } });
  await page.keyboard.press("ControlOrMeta+b");
  await expect(
    page.locator('[data-testid="embed-switcher"][data-placement="titlebar"]'),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

type Update = { embed: { update: (next: object) => void } };

test("the navigation and the switcher can be replaced after mounting", async ({ page }) => {
  await mounted(page);
  const switcher = page.locator('[data-testid="embed-switcher"][data-placement="sidebar"]');
  await expect(switcher).toBeVisible();
  // What `update` names is replaced; the switcher, not named, stays.
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({
      navigation: [
        {
          id: "build",
          label: "Build",
          items: [{ id: "agents", label: "Agents", to: "/govern/agents/a-1" }],
        },
      ],
    });
  });
  const navigation = page.getByTestId("embed-navigation");
  await expect(navigation.getByRole("heading", { name: "Build" })).toBeVisible();
  await expect(navigation.getByRole("heading", { name: "Govern" })).toHaveCount(0);
  await expect(page.getByTestId("embed-navigation-main")).toHaveCount(0);
  await expect(switcher).toBeVisible();
  await navigation.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByTestId("fixture-agent")).toHaveText("Agent a-1");

  // Named as undefined, it is taken away.
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({ workspaceSwitcher: undefined });
  });
  await expect(page.getByTestId("embed-switcher")).toHaveCount(0);
  await expect(navigation.getByRole("heading", { name: "Build" })).toBeVisible();
});

test("a group can lead the sidebar, above the threads, with counts", async ({ page }) => {
  const errors = await mounted(page);
  const main = page.getByTestId("embed-navigation-main");
  await expect(main.getByRole("heading", { name: "Build" })).toBeVisible();
  const runs = main.getByRole("link", { name: /Runs/ });
  await expect(runs.getByTestId("embed-navigation-count")).toHaveText("3");
  // Above the workspaces and threads, below Needs you and search.
  const top = async (testId: string) =>
    (await page.getByTestId(testId).first().boundingBox())?.y ?? Number.NaN;
  expect(await top("embed-navigation-main")).toBeGreaterThan(await top("overview-search"));
  expect(await top("embed-navigation-main")).toBeLessThan(await top("overview-section-solo"));

  // A count changes through `update`; a group with no heading lists its rows alone.
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({
      navigation: [
        {
          id: "build",
          placement: "main",
          items: [{ id: "runs", label: "Runs", to: "/govern/agents/a-1", count: 0 }],
        },
      ],
    });
  });
  await expect(main.getByRole("heading")).toHaveCount(0);
  await expect(main.getByTestId("embed-navigation-count")).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({
      navigation: [
        {
          id: "build",
          label: "Build",
          placement: "main",
          items: [{ id: "runs", label: "Runs", to: "/govern/agents/a-1", count: 12 }],
        },
      ],
    });
  });
  await expect(main.getByTestId("embed-navigation-count")).toHaveText("12");

  // Compact: the group's tiles above the foot's, a dot on the one with a count.
  await page.getByTestId("overview-compact").click();
  const railMain = page.getByTestId("embed-rail-navigation-main");
  const tile = railMain.getByRole("link", { name: "Build: Runs, 12" });
  await expect(tile.getByTestId("embed-navigation-dot")).toBeVisible();
  expect(await top("embed-rail-navigation-main")).toBeLessThan(await top("overview-rail-history"));
  expect(errors).toEqual([]);
});

test("the sidebar can leave Gram's workspaces and threads out", async ({ page }) => {
  const errors = await mounted(page);
  await expect(page.getByTestId("overview-section-solo")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({ threads: "hidden" });
  });
  await expect(page.getByTestId("overview-section-solo")).toHaveCount(0);
  await expect(page.getByTestId("overview-section-doneToday")).toHaveCount(0);
  // The host's places and Gram's search stay.
  await expect(page.getByTestId("embed-navigation-main")).toBeVisible();
  await expect(page.getByTestId("overview-search")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({ threads: "shown" });
  });
  await expect(page.getByTestId("overview-section-solo")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the right panel can be kept to threads in a repository", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Mounted at `path`, then kept to threads in a repository.
  const codeOnly = async (path: string) => {
    await page.goto(path);
    await page.waitForFunction(() => (window as unknown as Partial<Update>).embed !== undefined);
    await page.evaluate(() => {
      (window as unknown as Update).embed.update({ panel: "code" });
    });
  };
  const toggle = page.getByTestId("titlebar-panels").getByRole("button", { name: /right panel/ });
  // Gram's own default: the toggle on every page.
  await mounted(page);
  await expect(toggle).toBeVisible();
  // Home and an added page: no panel and no toggle, and the key does nothing.
  await codeOnly("/");
  await expect(toggle).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Alt+b");
  await expect(page.getByTestId("right-panel")).toHaveCount(0);
  await page.getByTestId("embed-navigation").getByRole("link", { name: "Policies" }).click();
  await expect(page.getByTestId("fixture-policies")).toBeVisible();
  await expect(toggle).toHaveCount(0);
  await expect(page.getByTestId("right-panel")).toHaveCount(0);
  // A thread outside a repository has neither; one in a worktree keeps both.
  await codeOnly("/t/t-background");
  await expect(page.getByTestId("thread-view")).toBeVisible();
  await expect(toggle).toHaveCount(0);
  await codeOnly("/t/t-flaky");
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId("right-panel")).toBeVisible();
  // Back to Gram's own: the toggle is everywhere again.
  await mounted(page);
  await expect(toggle).toBeVisible();
  expect(errors).toEqual([]);
});

test("a headless server reports no setup problems of its own machine", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // What a headless server answers: it looked for nothing, so no tool and no sign-in. One from
  // before `headless` lists no tool either; a server that looked lists each, found or not.
  const answer = async (from: "headless" | "older" | "looked") => {
    await page.evaluate(
      ([key, value]) => sessionStorage.setItem(key!, value!),
      [
        "gram.mock.launchChecks",
        JSON.stringify({
          tools:
            from === "looked"
              ? ["claude", "codex", "git", "gh"].map((tool) => ({ tool, found: false }))
              : [],
          claudeSignIn: "unknown",
          ghSignedIn: false,
          ...(from === "headless" ? { headless: true } : {}),
        }),
      ],
    );
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible();
  };
  const banner = page.getByTestId("launch-checks-banner");
  const chip = page.getByTestId("launch-issues-chip");
  await mounted(page, "/t/t-flaky");
  await answer("headless");
  // Neither the banner nor its title-bar chip, on a thread in a repository or on home.
  await expect(page.getByTestId("thread-view")).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(chip).toHaveCount(0);
  await page.goto("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(chip).toHaveCount(0);
  await page.goto("/t/t-flaky");
  await answer("older");
  await expect(page.getByTestId("thread-view")).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(chip).toHaveCount(0);
  // A server that looked and found nothing: that is what's missing there.
  await answer("looked");
  await expect(banner).toContainText("Neither Claude Code nor Codex is installed");
  expect(errors).toEqual([]);
});

test("compact, the sidebar is a quiet strip that opens over the page on hover", async ({
  page,
}) => {
  const errors = await mounted(page, "/govern/policies");
  await page.getByTestId("overview-compact").click();
  const strip = page.getByTestId("overview-rail");
  await expect(strip).toHaveAttribute("data-hosted", "");
  // What the open sidebar holds, in its order, and no workspace or thread tiles.
  await expect(strip.getByTestId("embed-switcher")).toBeVisible();
  await expect(strip.getByTestId("overview-rail-needs-you-dot")).toBeVisible();
  await expect(strip.getByTestId("overview-rail-search")).toBeVisible();
  await expect(strip.getByRole("link", { name: "Govern: Policies" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(strip.getByTestId("overview-rail-history")).toBeVisible();
  await expect(page.getByTestId("overview-tile")).toHaveCount(0);
  // Once the column has finished narrowing.
  await expect.poll(async () => (await strip.boundingBox())?.width).toBe(60);
  const mainBox = await page.locator("main").boundingBox();

  // Resting on it opens the sidebar beside it, over the page: the page doesn't move.
  const overlay = page.getByTestId("overview-rail-overlay");
  await strip.hover({ position: { x: 20, y: 400 } });
  await expect(overlay).toBeVisible();
  await expect
    .poll(async () => {
      const [over, beside] = [await overlay.boundingBox(), await strip.boundingBox()];
      return Math.round((over?.x ?? 0) - (beside?.x ?? 0) - (beside?.width ?? 0));
    })
    .toBe(0);
  expect((await page.locator("main").boundingBox())?.x).toBe(mainBox?.x);
  await expect(overlay.getByTestId("embed-navigation-main")).toBeVisible();
  // While it is open the strip's tooltips keep away: the sidebar says each name.
  await strip.getByRole("link", { name: "Build: Home" }).hover();
  await page.waitForTimeout(300);
  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveCount(0);
  // Leaving both closes it.
  await page.mouse.move(900, 400);
  await expect(overlay).toHaveCount(0);

  // Escape closes it; a row picked in it closes it as it goes there.
  await strip.hover({ position: { x: 20, y: 400 } });
  await expect(overlay).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await page.mouse.move(900, 400);
  await strip.hover({ position: { x: 20, y: 400 } });
  await overlay.getByRole("link", { name: "Limits" }).click();
  await expect(page.getByTestId("fixture-cap")).toBeVisible();
  await expect(overlay).toHaveCount(0);

  // The keyboard opens it too, and its pin keeps the sidebar open.
  await page.mouse.move(900, 400);
  await strip.getByTestId("overview-rail-search").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(overlay).toBeVisible();
  await overlay.getByTestId("overview-pin").click();
  await expect(page.getByTestId("overview-rail")).toHaveCount(0);
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  await expect(page.getByTestId("overview-compact")).toBeVisible();
  expect(errors).toEqual([]);
});

test("the embedding app's home is the page at the root, with no first run", async ({ page }) => {
  const errors = await mounted(page);
  await expect(page.getByTestId("fixture-home")).toBeVisible();
  await expect(page.getByTestId("embed-page-title")).toHaveText("Home");
  // Gram's own home and its welcome are not shown.
  await expect(page.getByTestId("home-empty")).toHaveCount(0);
  await expect(page.getByTestId("welcome")).toHaveCount(0);
  const home = page.getByTestId("embed-navigation-main").getByRole("link", { name: "Home" });
  await expect(home).toHaveAttribute("aria-current", "page");
  // Away and back by the group's row.
  await page.getByTestId("embed-navigation-main").getByRole("link", { name: /Runs/ }).click();
  await expect(page.getByTestId("fixture-agent")).toBeVisible();
  await home.click();
  await expect(page.getByTestId("fixture-home")).toBeVisible();
  expect(errors).toEqual([]);
});

test("every thread is on a page of its own, which the sidebar can lead to", async ({ page }) => {
  const errors = await mounted(page);
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({ threads: "hidden" });
  });
  await page.getByTestId("embed-navigation-main").getByRole("link", { name: "Threads" }).click();
  await expect(page).toHaveURL(/\/threads$/);
  const list = page.getByTestId("threads-list");
  const rows = list.getByTestId("threads-row");
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count).toBeGreaterThan(3);
  // Those that need you come first.
  const marks = await rows.evaluateAll((elements) =>
    elements.map((element) => element.hasAttribute("data-needs-you")),
  );
  expect(marks.indexOf(false)).toBeGreaterThan(0);
  expect(marks.slice(marks.indexOf(false))).not.toContain(true);

  // Search narrows the list; a row opens its thread.
  await page.getByTestId("threads-search").fill("date library");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Pick a date library");
  await rows.first().click();
  await expect(page).toHaveURL(/\/t\/[^/]+$/);

  // New task starts one.
  await page.goBack();
  await page.getByTestId("threads-new").click();
  await expect(page).toHaveURL(/\/new/);
  expect(errors).toEqual([]);
});

test("the current place's highlight glides between rows, and pages arrive", async ({ page }) => {
  const errors = await mounted(page, "/govern/policies");
  const navigation = page.getByTestId("embed-navigation");
  const glide = navigation.getByTestId("embed-navigation-glide");
  const over = async (name: string) => {
    const [mark, row] = [
      await glide.boundingBox(),
      await navigation.getByRole("link", { name }).boundingBox(),
    ];
    return Math.round(Math.abs((mark?.y ?? -99) - (row?.y ?? 0)));
  };
  await expect(glide).toBeVisible();
  await expect.poll(() => over("Policies")).toBeLessThanOrEqual(1);
  await navigation.getByRole("link", { name: "Limits" }).click();
  await expect.poll(() => over("Limits")).toBeLessThanOrEqual(1);
  // One highlight for the list: the rows draw none of their own.
  const fill = await navigation
    .getByRole("link", { name: "Limits" })
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(fill).toBe("rgba(0, 0, 0, 0)");
  // The kit's page arrives part by part, and the title bar's name fades in.
  await expect(page.locator('[data-slot="page"]')).toHaveClass(/gram-stagger/);
  await expect(page.getByTestId("embed-page-title")).toHaveClass(/gram-fade/);
  // Off the group's pages, there is nothing to mark.
  await page.getByTestId("embed-navigation-main").getByRole("link", { name: "Threads" }).click();
  await expect(glide).toBeHidden();
  expect(errors).toEqual([]);
});

test("the embedding app can count what needs someone itself", async ({ page }) => {
  const errors = await mounted(page, "/govern/limits");
  const pill = page.getByTestId("overview-needs-you");
  await expect(pill).toContainText("need you");
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({
      attention: { count: 5, label: "5 to review", to: "/govern/policies" },
    });
  });
  await expect(pill).toHaveText("5 to review");
  await pill.click();
  await expect(page.getByTestId("fixture-policies")).toBeVisible();

  // The compact strip's tile follows the same count, and goes to the same place.
  await page.getByTestId("overview-compact").click();
  const tile = page.getByTestId("overview-rail-needs-you");
  await expect(tile).toHaveAccessibleName("5 to review");
  await expect(page.getByTestId("overview-rail-needs-you-dot")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({ attention: { count: 0 } });
  });
  await expect(page.getByTestId("overview-rail-needs-you-dot")).toHaveCount(0);
  await page.getByTestId("overview-rail").hover({ position: { x: 20, y: 400 } });
  await expect(page.getByTestId("overview-rail-overlay")).toBeVisible();
  // At 0 the pill hides.
  await expect(
    page.getByTestId("overview-rail-overlay").getByTestId("overview-needs-you"),
  ).toHaveCount(0);
  // Taken away, Gram's own count is back.
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({ attention: undefined });
  });
  await expect(
    page.getByTestId("overview-rail-overlay").getByTestId("overview-needs-you"),
  ).toContainText("need you");
  expect(errors).toEqual([]);
});

test("the sidebar can be drawn roomy, with the app's head and account", async ({ page }) => {
  const errors = await mounted(page, "/govern/agents/a-1");
  await page.evaluate(() => {
    const w = window as unknown as Update & { fixtureSidebar: object };
    w.embed.update({ sidebar: w.fixtureSidebar });
  });
  const sidebar = page.getByTestId("overview-sidebar");
  await expect(sidebar).toHaveAttribute("data-look", "roomy");
  // Edge to edge, on Gram's own surface: no inset card.
  const box = await sidebar.boundingBox();
  expect(box?.x).toBe(0);
  expect(box?.y).toBe(0);
  await expect(sidebar).toHaveCSS("border-top-left-radius", "0px");
  // The app's head, with Collapse and New beside it; Hide is not at the head.
  await expect(sidebar.getByTestId("fixture-brand")).toBeVisible();
  await expect(sidebar.getByTestId("overview-hide")).toHaveCount(0);
  // Headings in small capitals, rows 40 px tall.
  const heading = sidebar.getByTestId("embed-navigation-heading").first();
  await expect(heading).toHaveCSS("text-transform", "uppercase");
  const limits = sidebar.getByTestId("embed-navigation-main").getByRole("link", { name: /Runs/ });
  expect((await limits.boundingBox())?.height).toBe(40);
  // The current row: a bold label on the glide, which fills the whole row as a hover does.
  await expect(limits).toHaveAttribute("aria-current", "page");
  await expect(limits).toHaveCSS("font-weight", "600");
  const glide = page.getByTestId("embed-navigation-main").getByTestId("embed-navigation-glide");
  const row = await limits.boundingBox();
  await expect.poll(async () => (await glide.boundingBox())?.width).toBe(row?.width);
  // Search's shortcut as key caps, above the list rather than in it: it stays as the list scrolls.
  await expect(sidebar.getByTestId("key-caps").locator("kbd")).toHaveCount(2);
  expect(
    await sidebar
      .getByTestId("overview-search")
      .evaluate((search) => search.closest(".overflow-y-auto") === null),
  ).toBe(true);
  // The foot: one row of icons, each named, and the account under it.
  const foot = sidebar.getByTestId("overview-roomy-foot");
  const icons = foot.getByTestId("overview-roomy-foot-icons");
  await expect(icons.getByRole("link", { name: /Limits/ })).toBeVisible();
  await expect(icons.getByTestId("overview-history")).toHaveAccessibleName("History");
  await expect(icons.getByTestId("overview-settings")).toHaveAccessibleName("Settings");
  await expect(foot.getByTestId("fixture-account")).toBeVisible();
  // Collapse is an icon at the head.
  await expect(foot.getByTestId("overview-compact")).toHaveCount(0);
  await sidebar.getByTestId("overview-compact").click();
  await expect(page.getByTestId("overview-rail")).toBeVisible();
  // Over the page from the strip it keeps the look, with no Collapse of its own.
  await page.getByTestId("overview-rail").hover({ position: { x: 20, y: 400 } });
  const overlay = page.getByTestId("overview-rail-overlay");
  await expect(overlay.getByTestId("overview-sidebar")).toHaveAttribute("data-look", "roomy");
  await expect(overlay.getByTestId("overview-compact")).toHaveCount(0);
  // The current place's fill is drawn there too, from the overlay's first frame.
  await expect(
    overlay.getByTestId("embed-navigation-main").getByTestId("embed-navigation-glide"),
  ).toBeVisible();
  await expect(overlay.getByTestId("overview-pin")).toBeVisible();
  await overlay.getByTestId("overview-pin").click();
  // Back to the standard look: the toggles at the head again, the account above History.
  await page.evaluate(() => {
    (window as unknown as Update).embed.update({ sidebar: undefined });
  });
  await expect(sidebar).not.toHaveAttribute("data-look", "roomy");
  await expect(sidebar.getByTestId("overview-hide")).toBeVisible();
  expect(errors).toEqual([]);
});

test("an address with no page says so in the shell, with the way home", async ({ page }) => {
  const errors = await mounted(page, "/govern/nowhere");
  const notFound = page.getByTestId("not-found");
  await expect(notFound.getByTestId("empty-title")).toHaveText("Nothing here");
  await expect(notFound).toContainText("/govern/nowhere");
  // The shell is still around it.
  await expect(page.getByTestId("overview-sidebar")).toBeVisible();
  await page.getByTestId("not-found-home").click();
  await expect(page.getByTestId("not-found")).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  expect(errors).toEqual([]);
});

test("the app runs under a path of the embedding app's choosing", async ({ page }) => {
  const errors = await mounted(page, "/w/acme/");
  await page.getByTestId("embed-navigation").getByRole("link", { name: "Policies" }).click();
  await expect(page).toHaveURL(/\/w\/acme\/govern\/policies$/);
  // The page is told its path as the app names it, without the path it is served under.
  await expect(page.getByTestId("fixture-pathname")).toHaveText("/govern/policies");

  // A deep link under the path lands on the page it names, Gram's own included.
  await page.goto("/w/acme/settings/about");
  await expect(page.getByRole("heading", { name: "About" }).first()).toBeVisible();
  await page.goto("/w/acme/govern/agents/a-9");
  await expect(page.getByTestId("fixture-agent")).toHaveText("Agent a-9");
  expect(errors).toEqual([]);
});

test("an added page uses Gram's own controls and its theme's names", async ({ page }) => {
  const errors = await mounted(page, "/govern/policies");
  // Gram's button, from the package's kit: the outline variant has the theme's border.
  const button = page.getByTestId("fixture-button");
  await expect(button).toHaveClass(/group\/button/);
  const border = await button.evaluate((element) => getComputedStyle(element).borderTopWidth);
  expect(border).toBe("1px");
  // The kit's tooltip opens under the app's own provider.
  await button.hover();
  await expect(page.locator('[data-slot="tooltip-content"][data-open]')).toHaveText(
    "Opens Gram's own About page",
  );

  // The page's own Tailwind build knows the theme's names: a surface colour, a type step and a
  // named space, each resolved from the tokens the app's stylesheet sets.
  const themed = await page.getByTestId("fixture-themed").evaluate((element) => {
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    return {
      background: style.backgroundColor,
      padding: style.paddingTop,
      size: style.fontSize,
      // The token is in rem, on the page's root size.
      metaSize: `${Number.parseFloat(root.getPropertyValue("--type-meta-size")) * Number.parseFloat(root.fontSize)}px`,
    };
  });
  expect(themed.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(themed.padding).toBe("8px");
  expect(themed.size).toBe(themed.metaSize);

  await button.click();
  await expect(page.getByRole("heading", { name: "About" }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("an added page is a page of settings, from the kit's pieces", async ({ page }) => {
  const errors = await mounted(page, "/govern/limits");
  await expect(page.getByRole("heading", { name: "Limits", level: 1 }).last()).toBeVisible();
  await expect(page.locator('[data-slot="page"]')).toBeVisible();
  const group = page.getByRole("region", { name: "Spend" });
  await expect(group.getByRole("heading", { name: "Spend" })).toBeVisible();

  // A field with its unit, which turns red while what it holds isn't a number.
  const cap = page.getByTestId("fixture-cap");
  await expect(page.getByLabel("Cap")).toHaveValue("500");
  await expect(page.locator('[data-slot="input-group"]')).toContainText("$");
  await expect(page.locator('[data-slot="input-group"]')).toContainText("per month");
  await expect(cap).not.toHaveAttribute("aria-invalid");
  await cap.fill("lots");
  await expect(cap).toHaveAttribute("aria-invalid", "true");
  await expect(group).toContainText("A whole number of dollars");
  const edge = await cap.evaluate((element) => getComputedStyle(element).borderTopColor);
  await cap.fill("200");
  await expect(cap).not.toHaveAttribute("aria-invalid");
  expect(await cap.evaluate((element) => getComputedStyle(element).borderTopColor)).not.toBe(edge);

  // The segmented control.
  const period = page.getByRole("radiogroup", { name: "Period" });
  await expect(period.getByRole("radio", { name: "Month" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await period.getByRole("radio", { name: "Day" }).click();
  await expect(period.getByRole("radio", { name: "Day" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator('[data-slot="input-group"]')).toContainText("per day");

  // The meter: amber past 90%, read out as a share.
  const meter = page.getByRole("meter", { name: "Used this month" });
  await expect(meter).toHaveAttribute("aria-valuenow", "95");
  await expect(meter).toHaveAttribute("data-tone", "warning");
  const fill = await page
    .getByTestId("fixture-meter")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(fill).not.toBe("rgba(0, 0, 0, 0)");

  // The popover hangs from its button.
  await page.getByTestId("fixture-popover-trigger").click();
  await expect(page.getByTestId("fixture-popover")).toContainText("Acme / Data");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("fixture-popover")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe("on a phone", () => {
  // A phone is a narrow window with a touch screen as its pointer.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the header names the added page and the group it is listed in", async ({ page }) => {
    const errors = await mounted(page, "/govern/limits");
    const title = page.getByTestId("phone-title");
    await expect(title.getByRole("heading")).toHaveText("Limits");
    await expect(page.getByTestId("phone-title-line")).toHaveText("Govern");
    // With the threads left out, the drawer is the app's menu, and its search is for more than them.
    await page.evaluate(() => {
      (window as unknown as Update).embed.update({ threads: "hidden" });
    });
    await expect(page.getByRole("button", { name: "Menu" })).toBeVisible();
    await page.getByTestId("phone-menu").click();
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
    await expect(page.getByTestId("phone-drawer").getByTestId("overview-search")).toContainText(
      "Search",
    );
    await expect(page.getByTestId("phone-drawer").getByTestId("overview-search")).not.toContainText(
      "Search threads",
    );
    expect(errors).toEqual([]);
  });
});
