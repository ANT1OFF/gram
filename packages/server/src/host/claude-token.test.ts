import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  HOST_PROTOCOL_VERSION,
  HostFailed,
  HostId,
  HostUnavailable,
  LOCAL_HOST_ID,
  redactText,
} from "@gram/contracts";
import { ProcLive, Proc, Worktrees, WorktreesLive } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import {
  claudeTokenCaptureFor,
  machineManagement,
  MACHINES_REMOVE_PATH,
  MACHINES_TOKEN_CANCEL_PATH,
  MACHINES_TOKEN_CODE_PATH,
  MACHINES_TOKEN_FORGET_PATH,
  MACHINES_TOKEN_START_PATH,
  MACHINES_TOKEN_STATUS_PATH,
  TOKEN_CONSENT,
} from "../http/machine-routes.ts";
import {
  type CaptureView,
  type ClaudeTokenCapture,
  makeClaudeTokenCapture,
  scanSetupTokenOutput,
  type SetupTokenProcess,
} from "./claude-token-capture.ts";
import { claudeTokenIn } from "./claude-token.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import {
  CLAUDE_TOKEN,
  forgetJoined,
  NOT_A_CLAUDE_TOKEN,
  readClaudeToken,
  writeClaudeToken,
} from "./host-config.ts";
import { createPairedMachines, memoryMachineStore, type PairedMachine } from "./paired-machines.ts";
import {
  connectHost,
  HOST_CAPABILITIES,
  HOST_TOKEN_UNANSWERED,
  type HostClaudeToken,
  type HostConnection,
  serveHost,
  type HostService,
} from "./protocol.ts";
import type { RemoteHostsShape } from "./remote-hosts.ts";
import { reposOn } from "./repos.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { streamPair } from "./test-stream.ts";

/** Synthetic: the shape `claude setup-token` prints, never a real token. */
const FAKE_TOKEN = `sk-ant-oat01-${"SYNTHETICfakeTokenForGramTestsOnly_".repeat(3)}AA`;
/** What no output, log, error or reply may contain: the token, or a long piece of its body. */
const TOKEN_BODY = FAKE_TOKEN.slice(13, 60);

const leaks = (text: string) => text.includes(FAKE_TOKEN) || text.includes(TOKEN_BODY);

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-host-token-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Every log line, its annotations and its cause, as text. */
const capturedLogs = () => {
  const lines: Array<string> = [];
  const logger = Logger.make(({ message, fiber, cause }) => {
    lines.push(
      JSON.stringify({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
        cause: Cause.pretty(cause),
      }),
    );
  });
  return { lines, layer: Logger.layer([logger]) };
};

