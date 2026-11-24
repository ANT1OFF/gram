import { expect, test, type Page } from "@playwright/test";
import * as fc from "fast-check";

import { slowdown } from "./slowdown";
import { openOrchestrator } from "./thread-row";

// A property-based test of what needs you (docs/VERIFICATION.md#property-based-ui-tests). fast-check
// makes random sequences of what a person does with the Inbox open (allow, deny, approve or reject
// a plan, answer a question with an option or their own words, Undo, let the undo window pass, open
// a thread, go to a workspace's Board and back), runs each on a fresh mock, and after every step
// checks what must always hold:
//
// - the sidebar's pill, each workspace's line, the window title, the Inbox's count and its rows,
//   and the Board's waiting chip all say the model's count;
// - Send answer is enabled exactly when there is something to send, and Undo is there exactly while
//   an answer waits to go out;
// - the page never shows "undefined", "NaN" or "[object Object]", and nothing throws or logs an
//   error.
//
// A UI property earns its place by what only the page can get wrong: each view reads one derived
// list (`needsYouIn`), and these are the places a view can read it stale or in its own way.
//
// The page clock is paused once the mock is seeded and moves only in this spec's ticks, so the undo
// window and the mock's agents run the same way on every replay. CI runs a fixed seed. A failure
// prints the shortest sequence that breaks it, its seed and path; to replay it, or to try more
// sequences: GRAM_UI_PROPERTY_SEED=<seed> GRAM_UI_PROPERTY_PATH=<path> GRAM_UI_PROPERTY_RUNS=<n>.

const RUNS = Number(process.env["GRAM_UI_PROPERTY_RUNS"] ?? 4);
const SEED = Number(process.env["GRAM_UI_PROPERTY_SEED"] ?? 20_261_120);
const PATH = process.env["GRAM_UI_PROPERTY_PATH"];
const STEPS = Number(process.env["GRAM_UI_PROPERTY_STEPS"] ?? 12);

/** `UNDO_MS` in `ask-stack-store.ts`: how long an answer from the Inbox can be taken back. */
const UNDO_MS = 4_000;
/** `SENT_GRACE_MS` there: how long a sent answer stays hidden while the server says it's gone. */
const SENT_GRACE_MS = 10_000;
/** One step of page time: long enough for the mock (`VITE_MOCK_SPEED=0.05`) to answer. */
const TICK = 200;

type Kind = "approval" | "plan" | "options" | "reply" | "form";
interface Item {
  readonly key: string;
  readonly kind: Kind;
  readonly thread: string;
  readonly workspace: string | undefined;
}
interface Held {
  readonly item: Item;
  /** The page time its answer goes out. */
  readonly due: number;
}
interface Model {
  /** What needs you, as the Inbox lists it. */
  open: Item[];
  /** Answered from the Inbox and not sent yet, oldest first: Undo takes back the last. */
  held: Held[];
  /** Page time since the clock was paused. */
  now: number;
  /** The scenario's workspaces and their orchestrators. */
  readonly workspaces: readonly { readonly id: string; readonly orchestrator: string }[];
}
interface Real {
  readonly page: Page;
  readonly errors: string[];
}

const BAD_TEXT = /\bundefined\b|\bNaN\b|\[object Object\]/;
const WIDE = { width: 1728, height: 1000 };

const inbox = (page: Page) => page.getByTestId("inbox");
const detail = (page: Page) => page.getByTestId("inbox-detail");
const pill = (page: Page) => page.getByTestId("overview-needs-you");
const row = (page: Page, key: string) =>
  inbox(page).locator(`[data-testid="inbox-item"][data-key="${key}"]`);
const line = (page: Page, workspaceId: string) =>
  page.locator(`[data-testid="overview-workspace"][data-workspace-id="${workspaceId}"]`);

/** Moves page time on by `ms`, firing what falls due, and sends what the undo window let go. */
const tick = async (model: Model, { page }: Real, ms = TICK) => {
  await page.clock.runFor(ms);
  model.now += ms;
  model.held = model.held.filter((held) => held.due > model.now);
};

const shareOf = (model: Model, workspaceId: string) =>
  model.open.filter((item) => item.workspace === workspaceId).length;

