import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { terminalText } from "../e2e/terminal";
import { threadRow } from "../e2e/thread-row";
import { startHarness, type Harness } from "./harness";
import { SLOW_3G, UNLIMITED, startSlowLink, type SlowLink } from "./slow-link";

// The headline numbers: what a person waits for on very long threads, on a phone and on a slow
// link, against the real server and the built web app. One generated database holds a 41,000-item
// thread, a 75,000-item thread and a full sidebar; an item is one part of a stored message (a
// prompt, a tool call with its output, a reply). Opt in with GRAM_PERF_HEADLINE=1. `GRAM_PERF_OUT`
// names the JSON results file, which `tools/perf/headline-chart.mjs` compares and draws.
// `GRAM_PERF_SCALE` scales the item counts (0.02 for a functional smoke run, which is not
// performance evidence) and `GRAM_PERF_REPEATS` the samples behind each median.
const PERF = process.env["GRAM_PERF_HEADLINE"] === "1";
const OUT_FILE = process.env["GRAM_PERF_OUT"] ?? join(tmpdir(), "gram-perf-headline.json");
const SCALE = Number(process.env["GRAM_PERF_SCALE"] ?? 1);
const REPEATS = Number(process.env["GRAM_PERF_REPEATS"] ?? 5);

/** Parts in one generated turn: the prompt, and a reply of a step, reasoning, tools and text. */
const TURN_ITEMS = 20;
const TOOLS_PER_TURN = TURN_ITEMS - 4;
const OPEN_ITEMS = Math.max(TURN_ITEMS * 30, Math.round(41_000 * SCALE));
const SEND_ITEMS = Math.max(TURN_ITEMS * 30, Math.round(75_000 * SCALE));
const SIDEBAR_THREADS = Math.max(4, Math.round(150 * SCALE));
/** Lines the terminal has printed before it is attached to. */
const TERMINAL_LINES = Math.max(500, Math.round(20_000 * SCALE));
/** Pages of earlier history one sample loads; each is `FEED_WINDOW_TURNS` turns. */
const EARLIER_PAGES = 10;

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