describe("a joined machine's Claude token on disk", () => {
  it("is kept owner-only, read back, and deleted with the token or the join", () => {
    const { dir, done } = home();
    try {
      expect(readClaudeToken(dir)).toBeUndefined();
      writeClaudeToken(dir, FAKE_TOKEN);
      const path = join(dir, CLAUDE_TOKEN);
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
      expect(readClaudeToken(dir)).toBe(FAKE_TOKEN);
      forgetJoined(dir);
      expect(readClaudeToken(dir)).toBeUndefined();
    } finally {
      done();
    }
  });

  it("refuses what isn't a setup-token token without quoting it", () => {
    const { dir, done } = home();
    try {
      for (const bad of ["sk-ant-api03-notanoauthtoken000000000", `${FAKE_TOKEN}\nexport X=1`, ""])
        expect(() => writeClaudeToken(dir, bad)).toThrow(NOT_A_CLAUDE_TOKEN);
      expect(NOT_A_CLAUDE_TOKEN).not.toContain("sk-");
    } finally {
      done();
    }
  });

  it("isn't read when the file isn't private", () => {
    if (process.platform === "win32") return;
    const { dir, done } = home();
    try {
      writeClaudeToken(dir, FAKE_TOKEN);
      chmodSync(join(dir, CLAUDE_TOKEN), 0o644);
      let message = "";
      try {
        readClaudeToken(dir);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("must be a private file");
      expect(leaks(message)).toBe(false);
    } finally {
      done();
    }
  });
});

describe("reading setup-token's output", () => {
  it("finds the sign-in link, the code prompt and the whole token, through terminal escapes", () => {
    const link =
      "https://claude.ai/oauth/authorize?code=true&client_id=00000000-0000-4000-8000-000000000000&state=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const early = `\u001b[2J\u001b[1mOpening browser\u001b[22m\r\nBrowser didn't open? Use the url below to sign in:\r\n${link}\r\n\r\nPaste code here if prompted > `;
    expect(scanSetupTokenOutput(early)).toEqual({ signInLink: link, asksForCode: true });
    // Half a token isn't taken: more of it may be on its way.
    const half = `${early}\r\n\u001b[32m${FAKE_TOKEN.slice(0, 50)}`;
    expect(scanSetupTokenOutput(half).token).toBeUndefined();
    const whole = `${early}\r\nYour OAuth token:\r\n\u001b[32m${FAKE_TOKEN}\u001b[39m\r\nStore this token securely.`;
    expect(scanSetupTokenOutput(whole).token).toBe(FAKE_TOKEN);
    // At the very end, it counts once the command has exited.
    expect(scanSetupTokenOutput(`token: ${FAKE_TOKEN}`).token).toBeUndefined();
    expect(scanSetupTokenOutput(`token: ${FAKE_TOKEN}`, true).token).toBe(FAKE_TOKEN);
  });
});

/** A synthetic `claude setup-token`: the test says what it prints and when it exits. */
const fakeProcess = () => {
  const data: Array<(chunk: string) => void> = [];
  const exits: Array<() => void> = [];
  const written: Array<string> = [];
  let killed = false;
  const process: SetupTokenProcess = {
    onData: (listener) => void data.push(listener),
    onExit: (listener) => void exits.push(listener),
    write: (chunk) => void written.push(chunk),
    kill: () => {
      killed = true;
    },
  };
  return {
    process,
    print: (chunk: string) => data.forEach((listener) => listener(chunk)),
    exit: () => exits.forEach((listener) => listener()),
    written,
    killed: () => killed,
  };
};

const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));

describe("the setup-token capture", () => {
  it.effect("sends the token to each consented machine and keeps it out of every view", () =>
    Effect.gen(function* () {
      const fake = fakeProcess();
      const got: Array<[string, string]> = [];
      const sent: Array<string> = [];
      const capture = yield* makeClaudeTokenCapture({
        start: () => fake.process,
        send: (id, token) =>
          id === "m-refuses"
            ? Effect.fail(new HostFailed({ message: HOST_TOKEN_UNANSWERED }))
            : Effect.sync(() => void got.push([id, Redacted.value(token)])),
        mark: (id) => void sent.push(id),
        joinOf: () => "join",
      });
      const { captureId } = yield* capture.begin(["m-a", "m-refuses"]);
      yield* settle;
      const views: Array<CaptureView | undefined> = [capture.view(captureId)];
      fake.print("Paste code here if prompted > ");
      views.push(capture.view(captureId));
      expect(capture.view(captureId)).toEqual({ state: "waiting", asksForCode: true });
      expect(capture.answer(captureId, "synthetic-code#state")).toBe(true);
      expect(fake.written).toEqual(["synthetic-code#state\r"]);
      fake.print(`\r\n${FAKE_TOKEN}\r\n`);
      views.push(capture.view(captureId));
      expect(fake.killed()).toBe(true);
      yield* settle;
      const done = capture.view(captureId);
      views.push(done);
      expect(done).toEqual({
        state: "done",
        results: [
          { id: "m-a", ok: true },
          { id: "m-refuses", ok: false, message: HOST_TOKEN_UNANSWERED },
        ],
      });
      expect(got).toEqual([["m-a", FAKE_TOKEN]]);
      // Both were recorded as possibly holding it before anything was sent.
      expect(sent).toEqual(["m-a", "m-refuses"]);
      expect(leaks(JSON.stringify(views))).toBe(false);
      // Done, it takes no more code and isn't busy.
      expect(capture.answer(captureId, "again")).toBe(false);
      expect(capture.busy()).toBe(false);
    }),
  );

  it.effect("sends nothing when the command ends without a token, is cancelled or times out", () =>
    Effect.gen(function* () {
      const sends: Array<string> = [];
      const send = (id: string) => Effect.sync(() => void sends.push(id));
      const ended = fakeProcess();
      const capture = yield* makeClaudeTokenCapture({
        start: () => ended.process,
        send,
        mark: () => {},
        joinOf: () => "join",
      });
      const first = yield* capture.begin(["m-a"]);
      yield* settle;
      ended.print("error: not signed in\r\n");
      ended.exit();
      expect(capture.view(first.captureId)).toMatchObject({ state: "failed" });

      const cancelled = fakeProcess();
      const second = yield* makeClaudeTokenCapture({
        start: () => cancelled.process,
        send,
        mark: () => {},
        joinOf: () => "join",
      });
      const run = yield* second.begin(["m-a"]);
      yield* settle;
      expect(second.cancel(run.captureId)).toBe(true);
      expect(cancelled.killed()).toBe(true);
      // A token printed after the cancel is ignored.
      cancelled.print(`${FAKE_TOKEN}\r\n`);
      expect(second.view(run.captureId)).toEqual({ state: "cancelled" });

      const slow = fakeProcess();
      const third = yield* makeClaudeTokenCapture({
        start: () => slow.process,
        send,
        mark: () => {},
        joinOf: () => "join",
        timeoutMs: 5,
      });
      const late = yield* third.begin(["m-a"]);
      yield* settle;
      yield* settle;
      expect(third.view(late.captureId)).toMatchObject({ state: "failed" });
      expect(slow.killed()).toBe(true);
      slow.print(`${FAKE_TOKEN}\r\n`);
      yield* settle;
      expect(sends).toEqual([]);
      // Another page doesn't see a run by a guessed id.
      expect(third.view("someone-else")).toBeUndefined();
    }),
  );
});