/** What must hold after every step, with the Inbox open. */
async function holds(model: Model, real: Real) {
  const { page } = real;
  const total = model.open.length;
  await expect(inbox(page), "the Inbox is open").toBeVisible();
  // The Inbox: its rows are the model's, and its header says how many.
  const keys = model.open.map((item) => item.key).toSorted();
  await expect
    .poll(
      async () =>
        (
          await inbox(page)
            .getByTestId("inbox-item")
            .evaluateAll((all) => all.map((each) => each.getAttribute("data-key") ?? ""))
        ).toSorted(),
      { message: "the Inbox's rows" },
    )
    .toEqual(keys);
  if (total > 0) {
    await expect(inbox(page).getByTestId("inbox-count"), "the Inbox's count").toHaveText(
      new RegExp(`^${total} `),
    );
  } else await expect(inbox(page).getByTestId("inbox-empty"), "the empty Inbox").toBeVisible();
  // Undo is there exactly while an answer waits to go out.
  const undo = page.getByTestId("needs-you-undo");
  if (model.held.length > 0) await expect(undo, "Undo, with an answer held").toBeEnabled();
  else await expect(undo, "Undo, with nothing held").toHaveCount(0);
  await outside(model, real, total);
}

/** The counts outside the Inbox, and what no page may show. */
async function outside(model: Model, { page, errors }: Real, total = model.open.length) {
  await expect(pill(page), "the sidebar's pill").toHaveAttribute("data-count", String(total));
  for (const { id } of model.workspaces) {
    await expect(line(page, id), `${id}'s line in the sidebar`).toHaveAttribute(
      "data-asks",
      String(shareOf(model, id)),
    );
  }
  if (total > 0) await expect(page, "the window title").toHaveTitle(new RegExp(`^\\(${total}\\) `));
  else await expect(page, "the window title").not.toHaveTitle(/^\(\d+\)/);
  expect(await page.locator("body").innerText(), "the page's text").not.toMatch(BAD_TEXT);
  expect(errors, "errors thrown or logged").toEqual([]);
}

/** Picks `item`'s row, and waits for the detail to show it. */
const show = async ({ page }: Real, item: Item) => {
  await row(page, item.key).click();
  await expect(detail(page)).toHaveAttribute("data-key", item.key);
};

const pick = <T>(list: readonly T[], at: number) => list[at % list.length]!;
const ofKinds = (model: Model, ...kinds: Kind[]) =>
  model.open.filter((item) => kinds.includes(item.kind));
const answered = (model: Model, item: Item, heldFor: boolean) => {
  model.open = model.open.filter((each) => each.key !== item.key);
  if (heldFor) model.held.push({ item, due: model.now + UNDO_MS });
};

/** Opens the Inbox from the sidebar's pill, as it was left. */
const reopen = async (model: Model, real: Real) => {
  await pill(real.page).click();
  await tick(model, real);
  await expect(inbox(real.page)).toBeVisible();
};

/** Allow on an approval (held for Undo), or Approve… and Start on a plan (sent at once). */
class Approve implements fc.AsyncCommand<Model, Real> {
  readonly at: number;
  constructor(at: number) {
    this.at = at;
  }
  check = (m: Readonly<Model>) => ofKinds(m, "approval", "plan").length > 0;
  async run(m: Model, r: Real) {
    const item = pick(ofKinds(m, "approval", "plan"), this.at);
    await show(r, item);
    if (item.kind === "approval") {
      const allow = detail(r.page)
        .getByTestId("ask-option")
        .filter({ hasText: /^Allow/ })
        .first();
      await expect(allow).toBeEnabled();
      await allow.click();
    } else {
      await detail(r.page).getByRole("button", { name: "Approve…" }).click();
      const start = detail(r.page).getByRole("button", { name: /^Start in/ });
      await expect(start).toBeEnabled();
      await start.click();
    }
    answered(m, item, item.kind === "approval");
    await tick(m, r);
    await holds(m, r);
  }
  toString = () => `Approve(${this.at})`;
}

/** Deny on an approval (held for Undo), or Reject… with or without a note on a plan. */
class Reject implements fc.AsyncCommand<Model, Real> {
  readonly at: number;
  readonly note: string;
  constructor(at: number, note: string) {
    this.at = at;
    this.note = note;
  }
  check = (m: Readonly<Model>) => ofKinds(m, "approval", "plan").length > 0;
  async run(m: Model, r: Real) {
    const item = pick(ofKinds(m, "approval", "plan"), this.at);
    await show(r, item);
    if (item.kind === "approval") {
      const deny = detail(r.page).getByTestId("ask-option").filter({ hasText: /^Deny/ });
      await expect(deny).toBeEnabled();
      await deny.click();
    } else {
      await detail(r.page).getByRole("button", { name: "Reject…" }).click();
      if (this.note !== "") await detail(r.page).getByRole("textbox").fill(this.note);
      const send = detail(r.page).getByRole("button", { name: "Send feedback" });
      // A rejection needs no words: the plan's thread is told no either way.
      await expect(send).toBeEnabled();
      await send.click();
    }
    answered(m, item, item.kind === "approval");
    await tick(m, r);
    await holds(m, r);
  }
  toString = () => `Reject(${this.at}, ${JSON.stringify(this.note)})`;
}