test.skip(!PERF, "set GRAM_PERF_HEADLINE=1 to measure the headline scenarios on the real server");
test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly unit: "ms" | "bytes";
  /** The median of `samples`. */
  readonly value: number;
  readonly samples: readonly number[];
  /** What else was measured beside the headline value. */
  readonly detail?: Readonly<Record<string, number | string>>;
}
const scenarios: Scenario[] = [];
const median = (values: readonly number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const round = (n: number, digits = 1) => Number(n.toFixed(digits));
const record = (
  id: string,
  label: string,
  unit: Scenario["unit"],
  samples: readonly number[],
  detail?: Scenario["detail"],
) => {
  const value = round(median(samples));
  scenarios.push({
    id,
    label,
    unit,
    value,
    samples: samples.map((s) => round(s)),
    ...(detail ? { detail } : {}),
  });
  console.log(`${label}: ${value} ${unit}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
};
const thousands = (n: number) => n.toLocaleString("en-US");

const WORDS =
  "retry clock timer flaky assertion fixture deterministic reject resolve worker queue cache index schema migration".split(
    " ",
  );
const sentence = (seed: number, words: number) =>
  Array.from({ length: words }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(" ");

/** The last line of turn `turn`'s reply, which a scenario waits to see painted. */
const replyOf = (turn: number) => `Seeded turn ${turn} is done.`;

/** One generated turn as its two stored messages: `TURN_ITEMS` parts between them. */
const generatedTurn = (threadId: string, turn: number) => {
  const turnId = `${threadId}-seed-turn-${turn}`;
  const createdAt = 1_700_000_000_000 + turn * 2_000;
  const user = {
    id: `${threadId}-seed-u${turn}`,
    role: "user",
    metadata: { createdAt, turnId },
    parts: [{ type: "text", text: `Seeded prompt ${turn}: ${sentence(turn, 12)}.` }],
  };
  const tools = Array.from({ length: TOOLS_PER_TURN }, (_, i) => ({
    type: "tool-Bash",
    toolCallId: `${threadId}-seed-bash-${turn}-${i}`,
    state: "output-available",
    input: { command: `pnpm vitest run ${WORDS[(turn + i) % WORDS.length]}`, description: "Test" },
    output: {
      stdout: Array.from(
        { length: 8 },
        (__, line) =>
          `  ✓ src/${WORDS[(turn + i + line) % WORDS.length]}.test.ts > ${sentence(turn + line, 6)}`,
      ).join("\n"),
      stderr: "",
      interrupted: false,
    },
  }));
  const assistant = {
    id: `${threadId}-seed-a${turn}`,
    role: "assistant",
    metadata: {
      createdAt: createdAt + 1_000,
      agent: "claude",
      model: "fake-opus",
      agentMessageIds: [`sdk-${threadId}-seed-a${turn}`],
      turnId,
    },
    parts: [
      { type: "step-start" },
      { type: "reasoning", text: sentence(turn, 40), state: "done" },
      ...tools,
      {
        type: "text",
        state: "done",
        text: [
          `${sentence(turn + 1, 30)}.`,
          "",
          `- ${sentence(turn + 2, 8)}`,
          `- ${sentence(turn + 3, 8)}`,
          "",
          replyOf(turn),
        ].join("\n"),
      },
    ],
  };
  return { turnId, createdAt, user, assistant };
};

/**
 * Appends `turns` generated turns to a thread of the stopped server's database, through the shipped
 * triggers, stamping revisions as the store does.
 */
const seedTurns = (db: DatabaseSync, threadId: string, turns: number) => {
  const insertMessage = db.prepare(
    `INSERT INTO messages (thread_id, id, seq, role, turn_id, message, rev)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTurn = db.prepare(
    `INSERT INTO turns (id, thread_id, started_at, ended_at, reason) VALUES (?, ?, ?, ?, 'completed')`,
  );
  let seq = Number(
    (
      db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE thread_id = ?")
        .get(threadId) as { seq: number }
    ).seq,
  );
  let rev = Number(
    (db.prepare("SELECT rev FROM feed_revision WHERE id = 0").get() as { rev: number }).rev,
  );
  db.exec("BEGIN");
  for (let turn = 0; turn < turns; turn++) {
    const { turnId, createdAt, user, assistant } = generatedTurn(threadId, turn);
    insertTurn.run(turnId, threadId, createdAt, createdAt + 1_000);
    for (const message of [user, assistant]) {
      insertMessage.run(
        threadId,
        message.id,
        ++seq,
        message.role,
        turnId,
        JSON.stringify(message),
        ++rev,
      );
    }
  }
  db.prepare("UPDATE feed_revision SET rev = ? WHERE id = 0").run(rev);
  db.prepare("UPDATE threads SET feed_rev = ? WHERE id = ?").run(rev, threadId);
  db.exec("COMMIT");
};

/** The server's database file, wherever under the data folder this version keeps it. */
const databaseFile = (dataDir: string): string => {
  const found = (readdirSync(dataDir, { recursive: true }) as string[]).filter((name) =>
    /\.(db|sqlite)$/.test(name),
  );
  if (found.length !== 1) throw new Error(`expected one database under ${dataDir}: ${found}`);
  return join(dataDir, found[0]!);
};

/** A plain RPC client on the server's socket, outside any browser: what the server alone takes. */
interface Rpc {
  request<A = unknown>(tag: string, payload: unknown): Promise<A>;
  close(): void;
}
const openRpc = (origin: string, cookie: string) =>
  new Promise<Rpc>((resolve, reject) => {
    const url = `${origin.replace("http", "ws")}/ws`;
    const ws = new WebSocket(url, { headers: { cookie } } as unknown as string[]);
    const pending = new Map<
      string,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    let nextId = 1;
    ws.addEventListener("message", (event) => {
      const data = String(event.data);
      if (!data.startsWith('{"_tag":"Exit"')) return;
      const message = JSON.parse(data) as {
        requestId: string;
        exit: { _tag: string; value?: unknown };
      };
      const waiter = pending.get(String(message.requestId));
      if (!waiter) return;
      pending.delete(String(message.requestId));
      if (message.exit._tag === "Success") waiter.resolve(message.exit.value);
      else waiter.reject(new Error(`rpc failed: ${data.slice(0, 400)}`));
    });
    ws.addEventListener("error", () => reject(new Error(`socket to ${url} failed`)));
    ws.addEventListener("open", () =>
      resolve({
        request: (tag, payload) =>
          new Promise((done, fail) => {
            const id = String(nextId++);
            pending.set(id, { resolve: done as (v: unknown) => void, reject: fail });
            ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
          }),
        close: () => ws.close(),
      }),
    );
  });

/** What a page's sockets carry: the tags it asks for, when each is answered, and the bytes in. */
interface Wire {
  /** Resolves when the next request tagged `tag`, sent from now on, gets its `Exit`. */
  answered(tag: string): Promise<void>;
  /** Resolves when a feed opened from now on says `caughtUp`. */
  caughtUp(): Promise<void>;
  /** Resolves when the list of threads next arrives whole, as it does on every connection. */
  threadList(): Promise<void>;
  /** Bytes received over sockets since the last call. */
  takeBytes(): number;
  /** Since the last call: the three requests whose answers were largest, as `tag 12 KB`. */
  takeLargest(): string;
}
const watchWire = (page: Page): Wire => {
  let bytes = 0;
  const tags = new Map<string, string>();
  let byTag = new Map<string, number>();
  let sentWaiters: Array<{ tag: string; onId: (id: string) => void }> = [];
  let exitWaiters: Array<{ id: string; done: () => void }> = [];
  let caughtUpWaiters: Array<() => void> = [];
  let threadListWaiters: Array<() => void> = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      for (const match of text.matchAll(/"_tag":"Request","id":"?(\d+)"?,"tag":"([\w.]+)"/g)) {
        const [, id, tag] = match;
        tags.set(id!, tag!);
        sentWaiters = sentWaiters.filter((waiter) => {
          if (waiter.tag !== tag) return true;
          waiter.onId(id!);
          return false;
        });
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const text = typeof payload === "string" ? payload : payload.toString("utf8");
      bytes += text.length;
      const head = text.slice(0, 200);
      const tag = tags.get(/"requestId":"?(\d+)/.exec(head)?.[1] ?? "") ?? "other";
      byTag.set(tag, (byTag.get(tag) ?? 0) + text.length);
      if (head.includes('"_tag":"Exit"')) {
        const id = /"requestId":"?(\d+)/.exec(head)?.[1];
        exitWaiters = exitWaiters.filter((waiter) => {
          if (waiter.id !== id) return true;
          waiter.done();
          return false;
        });
      }
      if (text.slice(-400).includes('"type":"caughtUp"')) {
        for (const done of caughtUpWaiters.splice(0)) done();
      }
      if (text.slice(0, 400).includes('"type":"threads.snapshot"')) {
        for (const done of threadListWaiters.splice(0)) done();
      }
    });
  });
  return {
    answered: (tag) =>
      new Promise((done) => {
        sentWaiters.push({ tag, onId: (id) => exitWaiters.push({ id, done }) });
      }),
    caughtUp: () => new Promise((done) => caughtUpWaiters.push(done)),
    threadList: () => new Promise((done) => threadListWaiters.push(done)),
    takeBytes: () => {
      const out = bytes;
      bytes = 0;
      return out;
    },
    takeLargest: () => {
      const out = [...byTag]
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([tag, size]) => `${tag} ${Math.round(size / 1024)} KB`)
        .join(", ");
      byTag = new Map();
      return out;
    },
  };
};

