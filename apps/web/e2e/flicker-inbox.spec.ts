import { expect, test, type Page } from "@playwright/test";

import { installFlickerObserver } from "./flicker-observer";
import { frames } from "./settled";

const flickers = (page: Page) => page.evaluate(() => window.gramFlicker!);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(installFlickerObserver, { keep: 30 });
});

test("explore", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/t/t-flaky");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  const seeded = await page.evaluate(async () => {
    const mock = window.gramMock!;
    const made = await mock.simulateFailures();
    const ids = mock.world.threads().map((s) => s.thread.id);
    for (const [i, id] of ids.slice(0, 6).entries())
      mock.simulateWaitOnUser(id, { kind: "action", title: `Step ${i} for ${id}` });
    return { made, ids };
  });
  await page.keyboard.press("ControlOrMeta+Shift+KeyI");
  await expect(page.getByTestId("inbox")).toBeVisible();
  await frames(page, 30);
  await page.evaluate(() => {
    window.gramFlicker!.last.length = 0;
    const log: string[] = [];
    const w = window as never as { log: string[]; gone: Map<string, number> };
    w.log = log;
    const gone = new Map<string, number>();
    w.gone = gone;
    let lastDetail: string | null = null;
    const check = () => {
      const keys = new Set(
        [...document.querySelectorAll('[data-testid="inbox-item"]')].map(
          (e) => e.getAttribute("data-key")!,
        ),
      );
      const now = performance.now();
      for (const [k, at] of gone)
        if (keys.has(k)) {
          log.push(`back ${k} after ${Math.round(now - at)}ms`);
          gone.delete(k);
        }
      for (const k of (w as never as { prev?: Set<string> }).prev ?? [])
        if (!keys.has(k)) gone.set(k, now);
      (w as never as { prev?: Set<string> }).prev = keys;
      const detail = document.querySelector('[data-testid="inbox-detail"]')?.getAttribute("data-key") ?? null;
      if (detail !== lastDetail) log.push(`detail ${lastDetail} -> ${detail}`);
      lastDetail = detail;
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
    const churn = new Map<string, number>();
    (window as never as { churn: Map<string, number> }).churn = churn;
    const name = (n: Node) => {
      if (!(n instanceof Element)) return `#text:${(n.textContent ?? "").slice(0, 30)}`;
      const parts: string[] = [];
      for (let at: Element | null = n; at && parts.length < 4; at = at.parentElement) {
        const id = at.getAttribute("data-testid");
        parts.unshift(`${at.tagName.toLowerCase()}${id ? `[${id}]` : ""}`);
      }
      return parts.join(">") + ` "${(n.textContent ?? "").slice(0, 30)}"`;
    };
    const bump = (k: string) => churn.set(k, (churn.get(k) ?? 0) + 1);
    new MutationObserver((ms) => {
      for (const m of ms) {
        const el = m.target instanceof Element ? m.target : m.target.parentElement;
        if (!el?.closest('[data-testid="inbox"]')) continue;
        for (const n of m.removedNodes) bump(`- ${name(n)} in ${name(el)}`);
        for (const n of m.addedNodes) bump(`+ ${name(n)} in ${name(el)}`);
        if (m.type === "attributes") bump(`@${m.attributeName} ${name(el)}`);
        if (m.type === "characterData") bump(`~ ${name(el)}`);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.evaluate(
    async ({ ids, workspaceId }) => {
      const mock = window.gramMock!;
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      const quiet = ids.filter((id) => {
        const s = mock.world.summary(id as never);
        return (s.status === "idle" || s.status === "running") && (s.pendingRequests ?? []).length === 0;
      });
      let wait: { thread: string; id: string } | undefined;
      let question: string | undefined;
      for (let round = 0; round < 20; round++) {
        for (const [i, id] of quiet.entries())
          mock.simulateStatus(id as never, (round + i) % 2 === 0 ? "running" : "idle");
        for (const id of ids) mock.simulateLastActivity(id as never, Date.now());
        mock.simulateRecap(ids[round % ids.length] as never);
        if (wait === undefined) {
          const thread = quiet[round % quiet.length]!;
          wait = { thread, id: mock.simulateWaitOnUser(thread as never, { kind: "action", title: `Round ${round}` }).id };
        } else {
          void mock.resolveWait(wait.thread as never, wait.id as never);
          wait = undefined;
        }
        if (question === undefined) question = mock.simulateAskUser(workspaceId as never, { question: `Q ${round}?` });
        else {
          mock.simulateCloseQuestion(workspaceId as never, question, "ok");
          question = undefined;
        }
        await frame();
        await frame();
        await frame();
      }
    },
    { ids: seeded.ids, workspaceId: (seeded.made as { workspaceId: string }).workspaceId },
  );
  await frames(page, 20);
  console.log(JSON.stringify((await flickers(page)).last, null, 1));
  const log = await page.evaluate(() => (window as never as { log: string[] }).log);
  for (const l of log) console.log(l);
  const churn = await page.evaluate(() => [...(window as never as { churn: Map<string, number> }).churn].sort((a, b) => b[1] - a[1]).slice(0, 80));
  for (const [k, v] of churn) console.log(v, k);
  await page.screenshot({ path: "/tmp/inbox.png" });
});

test("explore realistic", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.orchestration", "realistic"));
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  const made = await page.evaluate(async () => {
    const mock = window.gramMock!;
    const made = (await mock.startedRealistic())!;
    for (const [i, { threadId }] of made.running.entries())
      mock.simulateWaitOnUser(threadId, { kind: "action", title: `Step ${i}` });
    return made;
  });
  await frames(page, 30);
  await page.keyboard.press("ControlOrMeta+Shift+KeyI");
  await expect(page.getByTestId("inbox")).toBeVisible();
  await frames(page, 30);
  await page.evaluate(() => {
    window.gramFlicker!.last.length = 0;
    const churn = new Map<string, number>();
    (window as never as { churn: Map<string, number> }).churn = churn;
    const name = (n: Node) => {
      if (!(n instanceof Element)) return `#text:${(n.textContent ?? "").slice(0, 30)}`;
      const parts: string[] = [];
      for (let at: Element | null = n; at && parts.length < 4; at = at.parentElement) {
        const id = at.getAttribute("data-testid");
        parts.unshift(`${at.tagName.toLowerCase()}${id ? `[${id}]` : ""}`);
      }
      return parts.join(">") + ` "${(n.textContent ?? "").slice(0, 30)}"`;
    };
    const bump = (k: string) => churn.set(k, (churn.get(k) ?? 0) + 1);
    new MutationObserver((ms) => {
      for (const m of ms) {
        const el = m.target instanceof Element ? m.target : m.target.parentElement;
        if (!el?.closest('[data-testid="inbox"]')) continue;
        for (const n of m.removedNodes) bump(`- ${name(n)} in ${name(el)}`);
        for (const n of m.addedNodes) bump(`+ ${name(n)} in ${name(el)}`);
        if (m.type === "attributes" && m.attributeName !== "id") bump(`@${m.attributeName} ${name(el)}`);
        if (m.type === "characterData") bump(`~ ${name(el)}`);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const rows = await page.getByTestId("inbox-item").count();
  for (let r = 0; r < rows; r++) {
  await page.getByTestId("inbox-item").nth(r).click();
  await frames(page, 20);
  await page.evaluate((r) => { console.log("ROW", r); (window as never as { churn: Map<string, number> }).churn.set(`=== row ${r}`, 999); }, r);
  await page.evaluate(async (made) => {
    const mock = window.gramMock!;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    for (const { threadId } of made.running) void mock.simulateRecap(threadId);
    const ids = mock.world.threads().map((s) => s.thread.id);
    for (let round = 0; round < 10; round++) {
      for (const [i, { threadId }] of made.running.entries()) {
        mock.simulateStatus(threadId, (round + i) % 2 === 0 ? "running" : "idle");
        const git = mock.world.summary(threadId).git;
        if (git !== undefined) mock.world.publishGit(threadId, { ...git, changesToken: `r${round}` });
      }
      for (const id of ids) mock.simulateLastActivity(id, Date.now());
      await frame();
      await frame();
      await frame();
    }
  }, made);
  }
  await frames(page, 20);
  console.log(JSON.stringify((await flickers(page)).last, null, 1));
  const churn = await page.evaluate(() => [...(window as never as { churn: Map<string, number> }).churn]);
  for (const [k, v] of churn) console.log(v, k);
  await page.screenshot({ path: "/tmp/inbox2.png" });
});
