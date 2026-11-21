import { connect as dialPort } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dpopProof } from "./dpop.ts";
import { browser, fakeServer } from "./hosted-fake.ts";
import {
  discoverHosted,
  HOSTED_TOKEN_MOST_MS,
  HOSTED_TOKEN_RENEW_BEFORE_MS,
  exportHostedThread,
  importHostedThread,
  messageHostedThread,
  settleHostedThread,
  startHostedThread,
  stopHostedThread,
  waitHostedThread,
  listHostedWorkspaces,
  makeTokenKeeper,
  signInHosted,
  type TokenKeeper,
} from "./hosted.ts";
import { forgetHostedDevice, registerHostedDevice } from "./hosted-registration.ts";
import {
  leaseWorkerMachineRelay,
  scrubbed,
  workerMachineRelayDial,
} from "./hosted-worker-machines.ts";
import { deviceIdOf, devicePrivateKeyFrom, generateDeviceKey } from "./keys.ts";

let fake: ReturnType<typeof fakeServer>;
let origin: string;
const key = devicePrivateKeyFrom(generateDeviceKey().privateKeyPem);
let clock = 0;
const now = () => clock;

beforeEach(async () => {
  fake = fakeServer();
  origin = await fake.start();
  clock = 1_000_000;
});
afterEach(() => {
  fake.server.closeAllConnections();
  fake.server.close();
});

const signedIn = async () => {
  const found = await discoverHosted(origin, fetch);
  if (!found.ok) throw new Error(found.why);
  const signed = await signInHosted({
    discovery: found.discovery,
    key,
    openBrowser: browser,
    fetch,
    now,
  });
  if (!signed.ok) throw new Error(signed.why);
  return { discovery: found.discovery, tokens: signed.tokens };
};

const keeperFor = async (more: Partial<Parameters<typeof makeTokenKeeper>[0]> = {}) => {
  const { discovery, tokens } = await signedIn();
  return makeTokenKeeper({
    discovery,
    key,
    subject: tokens.subject,
    refreshToken: tokens.refreshToken ?? "",
    saveRefreshToken: async () => undefined,
    fetch,
    now,
    ...more,
  });
};

/** Waits, on the real clock, until something under way has happened. */
const waitFor = (done: () => boolean) => vi.waitUntil(done, { timeout: 1_000, interval: 2 });

/** Sends raw bytes to a port and answers with whatever comes back. */
const raw = (port: number, text: string) =>
  new Promise<string>((done) => {
    const socket = dialPort(port, "127.0.0.1", () => socket.write(text));
    let answer = "";
    socket.on("data", (part) => {
      answer += part.toString();
    });
    socket.on("close", () => done(answer));
    socket.on("error", () => done(answer));
    setTimeout(() => socket.destroy(), 500);
  });

const answering = (response: () => Response) => async () => response();

const broken = () =>
  new Response(
    new ReadableStream({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode("{"));
        controller.error(new Error("cut"));
      },
    }),
  );