/** Two frames on: what was just rendered has been painted. */
const painted = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

const transcript = (page: Page) => page.getByTestId("transcript");

let h: Harness;
/** The way to the server that the phone and slow-link scenarios take; unlimited until set. */
let link: SlowLink;
let browser: Browser;
let page: Page;
let wire: Wire;
let rpc: Rpc;
let cookie = "";
let openThread = "";
let sendThread = "";
let smallThread = "";
let terminalThread = "";

const openTurns = OPEN_ITEMS / TURN_ITEMS;
const sendTurns = SEND_ITEMS / TURN_ITEMS;

/** Opens a page on the harness, signed in, and returns it with its socket watcher. */
const newPage = async (options: Parameters<Browser["newPage"]>[0]) => {
  const fresh = await browser.newPage(options);
  const freshWire = watchWire(fresh);
  return { page: fresh, wire: freshWire };
};

test.beforeAll(async ({ browser: given }) => {
  browser = given;
  // The git sweep would run through every measurement; the watcher still refreshes.
  h = await startHarness({ env: { GRAM_GIT_SWEEP_MS: "3600000" } });
  ({ page, wire } = await newPage({ viewport: { width: 1440, height: 900 } }));
  await h.open(page, "/");
  const cookies = await page.context().cookies(h.origin_url());
  cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  rpc = await openRpc(h.origin_url(), cookie);

  // Every thread starts with one real echo turn, so the server made it as it makes any thread.
  const create = async (title: string) =>
    (
      await rpc.request<{ id: string }>("thread.create", {
        projectRoot: h.repo,
        checkout: { kind: "current" },
        title,
        input: { text: `start ${title}` },
      })
    ).id;
  // The measured threads are made last, so the sidebar lists them first, where a click reaches.
  const sidebar: string[] = [];
  for (let i = 0; i < SIDEBAR_THREADS; i++) sidebar.push(await create(`Sidebar thread ${i}`));
  openThread = await create(`Long thread, ${thousands(OPEN_ITEMS)} items`);
  sendThread = await create(`Longer thread, ${thousands(SEND_ITEMS)} items`);
  terminalThread = await create("Terminal thread");
  smallThread = await create("Short thread");
  const threads = SIDEBAR_THREADS + 4;

  const database = databaseFile(join(h.root, "data"));
  await expect
    .poll(
      () => {
        const db = new DatabaseSync(database, { readOnly: true });
        try {
          const row = db
            .prepare("SELECT COUNT(*) AS n FROM turns WHERE ended_at IS NOT NULL")
            .get() as { n: number };
          return Number(row.n);
        } finally {
          db.close();
        }
      },
      { timeout: 120_000, message: "every thread's first echo turn ends" },
    )
    .toBe(threads);

  rpc.close();
  await page.close();
  await h.restart(() => {
    const db = new DatabaseSync(database);
    seedTurns(db, openThread, openTurns);
    seedTurns(db, sendThread, sendTurns);
    for (const id of sidebar) seedTurns(db, id, 3);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  });

  ({ page, wire } = await newPage({ viewport: { width: 1440, height: 900 } }));
  await h.open(page, "/");
  cookie = (await page.context().cookies(h.origin_url()))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  rpc = await openRpc(h.origin_url(), cookie);
  link = await startSlowLink(() => h.origin_url());
});

