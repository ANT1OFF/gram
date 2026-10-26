import { expect, test, type Page } from "@playwright/test";
import type { SelectedHarnessSupport } from "@gram/contracts";

import { slowdown } from "./slowdown";
import { openOrchestrator, threadRow } from "./thread-row";

/** The workspace's Board view, from its orchestrator: ⌘⇧D opens the Board of the workspace in view. */
const openBoard = async (page: Page, orchestratorThreadId: string) => {
  await openOrchestrator(page, orchestratorThreadId);
  await page.keyboard.press("ControlOrMeta+Shift+KeyD");
  await expect(page).toHaveURL(new RegExp(`/t/${orchestratorThreadId}$`));
  await expect(page.getByTestId("rail-board")).toBeVisible();
};

const pickChat = (page: Page) =>
  page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Chat\b/ })
    .click();

/** A board's worth of orchestration, and the Memory view of its workspace open. */
const openMemory = async (page: Page) => {
  // Wide enough that the orchestrator's header in the title bar keeps its Memory link in sight.
  await page.setViewportSize({ width: 1680, height: 900 });
  await page.goto("/t/t-flaky");
  await expect(threadRow(page, "t-flaky")).toBeVisible();
  const made = await page.evaluate(async () => {
    const result = await window.gramMock?.simulateOrchestration("board");
    if (!result) throw new Error("the mock API isn't on this page");
    return result;
  });
  // From the orchestrator's header in the title bar, its Memory link.
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.getByRole("link", { name: "Memory", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${made.workspaceId}/memory$`));
  return made;
};

/** Explicit synthetic account/CLI state; this never grants Dream feature support. */
const seedDreamAccount = (page: Page, selected: boolean) =>
  page.addInitScript((hasDefault) => {
    sessionStorage.setItem(
      "gram.mock.settings",
      JSON.stringify({
        agents: hasDefault ? { defaultModel: { agent: "claude", model: "opus" } } : {},
      }),
    );
    sessionStorage.setItem("gram.mock.agents", "claude,codex");
    sessionStorage.setItem(
      "gram.mock.launchChecks",
      JSON.stringify({
        claudeSignIn: "signedIn",
        codexSignIn: "signedOut",
        ghSignedIn: false,
        tools: [
          { tool: "claude", found: true, path: "/mock/bin/claude", version: "2.1.296" },
          { tool: "codex", found: false },
          { tool: "git", found: true, path: "/mock/bin/git", version: "2.47.1" },
          { tool: "gh", found: false },
        ],
      }),
    );
  }, selected);

// Matches the current Claude transport policy; this remains an invented UI observation.
const CLAUDE_DREAM_POLICY =
  "Bounded Dream file tools: snapshot inputs are read-only; candidate output and notes are writable. Native tools are disabled. Requires macOS or Linux with /usr/bin/python3.";

/** Only the start-flow happy paths opt in to this invented, selected-harness observation. */
const openMemoryWithDreamHarness = async (page: Page) => {
  await seedDreamAccount(page, true);
  const made = await openMemory(page);
  await page.evaluate((dreamReason) => {
    const mock = window.gramMock!;
    const readSupport = mock.agentSupport.bind(mock);
    const observed = window as typeof window & { memoryDreamSupport: SelectedHarnessSupport[] };
    observed.memoryDreamSupport = [];
    mock.agentSupport = async (model, options) => {
      const original = await readSupport(model, options);
      if (model.agent !== "claude" || model.model !== "opus" || model.profileId !== undefined)
        return original;
      const observation: SelectedHarnessSupport = {
        ...original,
        availability: { state: "available" },
        dreamMode: "confined",
        dreamReason,
        support: {
          ...original.support,
          dream: {
            state: "supported",
            evidence: "Synthetic Memory start-flow Claude opus fixture",
          },
        },
      };
      observed.memoryDreamSupport.push(observation);
      return observation;
    };
  }, CLAUDE_DREAM_POLICY);
  return made;
};

const expectDreamHarnessObservation = async (page: Page) => {
  const observations = () =>
    page.evaluate(
      () =>
        (window as typeof window & { memoryDreamSupport: SelectedHarnessSupport[] })
          .memoryDreamSupport,
    );
  await expect.poll(async () => (await observations()).length).toBeGreaterThan(0);
  for (const observation of await observations()) {
    expect(observation.model).toEqual({ agent: "claude", model: "opus" });
    expect(observation.availability).toEqual({ state: "available" });
    expect(observation.dreamMode).toBe("confined");
    expect(observation.dreamReason).toBe(CLAUDE_DREAM_POLICY);
    expect(observation.support.dream).toEqual({
      state: "supported",
      evidence: "Synthetic Memory start-flow Claude opus fixture",
    });
  }
  await test.info().attach("synthetic-dream-harness-observations", {
    contentType: "application/json",
    body: JSON.stringify(await observations()),
  });
};

test("memory files are read, edited within their caps, deleted, and a version is restored", async ({
  page,
}) => {
  const made = await openMemory(page);
  const view = page.getByTestId("memory-view");
  await expect(view.getByRole("heading", { level: 1 })).toHaveText("Memory · agent-platform");

  const files = view.getByTestId("memory-file");
  await expect(files).toHaveCount(6);
  await expect(files.first()).toContainText("decisions.md");
  await expect(files.first()).toContainText(/\d+ B/);

  await view.locator('[data-testid="memory-file"][data-path="goals.md"]').click();
  const editor = view.getByTestId("memory-editor");
  const text = editor.getByTestId("memory-text");
  await expect(text).toHaveValue(/Ship the mail trigger/);
  await expect(editor.getByTestId("memory-save")).toBeDisabled();
  await text.fill("# Goals\n\n1. 2026-09-24 · Ship the mail trigger first.\n");
  await expect(editor.getByTestId("memory-size")).toContainText("of 32.0 KB");
  await editor.getByTestId("memory-save").click();
  await expect(editor.getByText("Saved", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      async (id) => (await window.gramMock!.readMemory(id, "goals.md")).content,
      made.workspaceId,
    ),
  ).toContain("Ship the mail trigger first.");

  // The index has the smaller cap, and a file over its cap can't be saved from here at all.
  await view.locator('[data-testid="memory-file"][data-path="MEMORY.md"]').click();
  await expect(view.getByTestId("memory-size")).toContainText("of 8.0 KB");
  await view.getByTestId("memory-text").fill("x".repeat(8 * 1024 + 1));
  await expect(view.getByTestId("memory-size")).toHaveAttribute("data-over", "true");
  await expect(view.getByTestId("memory-save")).toBeDisabled();
  await view.getByRole("button", { name: "Revert" }).click();

  // What the server refuses is said under the editor, in its words.
  await page.evaluate(() => {
    const mock = window.gramMock!;
    mock.writeMemory = () =>
      Promise.reject(
        Object.assign(new Error("Memory is read-only while a restore runs."), {
          _tag: "InvalidState",
        }),
      );
  });
  await view.getByTestId("memory-text").fill("# Memory index\n");
  await view.getByTestId("memory-save").click();
  await expect(view.getByTestId("memory-error")).toHaveText(
    "Memory is read-only while a restore runs.",
  );

  // A new file's name is held to the path rules before anything is sent.
  await view.getByTestId("memory-new").click();
  const form = view.getByTestId("memory-new-form");
  // The form unfolds first, and takes the focus once it has.
  await expect(form.getByRole("textbox")).toBeFocused();
  await form.getByRole("textbox").fill("notes.txt");
  await form.getByRole("button", { name: "Create" }).click();
  await expect(form.getByRole("alert")).toContainText("end the name in .md");

  // Deleting asks first, in place.
  await view.locator('[data-testid="memory-file"][data-path="repos/api.md"]').click();
  await view.getByTestId("memory-delete").click();
  const confirm = view.getByTestId("memory-editor").getByTestId("inline-confirm");
  await expect(confirm).toContainText("Delete repos/api.md from memory?");
  await confirm.getByRole("button", { name: "Delete file" }).click();
  await expect(files).toHaveCount(5);
  await expect(view.getByTestId("memory-editor")).toHaveCount(0);

  // Versions: the adopted one is marked, and restoring another asks first.
  const versions = view.getByTestId("memory-version");
  await expect(versions).toHaveCount(2);
  await expect(versions.first()).toHaveAttribute("data-version", "0002");
  await expect(versions.first().getByTestId("memory-version-current")).toBeVisible();
  await expect(versions.last()).toContainText("3 files");
  await versions.last().getByRole("button", { name: "Restore" }).click();
  await expect(versions.last().getByTestId("inline-confirm")).toContainText(
    "Nothing is copied or deleted",
  );
  await versions.last().getByRole("button", { name: "Restore 0001" }).click();
  await expect(versions.last().getByTestId("memory-version-current")).toBeVisible();
  await expect(files).toHaveCount(3);
  // The questions lived in the version that is no longer current.
  await expect(view.getByTestId("memory-questions")).toContainText("None.");
});

test("an answer picks a choice or says it in words, closes the question, and reaches the orchestrator", async ({
  page,
}) => {
  const made = await openMemory(page);
  const section = page.getByTestId("memory-questions");
  const questions = section.getByTestId("memory-question");
  await expect(questions).toHaveCount(2);
  await expect(questions.first()).toHaveAttribute("data-question", "Q1");
  await expect(questions.first()).toContainText("retry when the provider answers 429");
  await expect(questions.last()).toHaveAttribute("data-question", "Q3");
  // What is closed is history, folded under the open ones with how each was closed.
  const closed = page.getByTestId("memory-closed-questions");
  await expect(closed).toContainText("Closed2");
  const fold = closed.getByRole("button", { name: /Closed/ });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click();
  await expect(closed.locator('[data-question="Q2"]')).toHaveAttribute(
    "data-closed-as",
    "answered",
  );
  await expect(closed.locator('[data-question="Q4"]')).toContainText("Decided by the orchestrator");

  // Choices are offered as the agent's own question card offers them, the recommended one marked.
  const q1 = questions.first();
  await q1.getByRole("button", { name: "Answer" }).click();
  await expect(q1.getByRole("radio")).toHaveCount(4);
  await expect(q1.getByTestId("choice-recommended")).toHaveAttribute("title", "Recommended");
  // The form unfolds inert for a frame, and text filled into it then goes nowhere; a form with
  // choices takes no focus to wait on, so wait for the inert to lift.
  await expect(q1.locator("[inert]")).toHaveCount(0);
  // "Other…" is one of the radios: typing picks it, and picking an option after stops sending it.
  await q1.getByRole("textbox").fill("Drop it");
  await expect(q1.getByRole("radio", { name: "Other", exact: true })).toBeChecked();
  await q1.getByRole("radio", { name: /Retry with backoff/ }).check();
  await q1.getByRole("button", { name: "Send to the orchestrator" }).click();
  await expect(questions).toHaveCount(1);
  await expect(closed.locator('[data-question="Q1"]')).toHaveAttribute(
    "data-closed-as",
    "answered",
  );
  await expect(closed.locator('[data-question="Q1"]')).toContainText("Retry with backoff");

  // One without choices is answered in words.
  await questions.first().getByRole("button", { name: "Answer" }).click();
  await expect(questions.first().getByRole("textbox")).toBeFocused();
  await questions.first().getByRole("textbox").fill("Yes, a merged PR is enough there.");
  await questions.first().getByRole("button", { name: "Send to the orchestrator" }).click();
  await expect(section).toContainText("None.");

  // Each arrives as an ordinary message quoting the question's id, and says it is closed.
  await page.getByTestId("memory-orchestrator").click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  const sent = page.getByTestId("message-user");
  await expect(sent.filter({ hasText: "Answer to Q1 in questions.md" })).toContainText(
    "(“Should the mail trigger retry when the provider answers 429, or drop the mail and report it?”): Retry with backoff",
  );
  await expect(sent.filter({ hasText: "Answer to Q1 in questions.md" })).not.toContainText(
    "Drop it",
  );
  await expect(sent.filter({ hasText: "Answer to Q3 in questions.md" })).toContainText(
    "Gram has closed Q3 as answered.",
  );
});

test("the board answers open questions in its Waiting on you, which the banner unfolds, and the orchestrator asks the rest", async ({
  page,
}) => {
  const made = await openMemory(page);
  await openBoard(page, made.orchestratorThreadId);
  const band = page.getByTestId("rail-waiting");
  // Folded until asked for: nothing is blocked on a question.
  const chip = page.getByTestId("rail-waiting-chip");
  await expect(chip).toHaveAttribute("aria-label", "2 waiting on you");
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await expect(band.getByTestId("memory-question")).toHaveCount(2);
  await chip.click();
  await expect(chip).toHaveAttribute("aria-expanded", "false");

  // So does the orchestrator's banner, through `#questions`.
  await pickChat(page);
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(page.getByTestId("banner-questions")).toHaveText("2 decisions to make");
  await page.getByTestId("banner-questions").click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  const q3 = band.locator('[data-question="Q3"]');
  await q3.getByRole("button", { name: "Answer" }).click();
  // The form mounts folded, and inert, for a frame before it opens; it is focused once it can be typed in.
  await expect(q3.getByRole("textbox")).toBeFocused();
  await q3.getByRole("textbox").fill("Yes.");
  await q3.getByRole("button", { name: "Send to the orchestrator" }).click();
  await expect(band.getByTestId("memory-question")).toHaveCount(1);
  await expect(chip).toHaveAttribute("aria-label", "1 waiting on you");

  // The workspace's row opens the orchestrator, whose ask stack holds the question left; its tray
  // doesn't repeat it.
  await pickChat(page);
  await openOrchestrator(page, made.orchestratorThreadId);
  await expect(page.getByTestId("ask-stack").getByTestId("ask-title")).toContainText("429");
  await expect(page.getByTestId("waiting-questions")).toHaveCount(0);
  await expect(page.getByTestId("banner-questions")).toHaveText("1 decision to make");
});

for (const selected of [false, true]) {
  test(`Dream start refuses ${selected ? "a selected but unverified harness" : "a missing default model"} without counting or starting`, async ({
    page,
  }) => {
    await seedDreamAccount(page, selected);
    await openMemory(page);
    await page.evaluate(() => {
      const mock = window.gramMock!;
      const calls = { preview: 0, start: 0 };
      (window as typeof window & { memoryDreamCalls: typeof calls }).memoryDreamCalls = calls;
      const preview = mock.previewDream.bind(mock);
      const start = mock.startDream.bind(mock);
      mock.previewDream = (...args) => {
        calls.preview++;
        return preview(...args);
      };
      mock.startDream = (...args) => {
        calls.start++;
        return start(...args);
      };
    });
    const dreams = page.getByTestId("dreams");
    await dreams
      .locator('[data-testid="dream-row"][data-status="running"]')
      .getByTestId("dream-cancel")
      .click();
    await dreams.getByTestId("dream-now").click();
    const flow = dreams.getByTestId("dream-start");
    if (selected) {
      await expect(
        flow.getByRole("radio", { name: "Your default: Claude Code · opus", exact: true }),
      ).toBeChecked();
      await expect(flow.getByTestId("harness-preflight-reason")).toContainText(
        "Unverified: This fixture has no qualified Dream observation.",
      );
    } else {
      await expect(
        flow.getByRole("radio", {
          name: "No default model configured; choose one below",
          exact: true,
        }),
      ).toBeChecked();
    }
    await expect(flow).toContainText("Choose an available Dream harness before counting inputs.");
    await expect(flow.getByTestId("dream-plan-reads")).toHaveCount(0);
    await expect(flow.getByTestId("dream-start-run")).toBeDisabled();
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { memoryDreamCalls: { preview: number; start: number } })
            .memoryDreamCalls,
      ),
    ).toEqual({ preview: 0, start: 0 });
    // These cases never opt in to the happy-path observation; global unknown support remains.
    expect(
      await page.evaluate(
        async () =>
          (await window.gramMock!.agentSupport({ agent: "claude", model: "opus" })).support.dream,
      ),
    ).toEqual({ state: "unknown", reason: "This fixture has no qualified Dream observation." });
  });
}