/** A host with `claude`, served on one end of a stream, and the connection to it. */
const connected = (claude: HostClaudeToken | undefined) =>
  Effect.gen(function* () {
    const { host, control } = yield* streamPair;
    const service: HostService = {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId: LOCAL_HOST_ID,
        capabilities: HOST_CAPABILITIES,
        platform: process.platform,
        pid: 1,
      },
      files: filesOn(yield* Proc),
      repos: reposOn(yield* Proc, "/nonexistent/gram-host-repos"),
      worktrees: yield* Worktrees,
      git: gitOn(yield* Proc),
      terminals: yield* terminalsOnHost,
      sessions: yield* sessionsOnHost(noAgents),
      scan: Effect.succeed({ listening: new Map(), children: new Map() }),
      reads: fileReadsOn(yield* Proc),
      attachments: yield* attachmentsOnHost(mkdtempSync(join(tmpdir(), "gram-host-attached-"))),
      ...(claude === undefined ? {} : { claude }),
    };
    yield* Effect.forkScoped(
      serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), service),
    );
    return yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)));
  });

const HostLayer = WorktreesLive.pipe(Layer.provideMerge(ProcLive));

describe("the token over the host protocol", () => {
  it.effect("is kept and forgotten on the machine, and is never in a log or an error", () => {
    const logs = capturedLogs();
    const { dir, done } = home();
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(done));
      const host = yield* connected(claudeTokenIn(dir));
      yield* host.claude.setToken(Redacted.make(FAKE_TOKEN));
      expect(readFileSync(join(dir, CLAUDE_TOKEN), "utf8")).toBe(`${FAKE_TOKEN}\n`);
      expect(yield* host.claude.forgetToken).toBe(true);
      expect(readClaudeToken(dir)).toBeUndefined();
      expect(yield* host.claude.forgetToken).toBe(false);

      // A malformed token is refused by name, not quoted.
      const malformed = yield* host.claude
        .setToken(Redacted.make(`${FAKE_TOKEN} and more`))
        .pipe(Effect.flip);
      expect(malformed.message).toBe(NOT_A_CLAUDE_TOKEN);

      // The main machine's own host keeps no token.
      const local = yield* connected(undefined);
      const none = yield* local.claude.setToken(Redacted.make(FAKE_TOKEN)).pipe(Effect.flip);
      expect(none.message).toContain("doesn't keep a Claude token");

      // A host that can't handle the call (as an older one's unknown-request defect) reads as
      // not taking it, and only the kind of failure is logged.
      const broken = yield* connected({
        setToken: (token) => Effect.die(new Error(`boom ${Redacted.value(token)}`)),
        forgetToken: Effect.die("boom"),
      });
      const defect = yield* broken.claude.setToken(Redacted.make(FAKE_TOKEN)).pipe(Effect.flip);
      expect(defect.message).toBe(HOST_TOKEN_UNANSWERED);
      expect(logs.lines.some((line) => line.includes("a token call wasn't answered"))).toBe(true);

      for (const text of [
        ...logs.lines,
        malformed.message,
        none.message,
        defect.message,
        String(Redacted.make(FAKE_TOKEN)),
      ])
        expect(leaks(text), text).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(HostLayer, logs.layer)));
  });

  it("is masked by the log scrubber should one ever be printed", () => {
    expect(leaks(redactText(`token printed: ${FAKE_TOKEN} end`))).toBe(false);
    expect(leaks(redactText(`CLAUDE_CODE_OAUTH_TOKEN=${FAKE_TOKEN}`))).toBe(false);
  });
});