describe("a hosted server", () => {
  it("is found at the address the person typed, and refused when it names another", async () => {
    const found = await discoverHosted(origin, fetch);
    expect(found).toMatchObject({ ok: true, origin, discovery: { name: "Example" } });
    expect(await discoverHosted("http://example.com", fetch)).toMatchObject({ ok: false });
    fake.state.issuer = "https://elsewhere.example.com";
    expect(await discoverHosted(origin, fetch)).toEqual({
      ok: false,
      why: "The server names another address as its own.",
    });
  });

  it("signs in through the browser, with PKCE and a proof of the device key", async () => {
    const { tokens } = await signedIn();
    expect(tokens).toMatchObject({ tokenType: "DPoP", subject: "person-ada" });
    expect(tokens.expiresAt).toBe(clock + 900_000);
    expect(tokens.refreshToken).toMatch(/^[a-f0-9]{32}$/);
    // The server asked for a nonce first; the proof carried it the second time.
    expect(fake.state.askNonceOnce).toBe(false);
  });

  it("names this computer to the sign-in page, on one line", async () => {
    const found = await discoverHosted(origin, fetch);
    if (!found.ok) throw new Error(found.why);
    const asked: Array<string | null> = [];
    const signInAs = async (deviceName: string | undefined) =>
      signInHosted({
        discovery: found.discovery,
        key,
        openBrowser: async (url) => {
          asked.push(new URL(url).searchParams.get("device_name"));
          await browser(url);
        },
        fetch,
        now,
        ...(deviceName === undefined ? {} : { deviceName }),
      });
    expect((await signInAs("Ada's MacBook Pro")).ok).toBe(true);
    expect((await signInAs(" studio\nbox ")).ok).toBe(true);
    expect((await signInAs("   ")).ok).toBe(true);
    expect((await signInAs(undefined)).ok).toBe(true);
    expect(asked).toEqual(["Ada's MacBook Pro", "studio box", null, null]);
  });

  it("refuses a sign-in that comes back from another server, or without Gram's state", async () => {
    const found = await discoverHosted(origin, fetch);
    if (!found.ok) throw new Error(found.why);
    fake.state.issuer = "https://elsewhere.example.com";
    expect(
      await signInHosted({ discovery: found.discovery, key, openBrowser: browser, fetch, now }),
    ).toEqual({ ok: false, why: "The sign-in came back from another server." });
    fake.state.issuer = "";
    // A page that guesses the port but not the state ends nothing; the sign-in waits on.
    const stray: Array<number> = [];
    const signed = await signInHosted({
      discovery: found.discovery,
      key,
      openBrowser: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", "stolen");
        redirect.searchParams.set("state", "guess");
        redirect.searchParams.set("iss", origin);
        stray.push((await fetch(redirect)).status);
        await browser(url);
      },
      fetch,
      now,
    });
    expect(stray).toEqual([400]);
    expect(signed.ok).toBe(true);
  });

  it("gives up on a sign-in nobody finishes", async () => {
    const found = await discoverHosted(origin, fetch);
    if (!found.ok) throw new Error(found.why);
    expect(
      await signInHosted({
        discovery: found.discovery,
        key,
        openBrowser: async () => undefined,
        fetch,
        now,
        waitMs: 50,
      }),
    ).toEqual({ ok: false, why: "The sign-in took too long." });
  });

  it("keeps a token per use, renews it near its end, and keeps the rotated refresh token", async () => {
    const { discovery, tokens } = await signedIn();
    const saved: Array<string> = [];
    const keeper = makeTokenKeeper({
      discovery,
      key,
      subject: tokens.subject,
      refreshToken: tokens.refreshToken ?? "",
      saveRefreshToken: async (token) => {
        saved.push(token);
      },
      fetch,
      now,
    });
    const first = await keeper.token("device:connect");
    const again = await keeper.token("device:connect");
    expect(first).toEqual(again);
    expect(saved).toHaveLength(1);
    const [workspaces, connecting] = await Promise.all([
      keeper.token("workspaces"),
      keeper.fresh("device:connect"),
    ]);
    expect(workspaces.ok && connecting.ok).toBe(true);
    expect(saved).toHaveLength(3);
    // Never longer than the design's fifteen minutes, whatever the server says.
    fake.state.expiresIn = 86_400;
    const long = await keeper.fresh("device:connect");
    expect(long.ok && long.token.expiresAt - clock).toBe(HOSTED_TOKEN_MOST_MS);
    clock += HOSTED_TOKEN_MOST_MS;
    const renewed = await keeper.token("device:connect");
    expect(renewed.ok && long.ok && renewed.token.accessToken !== long.token.accessToken).toBe(
      true,
    );
  });

  it("is signed out when the server ends the sign-in, or answers for someone else", async () => {
    const { discovery, tokens } = await signedIn();
    const keeper = makeTokenKeeper({
      discovery,
      key,
      subject: tokens.subject,
      refreshToken: "not-one-it-issued",
      saveRefreshToken: async () => undefined,
      fetch,
      now,
    });
    expect(await keeper.token("workspaces")).toMatchObject({ ok: false, signedOut: true });
    expect(keeper.signedOut()).toBe(true);
    const other = makeTokenKeeper({
      discovery,
      key,
      subject: "person-eve",
      refreshToken: tokens.refreshToken ?? "",
      saveRefreshToken: async () => undefined,
      fetch,
      now,
    });
    expect(await other.token("workspaces")).toEqual({
      ok: false,
      why: "The server signed in someone else.",
      signedOut: true,
    });
  });

  it("lists workspaces and registers the device's key with a signed challenge", async () => {
    const { discovery, tokens } = await signedIn();
    const keeper = makeTokenKeeper({
      discovery,
      key,
      subject: tokens.subject,
      refreshToken: tokens.refreshToken ?? "",
      saveRefreshToken: async () => undefined,
      fetch,
      now,
    });
    const calls = { discovery, keeper, key, fetch };
    expect(await listHostedWorkspaces(calls)).toMatchObject({
      ok: true,
      workspaces: [{ id: "w1", devices: "on" }],
    });
    const registered = await registerHostedDevice({
      ...calls,
      name: "Ada's laptop",
      platform: "linux",
    });
    expect(registered).toMatchObject({ ok: true });
    if (!registered.ok) return;
    expect(fake.state.registeredKey).toBeDefined();
    expect(registered.deviceId).toBe(deviceIdOf(fake.state.registeredKey ?? ""));
    fake.state.lieAboutId = true;
    expect(
      await registerHostedDevice({ ...calls, name: "Ada's laptop", platform: "linux" }),
    ).toEqual({ ok: false, why: "The server registered another key." });
    expect(await forgetHostedDevice({ ...calls, deviceId: registered.deviceId })).toBe(true);
    expect(fake.state.forgotten).toEqual([registered.deviceId]);
  });

  it("moves a thread into a workspace there with the person's sign-in, and reads the server's word", async () => {
    const { discovery } = await signedIn();
    const keeper = await keeperFor();
    const calls = { discovery, keeper, key, fetch, workspaceId: "w1", from: "Ada's laptop" };
    const bundle = { format: 1, thread: { id: "t-moved" } };
    expect(await importHostedThread({ ...calls, bundle })).toEqual({
      ok: true,
      threadId: "t-moved",
      notes: ["Its edits are back."],
    });
    expect(fake.state.imported.at(-1)).toEqual({ workspaceId: "w1", bundle, from: "Ada's laptop" });
    // Its refusal, in its words; too large; and an address elsewhere is never opened.
    fake.state.importAnswer = {
      status: 409,
      body: { error: { code: "REFUSED", message: "Start your sandbox first." } },
    };
    expect(await importHostedThread({ ...calls, bundle })).toEqual({
      ok: false,
      why: "Start your sandbox first.",
    });
    fake.state.importAnswer = { status: 413, body: {} };
    expect(await importHostedThread({ ...calls, bundle })).toMatchObject({ ok: false });
    fake.state.importAnswer = {
      status: 200,
      body: { threadId: "t-moved", url: "https://elsewhere.example.com/t" },
    };
    expect(await importHostedThread({ ...calls, bundle })).toEqual({
      ok: true,
      threadId: "t-moved",
      notes: [],
    });
    // No clear answer: it may be there, so it says so rather than "refused".
    fake.state.importAnswer = { status: 502, body: {} };
    expect(await importHostedThread({ ...calls, bundle })).toMatchObject({
      ok: false,
      unknown: true,
    });
    fake.state.importAnswer = { status: 200, body: { nothing: true } };
    expect(await importHostedThread({ ...calls, bundle })).toMatchObject({
      ok: false,
      unknown: true,
    });
    fake.state.importAnswer = { status: 409, body: { error: "Here already." } };
    expect(await importHostedThread({ ...calls, bundle })).toEqual({
      ok: false,
      why: "Here already.",
    });
    // A server that takes no threads is never sent one.
    const before = fake.state.imported.length;
    const { thread_import_endpoint: _none, ...without } = discovery;
    expect(await importHostedThread({ ...calls, discovery: without, bundle })).toMatchObject({
      ok: false,
    });
    expect(fake.state.imported.length).toBe(before);
  });

  it("asks the person to sign in again when the sign-in doesn't carry moving work", async () => {
    fake.state.importScope = false;
    const { discovery } = await signedIn();
    const keeper = await keeperFor();
    const answer = await importHostedThread({
      discovery,
      keeper,
      key,
      fetch,
      workspaceId: "w1",
      from: "Ada's laptop",
      bundle: {},
    });
    expect(answer).toMatchObject({ ok: false });
    expect(answer.ok === false && answer.why).toContain("Sign in to the server again");
    expect(fake.state.imported).toEqual([]);
  });

  it("asks for moving work only of a server that takes threads, or gives them back", async () => {
    await signedIn();
    expect(fake.state.askedScope.split(" ")).toEqual(
      expect.arrayContaining(["workspaces:import", "workspaces:export", "threads:start"]),
    );
    fake.state.takesThreads = false;
    fake.state.givesThreads = false;
    fake.state.runsWork = false;
    await signedIn();
    expect(fake.state.askedScope).toBe("workspaces device:register device:connect");
  });

  it("asks for a thread back with the person's sign-in, and settles its copy there", async () => {
    const { discovery } = await signedIn();
    const calls = { discovery, keeper: await keeperFor(), key, fetch };
    const asked = { ...calls, workspaceId: "w1", threadId: "t-1" };
    expect(await exportHostedThread(asked)).toEqual({
      ok: true,
      bundle: { format: 1, exportedAt: 1_000 },
    });
    expect(fake.state.exported).toEqual([{ workspaceId: "w1", threadId: "t-1" }]);
    // Its word, when it says no: an organisation that keeps its threads, say.
    fake.state.exportAnswer = {
      status: 403,
      body: { error: { message: "Example keeps its threads." } },
    };
    expect(await exportHostedThread(asked)).toEqual({
      ok: false,
      why: "Example keeps its threads.",
    });

    const settle = { ...asked, exportedAt: 1_000, to: "Ada's laptop" };
    expect(await settleHostedThread(settle)).toEqual({ ok: true });
    expect(fake.state.settled).toEqual([
      { workspaceId: "w1", threadId: "t-1", exportedAt: 1_000, to: "Ada's laptop" },
    ]);
    // No clear answer: the copy there may still take work, and settling again is safe.
    fake.state.settleAnswer = { status: 502, body: {} };
    expect(await settleHostedThread(settle)).toMatchObject({ ok: false, unknown: true });
    fake.state.settleAnswer = { status: 409, body: { error: "It carried on there." } };
    expect(await settleHostedThread(settle)).toEqual({ ok: false, why: "It carried on there." });

    // A server that names neither is asked nothing.
    const { thread_export_endpoint: _e, thread_settle_endpoint: _s, ...without } = discovery;
    const before = fake.state.exported.length;
    expect(await exportHostedThread({ ...asked, discovery: without })).toMatchObject({ ok: false });
    expect(fake.state.exported.length).toBe(before);
  });

  it("sends work there with the person's sign-in, then follows, answers and stops only it", async () => {
    const { discovery } = await signedIn();
    const calls = { discovery, keeper: await keeperFor(), key, fetch };
    const work = {
      ...calls,
      workspaceId: "w1",
      repositories: ["example/app"],
      text: "Fix the flaky test",
      clientKey: "send-1",
    };
    expect(await startHostedThread(work)).toEqual({
      ok: true,
      threadId: "t-sent-1",
      branch: "thread/t-sent-1",
    });
    // Sent again with its key, it is the same send: one thread there.
    expect(await startHostedThread(work)).toMatchObject({ ok: true, threadId: "t-sent-1" });
    expect(fake.state.started).toEqual([
      {
        workspaceId: "w1",
        repositories: ["example/app"],
        text: "Fix the flaky test",
        clientKey: "send-1",
      },
      {
        workspaceId: "w1",
        repositories: ["example/app"],
        text: "Fix the flaky test",
        clientKey: "send-1",
      },
    ]);

    const thread = { ...calls, workspaceId: "w1", threadId: "t-sent-1" };
    // A wait is bounded by the server's own twenty seconds, whatever is asked.
    expect(await waitHostedThread({ ...thread, after: "m-1", timeoutSeconds: 600 })).toEqual({
      ok: true,
      waited: {
        happened: true,
        latest: "m-2",
        reply: "Done: the tests pass.",
        thread: { title: "Fix the flaky test", state: "running", working: false },
      },
    });
    expect(fake.state.waited.at(-1)).toEqual({
      workspaceId: "w1",
      threadId: "t-sent-1",
      after: "m-1",
      timeoutSeconds: 20,
    });
    expect(
      await messageHostedThread({ ...thread, text: "Also the docs.", clientKey: "say-1" }),
    ).toEqual({ ok: true, queued: false, after: "m-2" });
    expect(await stopHostedThread(thread)).toEqual({ ok: true });

    // A thread it didn't send is the server's to refuse, in its words.
    expect(await stopHostedThread({ ...thread, threadId: "t-other" })).toEqual({
      ok: false,
      why: "No such thread.",
    });
    // No clear answer to a send: sending again with its key is safe.
    fake.state.startAnswer = { status: 502, body: {} };
    expect(await startHostedThread(work)).toMatchObject({ ok: false, unknown: true });
    fake.state.startAnswer = { status: 409, body: { error: "Start your sandbox first." } };
    expect(await startHostedThread(work)).toEqual({ ok: false, why: "Start your sandbox first." });
    // A long reply, a long title or a state Gram doesn't know never stops it following the thread.
    fake.state.waitAnswer = {
      status: 200,
      body: {
        happened: true,
        latest: "m-3",
        reply: "x".repeat(9000),
        thread: { title: "t".repeat(300), state: "archived", working: false },
      },
    };
    const lenient = await waitHostedThread(thread);
    expect(lenient.ok && lenient.waited.reply?.length).toBe(8000);
    expect(lenient.ok && lenient.waited.thread).toEqual({
      title: "t".repeat(200),
      state: "running",
      working: false,
    });
    // One without the thread isn't an answer.
    fake.state.waitAnswer = { status: 200, body: { happened: true } };
    expect(await waitHostedThread(thread)).toMatchObject({ ok: false });

    // A server that names the calls only in part is sent nothing.
    const { thread_stop_endpoint: _stop, ...partly } = discovery;
    const before = fake.state.started.length;
    expect(await startHostedThread({ ...work, discovery: partly })).toMatchObject({ ok: false });
    expect(fake.state.started.length).toBe(before);
  });

  it("refuses a token copied without the device key", async () => {
    const { discovery, tokens } = await signedIn();
    const keeper = makeTokenKeeper({
      discovery,
      key,
      subject: tokens.subject,
      refreshToken: tokens.refreshToken ?? "",
      saveRefreshToken: async () => undefined,
      fetch,
      now,
    });
    const held = await keeper.token("workspaces");
    if (!held.ok) throw new Error(held.why);
    const thief = devicePrivateKeyFrom(generateDeviceKey().privateKeyPem);
    const response = await fetch(discovery.workspaces_endpoint, {
      headers: {
        authorization: `DPoP ${held.token.accessToken}`,
        dpop: dpopProof(thief, {
          method: "GET",
          url: discovery.workspaces_endpoint,
          accessToken: held.token.accessToken,
          now: Date.now(),
        }),
      },
    });
    expect(response.status).toBe(401);
  });

  it("answers whatever else reaches the loopback port without ending or crashing the sign-in", async () => {
    const found = await discoverHosted(origin, fetch);
    if (!found.ok) throw new Error(found.why);
    const crashes: Array<unknown> = [];
    const onCrash = (error: unknown) => crashes.push(error);
    process.on("uncaughtException", onCrash);
    const answers: Array<string> = [];
    try {
      const signed = await signInHosted({
        discovery: found.discovery,
        key,
        fetch,
        now,
        openBrowser: async (url) => {
          const redirect = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
          const port = Number(redirect.port);
          answers.push(await raw(port, "GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n"));
          answers.push(String((await fetch(redirect, { method: "POST" })).status));
          answers.push(
            await raw(port, `GET /callback?state=x HTTP/1.1\r\nHost: evil.example\r\n\r\n`),
          );
          await browser(url);
        },
      });
      expect(signed.ok).toBe(true);
    } finally {
      process.off("uncaughtException", onCrash);
    }
    expect(crashes).toEqual([]);
    expect(answers[0]).toMatch(/^HTTP\/1\.1 (400|404)/);
    expect(answers[1]).toBe("404");
    expect(answers[2]).toMatch(/^HTTP\/1\.1 404/);
  });

  it("refuses a sign-in whose tokens aren't bound to the device, are too short, or can't be renewed", async () => {
    const found = await discoverHosted(origin, fetch);
    if (!found.ok) throw new Error(found.why);
    const signIn = () =>
      signInHosted({ discovery: found.discovery, key, openBrowser: browser, fetch, now });
    fake.state.tokenType = "Bearer";
    expect(await signIn()).toEqual({
      ok: false,
      why: "The server didn't bind the sign-in to this machine.",
    });
    fake.state.tokenType = "DPoP";
    fake.state.expiresIn = HOSTED_TOKEN_RENEW_BEFORE_MS / 1000;
    expect(await signIn()).toMatchObject({ ok: false });
    fake.state.expiresIn = 900;
    fake.state.giveRefresh = false;
    expect(await signIn()).toMatchObject({ ok: false });
    fake.state.giveRefresh = true;
    fake.state.code = "has space";
    expect(await signIn()).toEqual({ ok: false, why: "The sign-in didn't finish." });
  });

  it("stops a sign-in the person closes", async () => {
    const found = await discoverHosted(origin, fetch);
    if (!found.ok) throw new Error(found.why);
    const stop = new AbortController();
    expect(
      await signInHosted({
        discovery: found.discovery,
        key,
        fetch,
        now,
        signal: stop.signal,
        openBrowser: async () => stop.abort(),
      }),
    ).toEqual({ ok: false, why: "The sign-in was stopped." });
  });

  it("fails closed on a redirect, an answer too long, or one that breaks off", async () => {
    expect(
      await discoverHosted(
        origin,
        answering(() => new Response(null, { status: 302, headers: { location: "https://x" } })),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await discoverHosted(
        origin,
        answering(() => new Response("x".repeat(300 * 1024))),
      ),
    ).toMatchObject({ ok: false, why: "The server's answer isn't one Gram reads." });
    expect(await discoverHosted(origin, answering(broken))).toMatchObject({ ok: false });
  });

  it("keeps nothing a renewal brings back after the person signed out", async () => {
    const { discovery, tokens } = await signedIn();
    const held = Promise.withResolvers<void>();
    const saved: Array<string> = [];
    let asked = false;
    const slow: typeof fetch = async (input, init) => {
      asked = true;
      await held.promise;
      return fetch(input, init);
    };
    const keeper = makeTokenKeeper({
      discovery,
      key,
      subject: tokens.subject,
      refreshToken: tokens.refreshToken ?? "",
      saveRefreshToken: async (token) => {
        saved.push(token);
      },
      fetch: slow,
      now,
    });
    const renewing = keeper.token("workspaces");
    // Signed out once the renewal is already with the server.
    await waitFor(() => asked);
    const out = keeper.signOut();
    held.resolve();
    await out;
    expect(await renewing).toMatchObject({ ok: false, signedOut: true });
    expect(saved).toEqual([]);
    // And from a server that doesn't rotate the refresh token, so no save comes between.
    const hold = Promise.withResolvers<void>();
    let calling = false;
    const other = await keeperFor({
      fetch: async (input, init) => {
        calling = true;
        await hold.promise;
        return fetch(input, init);
      },
    });
    fake.state.giveRefresh = false;
    const renewal = other.token("workspaces");
    await waitFor(() => calling);
    const leaving = other.signOut();
    hold.resolve();
    await leaving;
    expect(await renewal).toMatchObject({ ok: false, signedOut: true });
  });

  it("uses a rotated refresh token the keychain refused, and saves it again at the next renewal", async () => {
    const { discovery, tokens } = await signedIn();
    let refuse = true;
    const saved: Array<string> = [];
    const keeper = makeTokenKeeper({
      discovery,
      key,
      subject: tokens.subject,
      refreshToken: tokens.refreshToken ?? "",
      saveRefreshToken: async (token) => {
        if (refuse) throw new Error("locked");
        saved.push(token);
      },
      fetch,
      now,
    });
    expect((await keeper.token("workspaces")).ok).toBe(true);
    expect(keeper.unsaved()).toBe(true);
    refuse = false;
    // The server took the rotated one: the old one is gone, so this works only if it was kept.
    expect((await keeper.fresh("device:connect")).ok).toBe(true);
    expect(keeper.unsaved()).toBe(false);
    expect(saved).toHaveLength(2);
  });

  it("renews a token near its end, once for every caller waiting on it", async () => {
    const { discovery, tokens } = await signedIn();
    const keeper = makeTokenKeeper({
      discovery,
      key,
      subject: tokens.subject,
      refreshToken: tokens.refreshToken ?? "",
      saveRefreshToken: async () => undefined,
      fetch,
      now,
    });
    const first = await keeper.token("workspaces");
    const before = fake.state.refreshes;
    clock += HOSTED_TOKEN_MOST_MS - HOSTED_TOKEN_RENEW_BEFORE_MS / 2;
    const [one, two] = await Promise.all([keeper.token("workspaces"), keeper.token("workspaces")]);
    expect(fake.state.refreshes).toBe(before + 1);
    expect(one).toEqual(two);
    expect(one.ok && first.ok && one.token.accessToken !== first.token.accessToken).toBe(true);
  });

  it("answers a call server's nonce, and refuses an answer that isn't a list", async () => {
    const { discovery, tokens } = await signedIn();
    const keeper = makeTokenKeeper({
      discovery,
      key,
      subject: tokens.subject,
      refreshToken: tokens.refreshToken ?? "",
      saveRefreshToken: async () => undefined,
      fetch,
      now,
    });
    const calls = { discovery, keeper, key, fetch };
    fake.state.resourceNonce = "resource-nonce";
    expect(await listHostedWorkspaces(calls)).toMatchObject({ ok: true });
    fake.state.workspacesStatus = 500;
    expect(await listHostedWorkspaces(calls)).toEqual({
      ok: false,
      why: "The server refused the call.",
    });
  });

  it("never lets a slow keychain write land over a newer refresh token", async () => {
    const written: Array<string> = [];
    const first = Promise.withResolvers<void>();
    let calls = 0;
    const keeper = await keeperFor({
      saveWaitMs: 20,
      saveRefreshToken: async (token) => {
        calls += 1;
        if (calls === 1) await first.promise;
        written.push(token);
      },
    });
    expect((await keeper.token("workspaces")).ok).toBe(true);
    expect(keeper.unsaved()).toBe(true);
    const renewing = keeper.fresh("device:connect");
    await new Promise((later) => setTimeout(later, 30));
    first.resolve();
    expect((await renewing).ok).toBe(true);
    await new Promise((later) => setTimeout(later, 30));
    expect(keeper.unsaved()).toBe(false);
    // What the keychain holds last is the one the server will take.
    const again = await keeperFor({ refreshToken: written.at(-1) ?? "" });
    expect((await again.token("workspaces")).ok).toBe(true);
  });

  it("finishes a keychain write before sign-out settles, and keeps nothing a save let through", async () => {
    const release = Promise.withResolvers<void>();
    let writing = false;
    const keeper = await keeperFor({
      // The renewal stops waiting for the keychain at once; the write goes on.
      saveWaitMs: 5,
      saveRefreshToken: async () => {
        writing = true;
        await release.promise;
      },
    });
    const renewing = keeper.token("workspaces");
    await waitFor(() => writing);
    let out = false;
    const signingOut = keeper.signOut().then(() => {
      out = true;
    });
    await new Promise((later) => setTimeout(later, 20));
    expect(out).toBe(false);
    release.resolve();
    await signingOut;
    await renewing;
    expect(await keeper.token("workspaces")).toMatchObject({ ok: false, signedOut: true });
  });

  it("hands out a fresh token once, and keeps the token endpoint's nonce apart from the calls'", async () => {
    const keeper = await keeperFor();
    const fresh = await keeper.fresh("workspaces");
    const held = await keeper.token("workspaces");
    expect(fresh.ok && held.ok && fresh.token.accessToken !== held.token.accessToken).toBe(true);
    fake.state.alwaysTokenNonce = true;
    fake.state.resourceNonce = "calls-own-nonce";
    await keeper.fresh("workspaces");
    const errors = fake.state.tokenNonceErrors;
    const found = await discoverHosted(origin, fetch);
    if (!found.ok) throw new Error(found.why);
    await listHostedWorkspaces({ discovery: found.discovery, keeper, key, fetch });
    await keeper.fresh("workspaces");
    expect(fake.state.tokenNonceErrors).toBe(errors);
  });

  it("stops a sign-in closed after the browser came back, and doesn't wait on the browser", async () => {
    const found = await discoverHosted(origin, fetch);
    if (!found.ok) throw new Error(found.why);
    const stop = new AbortController();
    expect(
      await signInHosted({
        discovery: found.discovery,
        key,
        fetch,
        now,
        signal: stop.signal,
        openBrowser: async (url) => {
          await browser(url);
          stop.abort();
        },
      }),
    ).toEqual({ ok: false, why: "The sign-in was stopped." });
    const signed = await signInHosted({
      discovery: found.discovery,
      key,
      fetch,
      now,
      openBrowser: (url) => {
        void browser(url);
        return new Promise(() => undefined);
      },
    });
    expect(signed.ok).toBe(true);
  });

  it("sends a device name of at most 128 characters, whole", async () => {
    const keeper = await keeperFor();
    const found = await discoverHosted(origin, fetch);
    if (!found.ok) throw new Error(found.why);
    await registerHostedDevice({
      discovery: found.discovery,
      keeper,
      key,
      fetch,
      name: "\u{1F600}".repeat(200),
      platform: "linux",
    });
    expect([...(fake.state.names[0] ?? "")]).toHaveLength(128);
    expect(fake.state.names[0]?.isWellFormed()).toBe(true);
  });
});