/** A question answered with an option, its own words, or both; with neither, Send stays off. */
class Answer implements fc.AsyncCommand<Model, Real> {
  readonly at: number;
  readonly option: number | null;
  readonly words: string;
  constructor(at: number, option: number | null, words: string) {
    this.at = at;
    this.option = option;
    this.words = words;
  }
  check = (m: Readonly<Model>) => ofKinds(m, "options", "reply").length > 0;
  async run(m: Model, r: Real) {
    const item = pick(ofKinds(m, "options", "reply"), this.at);
    await show(r, item);
    const d = detail(r.page);
    let something = this.words.trim() !== "";
    let send;
    if (item.kind === "reply") {
      if (this.words !== "") await d.getByTestId("ask-reply-input").fill(this.words);
      send = d.getByTestId("ask-reply-send");
    } else {
      if (this.words !== "") await d.getByTestId("ask-option-other-input").fill(this.words);
      if (this.option !== null) {
        const options = d.getByTestId("ask-option");
        await options.nth(this.option % (await options.count())).click();
        something = true;
      }
      send = d.getByTestId("ask-send");
    }
    if (!something) {
      await expect(send).toBeDisabled();
      await holds(m, r);
      return;
    }
    await expect(send).toBeEnabled();
    await send.click();
    answered(m, item, true);
    await tick(m, r);
    await holds(m, r);
  }
  toString = () => `Answer(${this.at}, ${this.option}, ${JSON.stringify(this.words)})`;
}

/** Undo takes back the newest answer still held, and its row comes back. */
class Undo implements fc.AsyncCommand<Model, Real> {
  check = (m: Readonly<Model>) => m.held.length > 0;
  async run(m: Model, r: Real) {
    await r.page.getByTestId("needs-you-undo").click();
    const { item } = m.held.pop()!;
    m.open.push(item);
    await tick(m, r);
    await holds(m, r);
  }
  toString = () => "Undo";
}

/** Past the undo window and the sent grace: what went out stays gone. */
class LetGo implements fc.AsyncCommand<Model, Real> {
  check = () => true;
  async run(m: Model, r: Real) {
    await tick(m, r, UNDO_MS + SENT_GRACE_MS + TICK);
    await holds(m, r);
  }
  toString = () => "LetGo";
}

/** Open thread lands on the thread that asked; the Inbox closes, and reopens as it was. */
class OpenThread implements fc.AsyncCommand<Model, Real> {
  readonly at: number;
  constructor(at: number) {
    this.at = at;
  }
  check = (m: Readonly<Model>) => m.open.length > 0;
  async run(m: Model, r: Real) {
    const item = pick(m.open, this.at);
    await show(r, item);
    await detail(r.page).getByTestId("inbox-open-thread").click();
    await tick(m, r);
    await expect(r.page).toHaveURL(new RegExp(`/t/${item.thread}$`));
    await expect(inbox(r.page)).toBeHidden();
    await outside(m, r);
    await reopen(m, r);
    await holds(m, r);
  }
  toString = () => `OpenThread(${this.at})`;
}

/**
 * Home, a workspace's orchestrator, on its Board: the waiting chip says the workspace's share, and
 * opens the Inbox again (the pill does when there is none).
 */
class BoardAndBack implements fc.AsyncCommand<Model, Real> {
  readonly at: number;
  constructor(at: number) {
    this.at = at;
  }
  check = () => true;
  async run(m: Model, r: Real) {
    const { page } = r;
    const workspace = pick(m.workspaces, this.at);
    await page.keyboard.press("Escape");
    await tick(m, r);
    await expect(inbox(page)).toBeHidden();
    await openOrchestrator(page, workspace.orchestrator);
    await page
      .getByRole("radiogroup", { name: "View" })
      .getByRole("radio", { name: /^Board\b/ })
      .click();
    await tick(m, r);
    await expect(page.getByTestId("rail-board")).toBeVisible();
    const share = shareOf(m, workspace.id);
    const chip = page.getByTestId("rail-waiting-chip");
    await outside(m, r);
    if (share === 0) {
      await expect(chip).toHaveCount(0);
      await reopen(m, r);
    } else {
      await expect(chip).toHaveAttribute("data-count", String(share));
      await chip.click();
      await tick(m, r);
      await expect(inbox(page)).toBeVisible();
    }
    await holds(m, r);
  }
  toString = () => `BoardAndBack(${this.at})`;
}