const MACHINE = "m-0123456789abcdef01234567";
const OTHER = "m-89abcdef0123456789abcdef";
const machine = (id: string, confirmed = true): PairedMachine => ({
  id: HostId.make(id),
  name: id === MACHINE ? "build box" : "spare",
  platform: "linux",
  publicKey: "synthetic",
  joinedAt: 1,
  ...(confirmed ? { confirmedAt: 2 } : {}),
});

/** Joined machines whose host is `online` or not, each answering token calls with `claude`. */
const fakeHosts = (
  initial: ReadonlyArray<PairedMachine>,
  online: ReadonlySet<string>,
  claude: HostClaudeToken,
) => {
  const machines = createPairedMachines(memoryMachineStore(initial));
  const removed: Array<string> = [];
  const hosts: RemoteHostsShape = {
    machines,
    connection: (id) =>
      online.has(id)
        ? Effect.succeed({ claude } as unknown as HostConnection)
        : Effect.fail(new HostUnavailable({ hostId: id, message: "That machine is offline." })),
    origin: () => undefined,
    update: () => ({ kind: "fallback" }),
    automaticUpdates: () => true,
    setAutomaticUpdates: () => undefined,
    list: () =>
      machines.list().map((m) => ({
        id: m.id,
        name: m.name,
        ...(m.claudeTokenSetAt === undefined ? {} : { claudeTokenSetAt: m.claudeTokenSetAt }),
      })) as unknown as ReturnType<RemoteHostsShape["list"]>,
    admit: () => {
      throw new Error("No machine dials in these tests.");
    },
    attach: () => Effect.void,
    checkSignIn: () => Promise.resolve(undefined),
    remove: (id) => {
      removed.push(id);
      return machines.remove(id);
    },
    keepOrigin: () => {},
  };
  return { hosts, removed };
};

/** POSTs `body` to `path` on the local app's machines routes. */
const post = (hosts: RemoteHostsShape, path: string, body: unknown, capture?: ClaudeTokenCapture) =>
  machineManagement(hosts, undefined, path, undefined, undefined, capture).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request(`http://127.0.0.1${path}`, {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1",
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(JSON.stringify(body))),
          },
          body: JSON.stringify(body),
        }),
      ),
    ),
    Effect.flatMap((response) =>
      Effect.promise(async () => {
        const web = HttpServerResponse.toWeb(response);
        return { status: web.status, text: await web.text() };
      }),
    ),
  );