describe("an answer about a worker machine, as it leaves the app", () => {
  it("drops the token it was called with, and anything shaped like a signed token", () => {
    const jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJwZXJzb24ifQ.c2lnbmF0dXJlLWJ5dGVz";
    expect(
      scrubbed(
        {
          message: "Bad call with secret-access-token-1234 attached",
          choices: [{ note: `proof ${jwt}` }],
          name: "worker-0123456789",
        },
        ["secret-access-token-1234"],
      ),
    ).toEqual({
      message: "Bad call with [redacted] attached",
      choices: [{ note: "proof [redacted]" }],
      name: "worker-0123456789",
    });
    // A model id or a version, with its dots, is left alone.
    expect(scrubbed("claude-opus-5.5 on 1.32.0", [])).toBe("claude-opus-5.5 on 1.32.0");
  });
});

describe("a worker machine relay's lease", () => {
  it("asks the server each time, so a sign-in it revoked ends the lease at once", async () => {
    fake.state.workerMachinesScope = true;
    const keeper = await keeperFor();
    // A token held and good for its fifteen minutes.
    expect((await keeper.token("machines:workers")).ok).toBe(true);
    expect(await leaseWorkerMachineRelay(keeper)).toBe(true);
    // Revoked there: every refresh token it issued is no good any more.
    fake.state.refresh.clear();
    expect(await leaseWorkerMachineRelay(keeper)).toBe(false);
    // Found now, not once the cached token runs out: the sign-in is over.
    expect(keeper.signedOut()).toBe(true);
  });
});

