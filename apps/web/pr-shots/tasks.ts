import { expect, type Page } from "@playwright/test";
import type { TaskRecorder } from "./task-recorder";

interface Task {
  id: string;
  title: string;
  start: string;
  goal: string;
  path?: string;
  prepare?: (page: Page) => Promise<void>;
  run: (page: Page, record: TaskRecorder) => Promise<void>;
}

/** A phone or upright tablet (below 1024 px): taps go through the drawer, More and sheets. */
const onPhone = (page: Page) => (page.viewportSize()?.width ?? Infinity) < 1024;

/** Opens the phone's threads drawer from the header's menu button. */
const openDrawer = (page: Page, record: TaskRecorder) =>
  record.click(page.getByTestId("phone-menu"));

/** Only prepare may stage fixtures. Every measured action uses a visible role/label or shortcut. */
export const TASKS: readonly Task[] = [
  {
    id: "01-start",
    title: "Start a task",
    start: "A finished solo thread, realistic workspaces",
    goal: "Submit a direct worker task and see its thread",
    run: async (p, r) => {
      await r.key("ControlOrMeta+Alt+n");
      await r.text(p.getByLabel("What needs doing"), "Add retry coverage for the queue consumer.");
      await r.click(p.getByRole("button", { name: /Start (workspace and )?task/ }));
      await expect(p).toHaveURL(/\/t\//);
      await expect(p.getByLabel("Message", { exact: true })).toBeVisible();
      await expect(
        p
          .getByRole("listitem", { name: "Pane 1", exact: true })
          .getByText("Add retry coverage for the queue consumer.", { exact: true }),
      ).toBeVisible();
    },
  },
  {
    id: "02-attention",
    title: "Find what needs me",
    start: "A finished solo thread",
    goal: "Reveal the refund worker's waiting question",
    run: async (p, r) => {
      await r.click(p.getByRole("button", { name: /\d+ needs? you/ }).first());
      await expect(
        p.getByText("A refund webhook that keeps failing", { exact: false }).first(),
      ).toBeVisible();
    },
  },
  {
    id: "03-answer",
    title: "Answer an approval or question",
    start: "A solo thread at a pending tool approval",
    path: "/t/t-flaky",
    goal: "Allow once and see the request clear",
    prepare: async (p) => {
      await p.getByRole("button", { name: /^Allow once/ }).waitFor();
    },
    run: async (p, r) => {
      await r.click(p.getByRole("button", { name: /^Allow once/ }));
      await expect(p.getByRole("button", { name: /^Allow once/ })).toBeHidden();
      await expect(p.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
    },
  },
  {
    id: "04-review",
    title: "Review a diff or PR",
    start: "Finished solo thread with changed files",
    goal: "Open this turn's diff and read code",
    run: async (p, r) => {
      await r.click(p.getByRole("button", { name: /\d+ files? changed/ }).first());
      await expect(p.getByRole("tab", { name: "Diff", exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(p.getByRole("button", { name: /^package.json Modified/ })).toBeVisible();
      await expect(p.getByRole("cell", { name: /"vitest": "5.1.2"/ })).toBeVisible();
    },
  },
  {
    id: "05-jump",
    title: "Jump to a thread",
    start: "Finished solo thread",
    goal: "Open the visible Search in Settings worker",
    run: async (p, r) => {
      if (onPhone(p)) await openDrawer(p, r);
      await r.click(p.getByRole("button", { name: /^Search in Settings, Waiting/ }));
      await expect(
        p.getByRole("heading", { name: "Worker: Search in Settings", exact: true }),
      ).toBeVisible();
    },
  },
  {
    id: "06-workspace",
    title: "Switch workspace",
    start: "Solo thread with four realistic workspaces",
    goal: "Open billing-api's orchestrator",
    run: async (p, r) => {
      if (onPhone(p)) await openDrawer(p, r);
      await r.click(p.getByRole("button", { name: /^billing-api,/ }));
      await expect(
        onPhone(p)
          ? p.getByTestId("phone-title").getByRole("heading", { name: "billing-api" })
          : p.getByRole("button", { name: "Workspace: billing-api", exact: true }),
      ).toBeVisible();
    },
  },
  {
    id: "07-model",
    title: "Change model, mode or effort",
    start: "Finished solo thread, composer available",
    goal: "Select Extra high effort",
    run: async (p, r) => {
      await r.click(p.getByTestId("composer-choices"));
      if (onPhone(p)) {
        // The phone's sheet shows effort as segments, no submenu to open.
        await r.click(p.getByRole("radio", { name: /^Extra high/ }));
        await r.click(p.getByTestId("composer-choices-close"));
      } else {
        await r.click(p.getByTestId("choices-effort"));
        await r.click(p.getByRole("option", { name: "Extra high effort" }));
      }
      await expect(p.getByTestId("composer-choices")).toHaveAccessibleName(
        / · Effort: Extra high( \(.+\))? · /,
      );
    },
  },
  {
    id: "08-history",
    title: "Find an old thread",
    start: "Finished solo thread",
    goal: "Open the old Release notes for 0.9 thread from Done",
    path: "/t/t-docs",
    run: async (p, r) => {
      if (onPhone(p)) await openDrawer(p, r);
      // Done is in At rest, folded to its title line: a click on it unfolds it.
      await r.click(p.getByRole("button", { name: /^At rest, \d+$/ }));
      await r.click(p.getByRole("button", { name: /^Release notes for 0.9, Gram, merged/ }));
      await expect(
        p.getByRole("heading", { name: "Worker: Release notes for 0.9", exact: true }),
      ).toBeVisible();
    },
  },
  {
    id: "09-setting",
    title: "Change a setting",
    start: "Finished solo thread",
    goal: "Save Default folder; verify persistence after reload",
    run: async (p, r) => {
      await r.key("ControlOrMeta+,");
      const folder = p.getByLabel("Default folder", { exact: true });
      await r.text(folder, "~/work/sandbox");
      await r.key("Enter", folder);
      await p.reload(); // Verification only; not a task action.
      await expect(folder).toHaveValue("~/work/sandbox");
    },
  },
  {
    id: "10-recover",
    title: "Recover from an error",
    start: "Solo thread with a seeded retryable rate limit",
    path: "/t/t-docs",
    goal: "Retry the failed prompt and see its receipt",
    prepare: async (p) => {
      // t-docs plays its README turn on load; the failed turn follows it, as the server would. A
      // base from before the hook just doesn't wait.
      await p.evaluate(() => window.gramMock!.turnEnded?.("t-docs" as never));
      await p.evaluate(() =>
        window.gramMock!.simulateTurnError(
          "t-docs" as never,
          {
            kind: "rateLimit",
            httpStatus: 429,
            retryable: true,
            text: "Synthetic rate limit. Try again.",
          },
          "Run the e2e suite",
        ),
      );
      await p.getByRole("button", { name: "Retry", exact: true }).waitFor();
    },
    run: async (p, r) => {
      await r.click(p.getByRole("button", { name: "Retry", exact: true }));
      // The failed card turns into the retry's receipt once the retry ran through.
      const card = p.locator('[data-testid="agent-error"][data-state="retried"]').last();
      await expect(card).toHaveAttribute("data-recovered", "true");
      await expect(card.getByTestId("agent-error-retried")).toBeVisible();
    },
  },
  {
    id: "11-stop",
    title: "Stop a run",
    start: "Solo thread held mid-turn by the mock",
    path: "/t/t-flaky",
    prepare: async (p) => {
      await p.getByRole("button", { name: "Stop", exact: true }).waitFor();
    },
    goal: "Stop and see Stopped by you",
    run: async (p, r) => {
      await r.click(p.getByRole("button", { name: "Stop", exact: true }));
      await expect(p.getByText(/Stopped by you · \d\d:\d\d/)).toBeVisible();
      await expect(p.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
    },
  },
  {
    id: "12-usage",
    title: "See usage or limits",
    start: "Finished solo thread with synthetic subscription usage",
    goal: "Open subscription usage and see limits",
    run: async (p, r) => {
      if (onPhone(p)) {
        // A phone's bar has no meter: More's Usage opens the limits page.
        await r.click(p.getByRole("button", { name: "More", exact: true }));
        await r.click(p.getByTestId("phone-menu-usage"));
        await expect(p.getByText(/5.hour/i).first()).toBeVisible();
        return;
      }
      await r.click(p.getByRole("button", { name: /subscription usage/i }));
      await expect(p.getByRole("dialog", { name: "Subscription usage" })).toBeVisible();
      await expect(p.getByText(/5.hour/i).first()).toBeVisible();
    },
  },
];