test("an import is previewed before it starts, runs as a thread, and is offered to an empty memory", async ({
  page,
}) => {
  await openMemoryWithDreamHarness(page);
  const dreams = page.getByTestId("dreams");
  const rows = dreams.getByTestId("dream-row");
  await expect(rows).toHaveCount(3);
  // One dream runs per workspace at a time: the one that runs links to its thread and can be stopped.
  const running = dreams.locator('[data-testid="dream-row"][data-status="running"]');
  await expect(running).toContainText("Import");
  await expect(running).toContainText("Codex · gpt-5-codex");
  await expect(running.getByTestId("dream-cost")).toHaveCount(0);
  await expect(running.getByTestId("dream-thread")).toHaveText("Watch it run");
  await expect(dreams.getByTestId("dream-import")).toBeDisabled();
  await running.getByTestId("dream-cancel").click();
  const cancelled = dreams.locator('[data-testid="dream-row"][data-status="canceled"]');
  await expect(cancelled.getByTestId("dream-failure")).toContainText("You cancelled it.");

  await dreams.getByTestId("dream-import").click();
  const flow = dreams.getByTestId("dream-start");
  await expect(flow).toHaveAttribute("data-kind", "import");
  const sources = flow.getByTestId("dream-preview-source");
  await expect(sources).toHaveCount(4);
  await expect(sources.first()).toContainText("api");
  await expect(sources.first()).toContainText("Claude");
  await expect(sources.first()).toContainText("30");
  await expect(sources.first()).toContainText("~552k tokens");
  await expect(flow.getByTestId("dream-preview-worktrees")).toHaveText("Worktrees covered 4/4");
  await expect(flow).toContainText("Closed threads still kept: 3");
  // The server's caveats are shown as it wrote them.
  await expect(flow.getByTestId("dream-preview-notes")).toContainText(
    "Sessions from worktrees that have since been removed can't be listed, so they aren't counted here.",
  );

  // The options change what is counted, and a limit the server would refuse stops the start.
  await flow.getByTestId("dream-per-repo").fill("5");
  await expect(sources.first()).toContainText("~92k tokens");
  await flow.getByTestId("dream-include-memory").check();
  await expect(flow).toContainText("Claude Code memory files: 7");
  await flow.getByRole("checkbox", { name: "docs" }).uncheck();
  await expect(sources).toHaveCount(3);
  await flow.getByTestId("dream-per-repo").fill("500");
  await expect(flow.getByTestId("dream-start-run")).toBeDisabled();
  await flow.getByTestId("dream-per-repo").fill("5");

  // While the next preview is counted the last one stays up, marked stale, and Start stays off:
  // what starts is only ever the scope the preview on screen was counted for.
  await page.evaluate(() => {
    const mock = window.gramMock!;
    const previewDream = mock.previewDream.bind(mock);
    const held = window as unknown as { releasePreview?: () => void };
    mock.previewDream = async (workspaceId, input) => {
      if (input?.perRepo === 7) {
        await new Promise<void>((resolve) => {
          held.releasePreview = resolve;
        });
      }
      return previewDream(workspaceId, input);
    };
  });
  await flow.getByTestId("dream-per-repo").fill("7");
  await expect(flow.getByTestId("dream-preview-stale")).toHaveText("Updating the preview…");
  await expect(sources.first()).toContainText("~92k tokens");
  await expect(flow.getByTestId("dream-start-run")).toBeDisabled();
  await page.waitForFunction(
    () => (window as unknown as { releasePreview?: () => void }).releasePreview !== undefined,
  );
  await page.evaluate(() => (window as unknown as { releasePreview: () => void }).releasePreview());
  await expect(flow.getByTestId("dream-preview-stale")).toHaveCount(0);
  await expect(flow.getByTestId("dream-start-run")).toBeEnabled();
  await flow.getByTestId("dream-per-repo").fill("5");
  await expect(flow.getByTestId("dream-preview-stale")).toHaveCount(0);

  // Only the kinds admitted for a dream are offered as its model.
  await flow.getByTestId("dream-own-model").check();
  await expect(flow.getByTestId("dream-model")).toContainText("Claude");
  await expect(flow.getByTestId("dream-harness-mode")).toHaveText(CLAUDE_DREAM_POLICY);
  await expect(flow).toContainText(
    "Memory changes only after you review and adopt this run's output. Agent sandbox and native approvals still apply.",
  );
  await expect(flow).toContainText("A dream runs on Claude Code, Codex.");

  const started = page.evaluate(
    () =>
      new Promise<unknown>((resolve) => {
        const mock = window.gramMock!;
        const startDream = mock.startDream.bind(mock);
        mock.startDream = (workspaceId, input) => {
          resolve(input);
          return startDream(workspaceId, input);
        };
      }),
  );
  await flow.getByTestId("dream-start-run").click();
  expect(await started).toMatchObject({
    kind: "import",
    perRepo: 5,
    includeMemory: true,
    model: { agent: "claude", model: "opus" },
  });
  await expectDreamHarnessObservation(page);
  // It runs as a thread of its own, which is where starting it lands.
  await expect(page).toHaveURL(/\/t\//);
  await expect(page.getByTestId("pane-role")).toHaveText("Dream");

  // A workspace whose memory is empty is offered an import, on its Memory view and its orchestrator.
  const bare = await page.evaluate(async () => {
    const result = await window.gramMock?.simulateOrchestration();
    if (!result) throw new Error("the mock API isn't on this page");
    return result;
  });
  await openOrchestrator(page, bare.orchestratorThreadId);
  const offer = page.getByTestId("banner-import-offer");
  await expect(offer).toContainText("Its memory is empty.");
  await offer.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/w/${bare.workspaceId}/memory$`));
  await expect(page.getByTestId("dream-start")).toHaveCount(0);
  await page.getByTestId("memory-import-offer").getByRole("button").click();
  await expect(page.getByTestId("dream-start")).toHaveAttribute("data-kind", "import");
});

test("a dream says what it would read and what waits for the next, within a budget", async ({
  page,
}) => {
  await openMemoryWithDreamHarness(page);
  const dreams = page.getByTestId("dreams");
  // The seeded import runs; one dream runs per workspace at a time.
  const running = dreams.locator('[data-testid="dream-row"][data-status="running"]');
  await running.getByTestId("dream-cancel").click();
  await expect(dreams.getByTestId("dream-now")).toBeEnabled();
  await dreams.getByTestId("dream-now").click();
  const flow = dreams.getByTestId("dream-start");
  await expect(flow).toHaveAttribute("data-kind", "dream");
  await expect(flow.getByTestId("dream-budget")).toHaveValue("200");
  await expect(flow.getByTestId("dream-plan-reads")).toHaveText(
    "No dream has been adopted into this memory yet, so this one reads every thread from its start: 5 threads, 172 new messages, ~196k tokens.",
  );
  await expect(flow.getByTestId("dream-plan-backlog")).toHaveText(
    "Backlog: 1 thread (~40k tokens) past the budget of ~200k tokens, left for the next dream.",
  );
  await expect(flow.getByTestId("dream-preview-notes")).toContainText(
    "1 thread left for the next dream",
  );

  // Out of range counts nothing and starts nothing; a bigger budget takes the backlog in.
  await flow.getByTestId("dream-budget").fill("5");
  await expect(flow.getByTestId("dream-budget")).toHaveAttribute("aria-invalid", "true");
  await expect(flow.getByTestId("dream-start-run")).toBeDisabled();
  await flow.getByTestId("dream-budget").fill("300");
  await expect(flow.getByTestId("dream-plan-reads")).toContainText(
    "6 threads, 192 new messages, ~236k tokens.",
  );
  await expect(flow.getByTestId("dream-plan-backlog")).toHaveText(
    "Backlog: nothing; everything new fits the budget of ~300k tokens.",
  );
  await expect(flow.getByTestId("dream-start-run")).toBeEnabled();
  const started = page.evaluate(
    () =>
      new Promise<unknown>((resolve) => {
        const mock = window.gramMock!;
        const startDream = mock.startDream.bind(mock);
        mock.startDream = (workspaceId, input) => {
          resolve(input);
          return startDream(workspaceId, input);
        };
      }),
  );
  await flow.getByTestId("dream-start-run").click();
  expect(await started).toMatchObject({
    kind: "dream",
    budgetTokens: 300_000,
    model: { agent: "claude", model: "opus" },
  });
  await expectDreamHarnessObservation(page);
  await expect(page).toHaveURL(/\/t\//);
});

test("a dream is adopted only once its conflict has a side, and a moved memory means reviewing again", async ({
  page,
}) => {
  const made = await openMemory(page);
  // Its own thread says where it ended, and Review there lands on the review here.
  const completed = page.locator('[data-testid="dream-row"][data-status="completed"]');
  await expect(completed.getByTestId("dream-status")).toHaveText("Ready to review");
  // On the subscription, a dream's dollars stay out.
  await expect(completed.getByTestId("dream-cost")).toHaveCount(0);
  await completed.getByTestId("dream-thread").click();
  const card = page.getByTestId("dream-report");
  await expect(card.getByTestId("dream-report-status")).toHaveText("Ready to review");
  await expect(card.getByTestId("dream-report-files")).toContainText("decisions.md");
  await expect(card.getByTestId("dream-report-files")).not.toContainText("goals.md");
  await card.getByTestId("dream-report-review").click();
  await expect(page).toHaveURL(new RegExp(`/w/${made.workspaceId}/memory\\?dream=`));

  const review = page.getByTestId("dream-review");
  await expect(review.getByTestId("dream-review-summary")).toContainText(
    "1 conflict · 1 changed · 1 added · 1 removed · 1 unchanged · against version 0002",
  );
  await expect(review.getByTestId("dream-report-text")).toContainText("## Dropped");
  // The conflict comes first, and is open.
  const files = review.getByTestId("dream-file");
  await expect(files.first()).toHaveAttribute("data-status", "conflict");
  const diff = review.getByTestId("dream-diff");
  await expect(diff).toHaveAttribute("data-path", "decisions.md");
  await expect(diff).toContainText("+ - 2026-09-20 · Contracts are agreed in api");
  await expect(diff).not.toContainText("Queue consumers retry");
  await diff.getByRole("radio", { name: "Against memory now" }).click();
  await expect(diff).toContainText("− - 2026-09-23 · Queue consumers retry");

  const adopt = review.getByTestId("dream-adopt");
  await expect(adopt).toBeDisabled();
  await expect(review.getByTestId("dream-adopt-reason")).toHaveText(
    "Choose a side for decisions.md first.",
  );
  await diff.getByTestId("dream-keep-current").check();
  await expect(adopt).toBeEnabled();

  // Memory moves under the review: nothing is adopted, the review is fetched again and says why.
  await page.evaluate(async (id) => {
    const mock = window.gramMock!;
    const restore = mock.restoreMemory.bind(mock);
    // Out of band, so the open view doesn't hear of it before the adoption is refused.
    await restore(id, "0001");
    await restore(id, "0002");
    const adoptDream = mock.adoptDream.bind(mock);
    let refused = false;
    mock.adoptDream = (dreamId, input) => {
      if (refused) return adoptDream(dreamId, input);
      refused = true;
      return Promise.reject(
        Object.assign(
          new Error(
            "Memory was adopted or restored since this review (it is version 0002 now). Review the dream again.",
          ),
          { _tag: "InvalidState" },
        ),
      );
    };
  }, made.workspaceId);
  await adopt.click();
  await expect(review.getByTestId("dream-review-refreshed")).toContainText(
    "Nothing was adopted. Memory was adopted or restored since this review",
  );
  await expect(adopt).toBeDisabled();

  await review.getByTestId("dream-conflict").getByTestId("dream-take-output").check();
  const sent = page.evaluate(
    () =>
      new Promise<unknown>((resolve) => {
        const mock = window.gramMock!;
        const adoptDream = mock.adoptDream.bind(mock);
        mock.adoptDream = (dreamId, input) => {
          resolve(input);
          return adoptDream(dreamId, input);
        };
      }),
  );
  await adopt.click();
  expect(await sent).toEqual({
    resolutions: { "decisions.md": "output" },
    basedOn: "0002",
    outputDigest: "sha256:mock-output-1",
  });
  await expect(review).toHaveCount(0, { timeout: 10_000 * slowdown });
  await expect(page).toHaveURL(new RegExp(`/w/${made.workspaceId}/memory$`));
  const versions = page.getByTestId("memory-version");
  await expect(versions.first()).toHaveAttribute("data-version", "0003");
  await expect(versions.first().getByTestId("memory-version-current")).toBeVisible();
  await expect(
    page.locator('[data-testid="memory-file"][data-path="conventions.md"]'),
  ).toBeVisible();
  await expect(completed.getByTestId("dream-status")).toHaveText("Adopted as 0003");
});

test("a long synthetic dream review stays within the application viewport", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  const made = await openMemory(page);
  const baselineConsoleErrors = consoleErrors.length;
  const memory = page.getByTestId("memory-view");
  const initialDocument = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
    scrollTop: document.documentElement.scrollTop,
  }));
  expect(initialDocument).toEqual({ clientHeight: 900, scrollHeight: 900, scrollTop: 0 });
  const readSidebarAncestry = () =>
    page.evaluate(() => {
      const tree = document.querySelector<HTMLElement>('[data-testid="overview-sidebar"]')!;
      const ancestry: Array<Record<string, string | number>> = [];
      let element: HTMLElement | null = tree;
      while (element) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        ancestry.push({
          element: `${element.tagName.toLowerCase()}${element.dataset.testid ? `[data-testid=${element.dataset.testid}]` : ""}`,
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          clientWidth: element.clientWidth,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          display: style.display,
          position: style.position,
          minHeight: style.minHeight,
          maxHeight: style.maxHeight,
        });
        if (element.dataset.testid === "app-shell") break;
        element = element.parentElement;
      }
      return ancestry;
    });
  const sidebarBefore = await readSidebarAncestry();
  await page.evaluate(async (workspaceId) => {
    const mock = window.gramMock!;
    const dream = (await mock.listDreams(workspaceId)).find(
      (candidate) => candidate.status === "completed" && candidate.adoptedVersion === undefined,
    );
    if (!dream) throw new Error("the synthetic board has no reviewable dream");
    const readReview = mock.reviewDream.bind(mock);
    mock.reviewDream = async (id) => {
      const review = await readReview(id);
      return {
        ...review,
        report: Array.from(
          { length: 80 },
          (_, index) =>
            `Synthetic report paragraph ${index + 1}: generated review fixture content.`,
        ).join("\n\n"),
        files: Array.from({ length: 18 }, (_file, index) => ({
          path: `synthetic/conflict-${String(index + 1).padStart(2, "0")}.md`,
          status: "conflict" as const,
          before: Array.from({ length: 100 }, (_line, line) => `baseline line ${line + 1}`).join(
            "\n",
          ),
          after: Array.from({ length: 100 }, (_line, line) => `dream line ${line + 1}`).join("\n"),
          current: Array.from({ length: 100 }, (_line, line) => `current line ${line + 1}`).join(
            "\n",
          ),
        })),
      };
    };
  }, made.workspaceId);
  await page
    .locator('[data-testid="dream-row"][data-status="completed"]')
    .first()
    .getByTestId("dream-review-open")
    .click();
  const review = page.getByTestId("dream-review");
  await expect(review.getByTestId("dream-file")).toHaveCount(18);
  await expect(review.getByTestId("dream-report-text")).toContainText(
    "Synthetic report paragraph 80",
  );
  const content = review.getByTestId("dream-review-content");
  const reviewSizeProbe = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-testid="dream-review"]')!;
    const memoryElement = document.querySelector<HTMLElement>('[data-testid="memory-view"]')!;
    const measure = () => {
      const rect = card.getBoundingClientRect();
      const memoryRect = memoryElement.getBoundingClientRect();
      return {
        documentScrollHeight: document.documentElement.scrollHeight,
        documentClientHeight: document.documentElement.clientHeight,
        documentScrollTop: document.documentElement.scrollTop,
        bodyScrollHeight: document.body.scrollHeight,
        rootScrollHeight: document.querySelector<HTMLElement>("#root")!.scrollHeight,
        memoryTop: Math.round(memoryRect.top),
        memoryBottom: Math.round(memoryRect.bottom),
        memoryClientHeight: memoryElement.clientHeight,
        memoryScrollHeight: memoryElement.scrollHeight,
        memoryScrollTop: memoryElement.scrollTop,
        memoryContain: getComputedStyle(memoryElement).contain,
        cardTop: Math.round(rect.top),
        cardBottom: Math.round(rect.bottom),
        cardHeight: rect.height,
        cardClientHeight: card.clientHeight,
        cardScrollHeight: card.scrollHeight,
        maxHeight: getComputedStyle(card).maxHeight,
      };
    };
    const bounded = measure();
    const previousMaxHeight = card.style.getPropertyValue("max-height");
    const previousPriority = card.style.getPropertyPriority("max-height");
    let withoutCardLimit: ReturnType<typeof measure>;
    try {
      card.style.setProperty("max-height", "none", "important");
      withoutCardLimit = measure();
    } finally {
      if (previousMaxHeight === "") card.style.removeProperty("max-height");
      else card.style.setProperty("max-height", previousMaxHeight, previousPriority);
    }
    return { bounded, withoutCardLimit, restored: measure() };
  });
  console.log(
    "review/root isolation",
    JSON.stringify({ baselineDocument: initialDocument, ...reviewSizeProbe }),
  );
  await test.info().attach("review-card-size-sensitivity", {
    contentType: "application/json",
    body: JSON.stringify(reviewSizeProbe),
  });
  // The same real height-cap predicate must accept the normal card, reject the
  // deliberate sizing defect and accept the restored card. Root clipping alone
  // cannot prove that this internal card stays within its own CSS height limit.
  const cardHeightCap = Number.parseFloat(reviewSizeProbe.bounded.maxHeight);
  expect(Number.isFinite(cardHeightCap)).toBe(true);
  const withinCardHeightCap = (sample: { cardHeight: number }) =>
    sample.cardHeight <= cardHeightCap;
  expect(withinCardHeightCap(reviewSizeProbe.bounded)).toBe(true);
  expect(withinCardHeightCap(reviewSizeProbe.withoutCardLimit)).toBe(false);
  expect(withinCardHeightCap(reviewSizeProbe.restored)).toBe(true);
  expect(reviewSizeProbe.withoutCardLimit.memoryScrollHeight).toBeGreaterThan(
    reviewSizeProbe.bounded.memoryScrollHeight,
  );
  expect(reviewSizeProbe.restored.maxHeight).toBe(reviewSizeProbe.bounded.maxHeight);
  expect(reviewSizeProbe.restored.cardHeight).toBe(reviewSizeProbe.bounded.cardHeight);
  expect(reviewSizeProbe.restored.memoryScrollHeight).toBe(
    reviewSizeProbe.bounded.memoryScrollHeight,
  );
  expect(reviewSizeProbe.bounded.documentScrollHeight).toBe(
    reviewSizeProbe.bounded.documentClientHeight,
  );
  expect(reviewSizeProbe.bounded.memoryContain).toBe("paint");
  expect(reviewSizeProbe.restored.memoryContain).toBe("paint");
  expect(reviewSizeProbe.withoutCardLimit.documentScrollHeight).toBe(
    reviewSizeProbe.bounded.documentScrollHeight,
  );
  expect(reviewSizeProbe.restored.documentScrollHeight).toBe(
    reviewSizeProbe.bounded.documentScrollHeight,
  );
  const sidebarAfter = await readSidebarAncestry();
  expect(sidebarAfter).toEqual(sidebarBefore);
  await memory.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(review.getByTestId("dream-adopt")).toBeVisible();
  const capture = async (name: string) => {
    await page.evaluate(() => {
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    });
    const result = await page.evaluate(() => {
      const viewportHeight = document.documentElement.clientHeight;
      const metrics = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return {
          viewportHeight,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
        };
      };
      const shell = document.querySelector<HTMLElement>('[data-testid="app-shell"]')!;
      const main = document.querySelector<HTMLElement>("main")!;
      const view = document.querySelector<HTMLElement>('[data-testid="memory-view"]')!;
      const card = document.querySelector<HTMLElement>('[data-testid="dream-review"]')!;
      return {
        document: {
          clientHeight: document.documentElement.clientHeight,
          scrollHeight: document.documentElement.scrollHeight,
          scrollTop: document.documentElement.scrollTop,
        },
        body: metrics(document.body),
        root: metrics(document.querySelector<HTMLElement>("#root")!),
        shell: metrics(shell),
        main: metrics(main),
        memory: metrics(view),
        review: metrics(card),
        reviewHeader: metrics(card.firstElementChild as HTMLElement),
        reviewFooter: metrics(card.lastElementChild as HTMLElement),
        reviewContent: metrics(
          card.querySelector<HTMLElement>('[data-testid="dream-review-content"]')!,
        ),
        report: metrics(card.querySelector<HTMLElement>('[data-testid="dream-report-text"]')!),
      };
    });
    console.log(`synthetic review ${name}`, JSON.stringify(result));
    await page.screenshot({ path: test.info().outputPath(`dream-review-scroll-${name}.png`) });
    expect(result.document.scrollTop).toBe(0);
    expect(result.document.scrollHeight).toBe(result.document.clientHeight);
    expect(result.shell.bottom).toBe(result.document.clientHeight);
    expect(result.review.top).toBeGreaterThanOrEqual(result.main.top);
    expect(result.review.bottom).toBeLessThanOrEqual(result.main.bottom);
    expect(result.reviewHeader.top).toBeGreaterThanOrEqual(result.review.top);
    expect(result.reviewFooter.bottom).toBeLessThanOrEqual(result.review.bottom);
    expect(result.reviewContent.scrollHeight).toBeGreaterThanOrEqual(
      result.reviewContent.clientHeight,
    );
    expect(result.report.scrollHeight).toBeGreaterThan(result.report.clientHeight);
  };
  await capture("large");

  // The report and the unified diff keep their own wheel scrolls inside the review card.
  const report = review.getByTestId("dream-report-text");
  const beforeReportWheel = await report.evaluate((element) => element.scrollTop);
  await report.hover();
  await page.mouse.wheel(0, 700);
  await expect
    .poll(() => report.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(beforeReportWheel);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollTop)).toBe(0);

  const firstFile = review.getByTestId("dream-file").first();
  await firstFile.click();
  await expect(firstFile).toHaveAttribute("aria-current", "true");
  await expect(review.getByTestId("dream-adopt")).toBeVisible();

  // The selected file's synthetic unified diff is independently scrollable by wheel.
  const diff = review.locator("pre").filter({ hasText: "baseline line 1" });
  await expect(diff).toBeVisible();
  const beforeDiffWheel = await diff.evaluate((element) => element.scrollTop);
  await diff.hover();
  await page.mouse.wheel(0, 700);
  await expect
    .poll(() => diff.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(beforeDiffWheel);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollTop)).toBe(0);

  await firstFile.focus();
  await page.keyboard.press("PageDown");
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollTop)).toBe(0);

  // Probe scroll chaining at the outer MemoryView boundary. Wheel input at the
  // edge must keep the document bounded without interfering with Memory's scroll.
  await memory.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.mouse.move(1240, 880);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
  const outerBoundary = await page.evaluate(() => ({
    document: {
      clientHeight: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
      scrollTop: document.documentElement.scrollTop,
    },
    memory: document.querySelector<HTMLElement>('[data-testid="memory-view"]')!.scrollTop,
    overscrollY: getComputedStyle(
      document.querySelector<HTMLElement>('[data-testid="memory-view"]')!,
    ).overscrollBehaviorY,
  }));
  console.log("outer wheel boundary", JSON.stringify(outerBoundary));
  expect(outerBoundary.overscrollY).toBe("auto");
  expect(outerBoundary.document.scrollTop).toBe(0);
  expect(outerBoundary.document.scrollHeight).toBe(outerBoundary.document.clientHeight);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus();
  });
  await page.keyboard.press("PageDown");
  const outerPageDown = await page.evaluate(() => ({
    document: document.documentElement.scrollTop,
    body: document.body.scrollTop,
    memory: document.querySelector<HTMLElement>('[data-testid="memory-view"]')!.scrollTop,
  }));
  console.log("outer PageDown", JSON.stringify(outerPageDown));
  expect(outerPageDown.document).toBe(0);
  await page.evaluate(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });

  await page.setViewportSize({ width: 1280, height: 600 });
  await memory.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await capture("short");
  await expect(review.getByRole("button", { name: "Close review" })).toBeVisible();
  await expect(review.getByTestId("dream-adopt")).toBeVisible();
  await expect
    .poll(() => content.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(0);

  await page.setViewportSize({ width: 1600, height: 1100 });
  await memory.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await capture("large-window");

  // Closing review leaves ordinary MemoryView with its usual, uncontained scroll behavior.
  await page.setViewportSize({ width: 1280, height: 600 });
  await review.getByRole("button", { name: "Close review" }).click();
  await expect(review).toHaveCount(0);
  await expect(memory).toHaveCSS("overflow-y", "auto");
  await expect(memory).not.toHaveClass(/overscroll-contain/);
  await expect(memory).not.toHaveClass(/contain-paint/);
  await memory.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await memory.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  // The merged auto mode uses this same layout shell for read-only Inspect actions.
  await page.evaluate(() => {
    const mock = window.gramMock!;
    const readReview = mock.reviewDream.bind(mock);
    mock.reviewDream = async (id) => {
      const result = await readReview(id);
      return { ...result, dream: { ...result.dream, mode: "auto" as const } };
    };
  });
  await page
    .locator('[data-testid="dream-row"][data-status="completed"]')
    .first()
    .getByTestId("dream-review-open")
    .click();
  const inspection = page.getByTestId("dream-review");
  await expect(inspection).toHaveAttribute("aria-label", "Dream inspection");
  await expect(inspection.getByRole("heading", { name: "Inspect · Dream" })).toBeVisible();
  await expect(inspection.getByTestId("dream-adopt")).toHaveCount(0);
  await expect(inspection.getByTestId("dream-discard")).toBeVisible();
  await expect(memory).toHaveClass(/contain-paint/);
  expect(
    await page.evaluate(() => ({
      clientHeight: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
      scrollTop: document.documentElement.scrollTop,
    })),
  ).toEqual({ clientHeight: 600, scrollHeight: 600, scrollTop: 0 });
  await inspection.getByRole("button", { name: "Close review" }).click();
  await expect(inspection).toHaveCount(0);
  await expect(memory).not.toHaveClass(/contain-paint/);
  expect(consoleErrors).toHaveLength(baselineConsoleErrors);
});

test("a failed dream says why in words and can only be discarded", async ({ page }) => {
  await openMemory(page);
  const rows = page.getByTestId("dream-row");
  await expect(rows).toHaveCount(3);
  const failed = page.locator('[data-testid="dream-row"][data-status="failed"]');
  await expect(failed.getByTestId("dream-failure")).toHaveText(
    "An input file changed while the dream ran, so its output can't be trusted.",
  );
  await expect(failed.getByTestId("dream-review-open")).toHaveCount(0);
  await failed.getByTestId("dream-row-discard").click();
  const confirm = failed.getByTestId("inline-confirm");
  await expect(confirm).toContainText("memory stays as it is");
  // What the server does, said before it is done: the dream's thread goes with its folder.
  await expect(confirm).toContainText("Its thread is closed too");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(rows).toHaveCount(3);
  await failed.getByTestId("dream-row-discard").click();
  await failed.getByRole("button", { name: "Discard dream" }).click();
  await expect(rows).toHaveCount(2, { timeout: 10_000 * slowdown });

  // A finished one is discarded from its review, with the same question first.
  await page
    .locator('[data-testid="dream-row"][data-status="completed"]')
    .getByTestId("dream-review-open")
    .click();
  const review = page.getByTestId("dream-review");
  await review.getByTestId("dream-discard").click();
  await expect(review.getByTestId("inline-confirm")).toContainText("Its thread is closed too");
  await review.getByRole("button", { name: "Discard dream" }).click();
  await expect(review).toHaveCount(0, { timeout: 10_000 * slowdown });
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("memory-version")).toHaveCount(2);
});

test("a conflict's two sides are merged by a model, reviewed, and adopted as the merge", async ({
  page,
}) => {
  const made = await openMemory(page);
  await page
    .locator('[data-testid="dream-row"][data-status="completed"]')
    .getByTestId("dream-review-open")
    .click();
  const review = page.getByTestId("dream-review");
  const diff = review.getByTestId("dream-diff");
  await expect(diff).toHaveAttribute("data-path", "decisions.md");

  await diff.getByTestId("dream-merge-both").check();
  const status = diff.getByTestId("dream-merge-status");
  await expect(status).toHaveAttribute("data-status", "running");
  await expect(status).toContainText("Merging on Claude Code · opus");
  await expect(review.getByTestId("dream-adopt")).toBeDisabled();
  await expect(review.getByTestId("dream-adopt-reason")).toHaveText(
    "Wait for the merge of decisions.md, or choose a side.",
  );
  await expect(status).toHaveAttribute("data-status", "done", { timeout: 10_000 * slowdown });
  await expect(review.getByTestId("dream-file").first()).toContainText("merged");

  // The diff is the merged file: the dream's new entry and the live write, against either side.
  await expect(diff).toContainText("+ - 2026-09-20 · Contracts are agreed in api");
  await expect(diff).toContainText("+ - 2026-09-23 · Queue consumers retry");
  await diff.getByRole("radio", { name: "Against memory now" }).click();
  await expect(diff).toContainText("+ - 2026-09-20 · Contracts are agreed in api");
  await expect(diff).not.toContainText("− - 2026-09-23 · Queue consumers retry");

  // Either side whole is still a choice, and coming back doesn't merge again.
  await diff.getByTestId("dream-take-output").check();
  await expect(diff.getByTestId("dream-merge-status")).toHaveCount(0);
  await expect(diff).toContainText("− - 2026-09-23 · Queue consumers retry");
  await diff.getByTestId("dream-merge-both").check();
  await expect(status).toHaveAttribute("data-status", "done");
  await status.getByTestId("dream-merge-again").click();
  await expect(status).toHaveAttribute("data-status", "running");
  await expect(status).toHaveAttribute("data-status", "done", { timeout: 10_000 * slowdown });

  const sent = page.evaluate(
    () =>
      new Promise<unknown>((resolve) => {
        const mock = window.gramMock!;
        const adoptDream = mock.adoptDream.bind(mock);
        mock.adoptDream = (dreamId, input) => {
          resolve(input?.resolutions);
          return adoptDream(dreamId, input);
        };
      }),
  );
  await review.getByTestId("dream-adopt").click();
  expect(await sent).toEqual({ "decisions.md": "merged" });
  await expect(review).toHaveCount(0, { timeout: 10_000 * slowdown });
  const decisions = await page.evaluate(
    async (id) => (await window.gramMock!.readMemory(id, "decisions.md")).content,
    made.workspaceId,
  );
  expect(decisions).toContain("Contracts are agreed in api");
  expect(decisions).toContain("Queue consumers retry");
});