describe("the machines routes for the token", () => {
  it.effect(
    "start nothing without consent, machines, or a machine that is confirmed and online",
    () =>
      Effect.gen(function* () {
        const starts: Array<string> = [];
        const { hosts } = fakeHosts([machine(MACHINE), machine(OTHER, false)], new Set([MACHINE]), {
          setToken: () => Effect.void,
          forgetToken: Effect.succeed(true),
        });
        const capture = yield* claudeTokenCaptureFor(hosts, () => {
          starts.push("started");
          return fakeProcess().process;
        });
        const refusals = [
          yield* post(hosts, MACHINES_TOKEN_START_PATH, { ids: [MACHINE] }, capture),
          yield* post(hosts, MACHINES_TOKEN_START_PATH, { ids: [MACHINE], consent: true }, capture),
          yield* post(
            hosts,
            MACHINES_TOKEN_START_PATH,
            { ids: [], consent: TOKEN_CONSENT },
            capture,
          ),
          yield* post(
            hosts,
            MACHINES_TOKEN_START_PATH,
            { ids: [MACHINE, OTHER], consent: TOKEN_CONSENT },
            capture,
          ),
          yield* post(
            hosts,
            MACHINES_TOKEN_START_PATH,
            { ids: ["m-nobody0000000000000000000"], consent: TOKEN_CONSENT },
            capture,
          ),
        ];
        expect(refusals.map((r) => r.status)).toEqual([400, 400, 400, 409, 404]);
        expect(starts).toEqual([]);
      }),
  );

  it.effect("send the token, report it without its text, and delete it on Remove", () => {
    const logs = capturedLogs();
    return Effect.gen(function* () {
      const kept: Array<string> = [];
      let forgotten = 0;
      const { hosts, removed } = fakeHosts([machine(MACHINE), machine(OTHER)], new Set([MACHINE]), {
        setToken: (token) => Effect.sync(() => void kept.push(Redacted.value(token))),
        forgetToken: Effect.sync(() => {
          forgotten += 1;
          return true;
        }),
      });
      const fake = fakeProcess();
      const capture = yield* claudeTokenCaptureFor(hosts, () => fake.process);
      const replies: Array<string> = [];
      const started = yield* post(
        hosts,
        MACHINES_TOKEN_START_PATH,
        { ids: [MACHINE], consent: TOKEN_CONSENT },
        capture,
      );
      replies.push(started.text);
      const { captureId } = JSON.parse(started.text) as { captureId: string };
      fake.print("Paste code here if prompted > ");
      // Only a printable code reaches the command: no control characters.
      const control = yield* post(
        hosts,
        MACHINES_TOKEN_CODE_PATH,
        { captureId, code: "abc\u001b[2J" },
        capture,
      );
      expect(control.status).toBe(400);
      replies.push(
        (yield* post(hosts, MACHINES_TOKEN_CODE_PATH, { captureId, code: "abc#def" }, capture))
          .text,
      );
      expect(fake.written).toEqual(["abc#def\r"]);
      fake.print(`${FAKE_TOKEN}\r\n`);
      yield* settle;
      const status = yield* post(hosts, MACHINES_TOKEN_STATUS_PATH, { captureId }, capture);
      replies.push(status.text);
      expect(JSON.parse(status.text)).toEqual({
        state: "done",
        results: [{ id: MACHINE, ok: true }],
      });
      expect(kept).toEqual([FAKE_TOKEN]);
      expect(hosts.machines.get(MACHINE)?.claudeTokenSetAt).toBeTypeOf("number");
      replies.push((yield* post(hosts, MACHINES_TOKEN_CANCEL_PATH, { captureId }, capture)).text);

      // Forget token: the machine deletes it and the record goes.
      const forgot = yield* post(hosts, MACHINES_TOKEN_FORGET_PATH, { id: MACHINE }, capture);
      expect(forgot.status).toBe(200);
      expect(forgotten).toBe(1);
      expect(hosts.machines.get(MACHINE)?.claudeTokenSetAt).toBeUndefined();

      // Remove: a machine that may hold a token deletes it before it is forgotten.
      hosts.machines.tokenSent(MACHINE, true);
      const removedReply = yield* post(hosts, MACHINES_REMOVE_PATH, { id: MACHINE }, capture);
      expect(forgotten).toBe(2);
      expect(removed).toEqual([MACHINE]);
      expect(JSON.parse(removedReply.text)).not.toHaveProperty("tokenLeft");

      // An offline machine can't be reached: Remove says the token is still there.
      hosts.machines.tokenSent(OTHER, true);
      const offline = yield* post(hosts, MACHINES_REMOVE_PATH, { id: OTHER }, capture);
      expect(JSON.parse(offline.text)).toMatchObject({ tokenLeft: true });
      expect(forgotten).toBe(2);

      for (const text of [...replies, removedReply.text, offline.text, ...logs.lines])
        expect(leaks(text), text).toBe(false);
    }).pipe(Effect.provide(logs.layer));
  });
});