/** A proof's claims, as a server reads them. */
const claimsOf = (proof: string) =>
  JSON.parse(Buffer.from(proof.split(".")[1]!, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;

describe("a worker machine relay's dial", () => {
  const discovery = {
    worker_machines_endpoint: "https://hosted.example.test/desktop/worker-machines",
    worker_machine_connect: "wss://hosted.example.test/desktop/worker-machines/connect",
  } as unknown as Parameters<typeof workerMachineRelayDial>[0]["discovery"];

  it("is signed with a nonce the server gave just before, for the relay's own address", async () => {
    const token = {
      accessToken: "synthetic-access",
      tokenType: "DPoP" as const,
      expiresAt: Date.now() + 600_000,
      subject: "person",
    };
    // The nonce last kept has aged out there; the server gives a new one on the next call.
    const keeper = {
      subject: "person",
      token: async () => ({ ok: true as const, token }),
      fresh: async () => ({ ok: true as const, token }),
      nonce: { value: "aged" },
      signedOut: () => false,
      signOut: async () => undefined,
      unsaved: () => false,
    } as unknown as TokenKeeper;
    const asked: Array<{ url: string; nonce: unknown }> = [];
    const fetchOf = (async (url: string, init?: RequestInit) => {
      const proof = new Headers(init?.headers).get("dpop") ?? "";
      asked.push({ url, nonce: claimsOf(proof)["nonce"] });
      return asked.length === 1
        ? new Response("{}", {
            status: 401,
            headers: {
              "dpop-nonce": "fresh-nonce",
              "www-authenticate": 'DPoP error="use_dpop_nonce"',
            },
          })
        : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const dialled = await workerMachineRelayDial({
      discovery,
      keeper,
      key,
      fetch: fetchOf,
      name: "worker-0123456789",
    });
    if (!dialled.ok) throw new Error(dialled.why);
    expect(dialled.url).toBe(
      "wss://hosted.example.test/desktop/worker-machines/connect?name=worker-0123456789",
    );
    expect(asked.map((each) => each.nonce)).toEqual(["aged", "fresh-nonce"]);
    const claims = claimsOf(dialled.headers["dpop"]!);
    expect(claims["htm"]).toBe("GET");
    expect(claims["htu"]).toBe("wss://hosted.example.test/desktop/worker-machines/connect");
    expect(claims["nonce"]).toBe("fresh-nonce");
  });
});