/** Opens `path` through the link, signed in as `h.open` signs a page in. */
const openThroughLink = async (on: Page, path: string) => {
  const [name, value] = cookie.split("; ")[0]!.split("=") as [string, string];
  await on
    .context()
    .addCookies([{ name, value, url: link.origin, httpOnly: true, sameSite: "Strict" }]);
  await on.goto(`${link.origin}${path}`);
};

test.afterAll(async () => {
  rpc?.close();
  await link?.close();
  await page?.close();
  await h?.stop();
  if (!PERF || scenarios.length === 0) return;
  // `GRAM_PERF_LABEL` names a run that isn't this checkout's commit, such as a build of `main`.
  const commit =
    process.env["GRAM_PERF_LABEL"] ??
    execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(
    OUT_FILE,
    `${JSON.stringify(
      {
        suite: "gram-perf-headline",
        commit,
        at: new Date().toISOString(),
        scale: SCALE,
        repeats: REPEATS,
        machine: `${cpus()[0]?.model ?? "unknown CPU"} ×${cpus().length}, ${process.platform}`,
        scenarios,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`results written to ${OUT_FILE}`);
});

/** Clicks `threadId` in the sidebar and returns the time until `text` of its transcript painted. */
const timeOpen = async (on: Page, threadId: string, text: string) => {
  const row = threadRow(on, threadId);
  await row.scrollIntoViewIfNeeded();
  const start = performance.now();
  await row.click();
  await expect(transcript(on).getByText(text).last()).toBeVisible({ timeout: 120_000 });
  await painted(on);
  return performance.now() - start;
};

test(`open a ${thousands(OPEN_ITEMS)}-item thread`, async () => {
  const samples: number[] = [];
  const bytes: number[] = [];
  for (let i = 0; i < REPEATS + 1; i++) {
    await timeOpen(page, smallThread, "echo: start Short thread");
    wire.takeBytes();
    const ms = await timeOpen(page, openThread, replyOf(openTurns - 1));
    // The first open also loads code and warms caches; it is reported apart.
    if (i === 0) {
      record("open-thread-cold", `Open a ${thousands(OPEN_ITEMS)}-item thread, first time`, "ms", [
        ms,
      ]);
      continue;
    }
    samples.push(ms);
    bytes.push(wire.takeBytes());
  }
  record("open-thread", `Open a ${thousands(OPEN_ITEMS)}-item thread`, "ms", samples, {
    socketKilobytes: round(median(bytes) / 1024),
  });
});

test("load earlier turns", async () => {
  await timeOpen(page, smallThread, "echo: start Short thread");
  await timeOpen(page, openThread, replyOf(openTurns - 1));
  // The row above the first message, whatever it says: asking, loading or failed.
  const earlier = page.getByRole("button", { name: /earlier messages/ });
  const pages: number[] = [];
  const bytes: number[] = [];
  const start = performance.now();
  // Registered before the page can ask: reaching the top asks by itself, the button otherwise.
  let answered = wire.answered("thread.history");
  for (let i = 0; i < EARLIER_PAGES; i++) {
    wire.takeBytes();
    const pageStart = performance.now();
    await page
      .getByRole("button", { name: "Show earlier messages" })
      .click({ timeout: 1_000 })
      .catch(() => undefined);
    await answered;
    answered = wire.answered("thread.history");
    await painted(page);
    pages.push(performance.now() - pageStart);
    bytes.push(wire.takeBytes());
    if ((await earlier.count()) === 0) break;
  }
  // The median page, not the sum: one slow page out of ten would otherwise decide the number.
  record(
    "load-earlier",
    `Load a page of earlier turns, ${thousands(20 * TURN_ITEMS)} items`,
    "ms",
    pages,
    {
      pages: pages.length,
      totalMs: round(performance.now() - start),
      slowestPageMs: round(Math.max(...pages)),
      medianPageKilobytes: round(median(bytes) / 1024),
    },
  );
});

test(`send to a ${thousands(SEND_ITEMS)}-item thread`, async () => {
  // The server's own time: the send's round trip on a bare socket, with no page in the way.
  const server: number[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const start = performance.now();
    await rpc.request("thread.send", {
      threadId: sendThread,
      input: { text: `server send ${i}` },
      clientMessageId: crypto.randomUUID(),
    });
    server.push(performance.now() - start);
    await page.waitForTimeout(750);
  }
  // And what the person sees: from the keypress to the reply's first words.
  await timeOpen(page, sendThread, `echo: server send ${REPEATS - 1}`);
  const seen: number[] = [];
  const composer = page.getByRole("combobox", { name: "Message" });
  for (let i = 0; i < REPEATS; i++) {
    await composer.fill(`page send ${i}`);
    const start = performance.now();
    await composer.press("ControlOrMeta+Enter");
    await expect(transcript(page).getByText(`echo: page send ${i}`)).toBeVisible({
      timeout: 60_000,
    });
    seen.push(performance.now() - start);
    await expect(transcript(page).locator('[data-streaming="true"]')).toHaveCount(0);
  }
  record(
    "send-server",
    `Send to a ${thousands(SEND_ITEMS)}-item thread, on the server`,
    "ms",
    server,
  );
  record(
    "send-reply",
    `Send to a ${thousands(SEND_ITEMS)}-item thread, until the reply`,
    "ms",
    seen,
  );
});

test(`launch on a phone with ${SIDEBAR_THREADS + 4} threads`, async () => {
  const samples: number[] = [];
  const details: Array<{
    http: number;
    socket: number;
    ms: number;
    files: number;
    largest: string;
    largestSocket: string;
  }> = [];
  for (let i = 0; i < Math.min(REPEATS, 3); i++) {
    // A new context each time: nothing cached, as a first launch.
    const phone = await newPage(PHONE);
    const session = await phone.page.context().newCDPSession(phone.page);
    await session.send("Network.enable");
    let http = 0;
    const urls = new Map<string, string>();
    const files: Array<[string, number]> = [];
    session.on("Network.requestWillBeSent", (event) => {
      urls.set(event.requestId, event.request.url);
    });
    session.on("Network.loadingFinished", (event) => {
      http += event.encodedDataLength;
      const name = (urls.get(event.requestId) ?? "?").split("/").at(-1)!.split("?")[0]!;
      files.push([name.replace(/-[\w-]{8}(\.\w+)$/, "$1") || "/", event.encodedDataLength]);
    });
    link.takeBytesDown();
    const start = performance.now();
    const caughtUp = phone.wire.caughtUp();
    await openThroughLink(phone.page, `/t/${smallThread}`);
    await expect(transcript(phone.page).getByText("echo: start Short thread")).toBeVisible({
      timeout: 60_000,
    });
    await caughtUp;
    // Whatever else the launch asks for arrives within this quiet stretch.
    await phone.page.waitForTimeout(2_000);
    const socket = phone.wire.takeBytes();
    // Everything the link carried to the phone, as it was on the wire: files and socket.
    samples.push(link.takeBytesDown());
    details.push({
      http,
      socket,
      ms: performance.now() - start - 2_000,
      files: files.length,
      largest: files
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name, size]) => `${name} ${Math.round(size / 1024)} KB`)
        .join(", "),
      largestSocket: phone.wire.takeLargest(),
    });
    await phone.page.close();
  }
  record(
    "phone-launch",
    `Launch on a phone with ${SIDEBAR_THREADS + 4} threads`,
    "bytes",
    samples,
    {
      httpKilobytes: round(median(details.map((d) => d.http)) / 1024),
      socketKilobytesInflated: round(median(details.map((d) => d.socket)) / 1024),
      unthrottledMs: round(median(details.map((d) => d.ms))),
      files: details[0]!.files,
      largestFiles: details[0]!.largest,
      largestSocketAnswers: details[0]!.largestSocket,
    },
  );
});

test("launch on a phone over slow 3G", async () => {
  // One sample: with nothing cached, the app's own files are most of a minute or more.
  const phone = await newPage(PHONE);
  link.set(SLOW_3G);
  const start = performance.now();
  await openThroughLink(phone.page, `/t/${smallThread}`);
  await expect(transcript(phone.page).getByText("echo: start Short thread")).toBeVisible({
    timeout: 500_000,
  });
  await painted(phone.page);
  record("phone-launch-slow", "Launch on a phone over slow 3G, nothing cached", "ms", [
    performance.now() - start,
  ]);
  link.set(UNLIMITED);
  await phone.page.close();
});

test("reconnect on a phone over slow 3G", async () => {
  const phone = await newPage(PHONE);
  // Remembers the page's sockets, so the test can cut them as a dropped connection does.
  await phone.page.addInitScript(() => {
    const sockets: WebSocket[] = [];
    (window as unknown as { gramPerfSockets: WebSocket[] }).gramPerfSockets = sockets;
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
  });
  await openThroughLink(phone.page, `/t/${openThread}`);
  await expect(
    transcript(phone.page)
      .getByText(replyOf(openTurns - 1))
      .last(),
  ).toBeVisible({
    timeout: 120_000,
  });
  await phone.page.waitForTimeout(1_000);

  const measure = async () => {
    const samples: number[] = [];
    const bytes: number[] = [];
    phone.wire.takeLargest();
    for (let i = 0; i < REPEATS; i++) {
      link.takeBytesDown();
      // Back in touch: the open thread has caught up and the list of threads has arrived again.
      const back = Promise.all([phone.wire.caughtUp(), phone.wire.threadList()]);
      const start = performance.now();
      await phone.page.evaluate(() => {
        const sockets = (window as unknown as { gramPerfSockets: WebSocket[] }).gramPerfSockets;
        for (const socket of sockets.splice(0)) socket.close();
      });
      await back;
      await painted(phone.page);
      samples.push(performance.now() - start);
      await phone.page.waitForTimeout(1_500);
      bytes.push(link.takeBytesDown());
    }
    return { samples, bytes, largest: phone.wire.takeLargest() };
  };
  const fast = await measure();
  link.set(SLOW_3G);
  const slow = await measure();
  link.set(UNLIMITED);
  record("phone-reconnect", "Reconnect on a phone over slow 3G", "ms", slow.samples, {
    wireKilobytes: round(median(slow.bytes) / 1024),
    unthrottledMs: round(median(fast.samples)),
    largestSocketAnswers: slow.largest,
  });
  await phone.page.close();
});

test("attach a terminal over slow 3G", async () => {
  // Its own page, through the link.
  const linked = await newPage({ viewport: { width: 1440, height: 900 } });
  await openThroughLink(linked.page, "/");
  await timeOpen(linked.page, terminalThread, "echo: start Terminal thread");
  const panel = linked.page.getByTestId("right-panel");
  if (!(await panel.isVisible())) {
    await linked.page.getByRole("button", { name: "Show right panel" }).click();
  }
  await panel.getByRole("tab", { name: "Terminal", exact: true }).click();
  const terminal = panel.getByTestId("terminal").first();
  await expect(terminal.getByTestId("terminal-surface").locator("canvas")).toBeVisible();
  await terminal.getByTestId("terminal-surface").click();
  // Printed by the shell from arithmetic, so the echoed command line can't match the marker.
  await linked.page.keyboard.type(`seq 1 ${TERMINAL_LINES}; echo done-$((6*7))-lines`);
  await linked.page.keyboard.press("Enter");
  await expect(terminalText(terminal)).toContainText("done-42-lines", { timeout: 60_000 });

  const measure = async () => {
    const samples: number[] = [];
    const bytes: number[] = [];
    linked.wire.takeLargest();
    for (let i = 0; i < REPEATS; i++) {
      await timeOpen(linked.page, smallThread, "echo: start Short thread");
      await linked.page.waitForTimeout(500);
      link.takeBytesDown();
      const row = threadRow(linked.page, terminalThread);
      const start = performance.now();
      await row.click();
      await expect(
        terminalText(linked.page.getByTestId("right-panel").getByTestId("terminal").first()),
      ).toContainText("done-42-lines", { timeout: 120_000 });
      await painted(linked.page);
      samples.push(performance.now() - start);
      await linked.page.waitForTimeout(500);
      bytes.push(link.takeBytesDown());
    }
    return { samples, bytes, largest: linked.wire.takeLargest() };
  };
  const fast = await measure();
  link.set(SLOW_3G);
  const slow = await measure();
  link.set(UNLIMITED);
  record(
    "terminal-attach",
    `Attach a terminal with ${thousands(TERMINAL_LINES)} lines over slow 3G`,
    "ms",
    slow.samples,
    {
      wireKilobytes: round(median(slow.bytes) / 1024),
      unthrottledMs: round(median(fast.samples)),
      largestSocketAnswers: slow.largest,
    },
  );
  await linked.page.close();
});