/** A question's way to answer, read once from its detail: the scenario is the same every run. */
const kinds = new Map<string, Kind>();
const kindOf = async (real: Real, key: string, listed: string | null): Promise<Kind> => {
  const known = kinds.get(key);
  if (known !== undefined) return known;
  let kind: Kind;
  if (listed === "approval" || listed === "plan") kind = listed;
  else {
    await row(real.page, key).click();
    await expect(detail(real.page)).toHaveAttribute("data-key", key);
    const d = detail(real.page);
    kind =
      (await d.getByTestId("ask-reply-input").count()) > 0
        ? "reply"
        : (await d.getByTestId("ask-send").count()) > 0
          ? "options"
          : "form";
  }
  kinds.set(key, kind);
  return kind;
};

const text = fc.string({ unit: "grapheme", maxLength: 20 });
const commands = [
  fc.nat().map((at) => new Approve(at)),
  fc.tuple(fc.nat(), fc.oneof(fc.constant(""), text)).map(([at, note]) => new Reject(at, note)),
  fc
    .tuple(fc.nat(), fc.option(fc.nat()), fc.oneof(fc.constant(""), fc.constant("   "), text))
    .map(([at, option, words]) => new Answer(at, option, words)),
  fc.constant(new Undo()),
  fc.constant(new LetGo()),
  fc.nat().map((at) => new OpenThread(at)),
  fc.nat().map((at) => new BoardAndBack(at)),
];

test("what needs you: any sequence of answers keeps the sidebar, the Inbox and the Board in step", async ({
  page,
}) => {
  test.setTimeout(Math.max(120_000, RUNS * 30_000) * slowdown);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewportSize(WIDE);
  await page.clock.install();
  const real: Real = { page, errors };

  /** A fresh load starts the mock again: the ask scenario, every ask open, the Inbox open on it. */
  const fresh = async (): Promise<Model> => {
    errors.length = 0;
    // Time flows while the page loads and the mock seeds; the last run left it paused.
    await page.clock.resume();
    await page.goto("/t/t-flaky");
    await expect(page.getByTestId("approval-card")).toBeVisible();
    const made = await page.evaluate(() => window.gramMock!.simulateAsks());
    await expect(line(page, made.other.workspaceId)).not.toHaveAttribute("data-asks", "0");
    await expect(line(page, made.workspaceId)).not.toHaveAttribute("data-asks", "0");
    // From here page time moves only in ticks.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + TICK);
    await pill(page).click();
    await expect(inbox(page)).toBeVisible();
    const listed = await inbox(page)
      .getByTestId("inbox-item")
      .evaluateAll((all) =>
        all.map((each) => ({
          key: each.getAttribute("data-key") ?? "",
          kind: each.getAttribute("data-kind"),
          thread: each.getAttribute("data-thread-id") ?? "",
          workspace: each.getAttribute("data-workspace") ?? undefined,
        })),
      );
    const open: Item[] = [];
    for (const each of listed)
      open.push({ ...each, kind: await kindOf(real, each.key, each.kind) });
    const model: Model = {
      open,
      held: [],
      now: 0,
      workspaces: [
        { id: made.workspaceId, orchestrator: made.orchestratorThreadId },
        { id: made.other.workspaceId, orchestrator: made.other.orchestratorThreadId },
      ],
    };
    await holds(model, real);
    return model;
  };

  const details = await fc.check(
    // Unbiased, so the few runs CI pays for aren't spent on the shortest sequences.
    fc.asyncProperty(fc.noBias(fc.commands(commands, { maxCommands: STEPS })), async (steps) => {
      const model = await fresh();
      await fc.asyncModelRun(() => ({ model, real }), steps);
    }),
    {
      numRuns: RUNS,
      seed: SEED,
      ...(PATH === undefined ? {} : { path: PATH }),
      endOnFailure: false,
    },
  );
  if (details.failed) {
    throw new Error(
      `${fc.defaultReportMessage(details)}\n\nReplay: GRAM_UI_PROPERTY_SEED=${details.seed} GRAM_UI_PROPERTY_PATH=${details.counterexamplePath}`,
      { cause: details.errorInstance },
    );
  }
});
