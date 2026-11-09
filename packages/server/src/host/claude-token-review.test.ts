// Regressions for the independent security review of #314 (head b15b9662). Each case failed on
// that head. Fixtures are synthetic: no real token, CLI, shell profile or account is read.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { HOST_PROTOCOL_VERSION, HostFailed, HostUnavailable, LOCAL_HOST_ID } from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest, HttpServerResponse } from "../platform/unstable.ts";
import {
  claudeTokenCaptureFor,
  machineManagement,
  MACHINES_REMOVE_PATH,
  MACHINES_TOKEN_START_PATH,
  MACHINES_TOKEN_STATUS_PATH,
  TOKEN_CONSENT,
} from "../http/machine-routes.ts";
import {
  type ClaudeTokenCapture,
  scanSetupTokenOutput,
  type SetupTokenProcess,
} from "./claude-token-capture.ts";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { generateHostKey } from "./machine-keys.ts";
import {
  createPairedMachines,
  memoryMachineStore,
  type PairedMachine,
  type PairedMachineStore,
} from "./paired-machines.ts";
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
const SETUP_TOKEN = `sk-ant-oat01-${"SYNTHETICsetupTokenForGramReviewTests_".repeat(2)}AA`;
/** Synthetic: a different token, as a shell profile might already export. */
const STARTUP_TOKEN = `sk-ant-oat01-${"SYNTHETICstartupProfileTokenNotToSend_".repeat(2)}AA`;
const ORIGIN = "https://main.example-tailnet.ts.net";

const settle = (ms = 30) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** A synthetic `claude setup-token` the test drives. */
const fakeProcess = () => {
  const data: Array<(chunk: string) => void> = [];
  const process: SetupTokenProcess = {
    onData: (listener) => void data.push(listener),
    onExit: () => {},
    write: () => {},
    kill: () => {},
  };
  return { process, print: (chunk: string) => data.forEach((listener) => listener(chunk)) };
};

/** Machines joined through the real join flow, with keys, so a same-key rejoin is possible. */
const joinedMachines = (store: PairedMachineStore = memoryMachineStore()) => {
  const machines = createPairedMachines(store);
  const joinWith = (key: ReturnType<typeof generateHostKey>, name = "build box") => {
    const code = new URLSearchParams(new URL(machines.mint(ORIGIN).url).hash.slice(1)).get("code")!;
    const joined = machines.join(ORIGIN, { code, name, platform: "linux", ...key });
    if (joined.kind !== "joined") throw new Error(joined.message);
    machines.confirm(joined.machine.id);
    return joined.machine.id;
  };
  return { machines, joinWith };
};

/** A `RemoteHostsShape` over `machines`, every machine online and answering with `claude`. */
const hostsOver = (
  machines: ReturnType<typeof createPairedMachines>,
  claude: HostClaudeToken,
  online: () => boolean = () => true,
): RemoteHostsShape => ({
  machines,
  connection: (id) =>
    online() && machines.get(id) !== undefined
      ? Effect.succeed({ claude } as unknown as HostConnection)
      : Effect.fail(new HostUnavailable({ hostId: id, message: "That machine is offline." })),
  origin: () => undefined,
  list: () =>
    machines
      .list()
      .map((m: PairedMachine) => ({ id: m.id, name: m.name })) as unknown as ReturnType<
      RemoteHostsShape["list"]
    >,
  admit: () => {
    throw new Error("No machine dials in these tests.");
  },
  attach: () => Effect.void,
  checkSignIn: () => Promise.resolve(undefined),
  remove: (id) => machines.remove(id),
  keepOrigin: () => {},
});

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

/** Starts a run for `ids` with consent, its process driven by the test. */
const startRun = (hosts: RemoteHostsShape, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fake = fakeProcess();
    const capture = yield* claudeTokenCaptureFor(hosts, () => fake.process);
    const started = yield* post(
      hosts,
      MACHINES_TOKEN_START_PATH,
      { ids, consent: TOKEN_CONSENT },
      capture,
    );
    expect(started.status, started.text).toBe(200);
    const { captureId } = JSON.parse(started.text) as { captureId: string };
    return { capture, captureId, print: fake.print };
  });

describe("review finding 1: Remove after an uncertain or pending write", () => {
  it.effect("deletes a token whose write lost its reply", () =>
    Effect.gen(function* () {
      const { machines, joinWith } = joinedMachines();
      const id = joinWith(generateHostKey());
      const events: Array<string> = [];
      const hosts = hostsOver(machines, {
        // The host wrote it, then its reply was lost.
        setToken: () =>
          Effect.sync(() => void events.push("written")).pipe(
            Effect.andThen(Effect.fail(new HostFailed({ message: HOST_TOKEN_UNANSWERED }))),
          ),
        forgetToken: Effect.sync(() => {
          events.push("forgot");
          return true;
        }),
      });
      const { capture, print } = yield* startRun(hosts, [id]);
      print(`${SETUP_TOKEN}\r\n`);
      yield* settle();
      const removed = yield* post(hosts, MACHINES_REMOVE_PATH, { id }, capture);
      expect(removed.status).toBe(200);
      expect(events).toEqual(["written", "forgot"]);
    }),
  );

  it.effect("waits for a send in flight, then deletes it, before forgetting the machine", () =>
    Effect.gen(function* () {
      const { machines, joinWith } = joinedMachines();
      const id = joinWith(generateHostKey());
      const events: Array<string> = [];
      const release = yield* Deferred.make<void>();
      const hosts = hostsOver(machines, {
        setToken: () =>
          Deferred.await(release).pipe(
            Effect.andThen(Effect.sync(() => void events.push("written"))),
          ),
        forgetToken: Effect.sync(() => {
          events.push("forgot");
          return true;
        }),
      });
      const { capture, print } = yield* startRun(hosts, [id]);
      print(`${SETUP_TOKEN}\r\n`);
      yield* settle();
      const removing = yield* Effect.forkScoped(post(hosts, MACHINES_REMOVE_PATH, { id }, capture));
      yield* settle();
      yield* Deferred.succeed(release, undefined);
      const removed = yield* Fiber.join(removing);
      expect(removed.status).toBe(200);
      expect(events).toEqual(["written", "forgot"]);
    }),
  );

  it.effect("sends nothing when it can't first record that the machine may hold a token", () =>
    Effect.gen(function* () {
      let failWrites = false;
      const inner = memoryMachineStore();
      const { machines, joinWith } = joinedMachines({
        read: inner.read,
        write: (next) => {
          if (failWrites) throw new Error("disk full");
          inner.write(next);
        },
      });
      const id = joinWith(generateHostKey());
      const sent: Array<string> = [];
      const hosts = hostsOver(machines, {
        setToken: () => Effect.sync(() => void sent.push("sent")),
        forgetToken: Effect.succeed(true),
      });
      const { capture, captureId, print } = yield* startRun(hosts, [id]);
      failWrites = true;
      print(`${SETUP_TOKEN}\r\n`);
      yield* settle();
      expect(sent).toEqual([]);
      const status = yield* post(hosts, MACHINES_TOKEN_STATUS_PATH, { captureId }, capture);
      expect(JSON.parse(status.text)).toMatchObject({
        state: "done",
        results: [{ id, ok: false }],
      });
    }),
  );
});

describe("review finding 2: consent is for one join", () => {
  it.effect("isn't carried over to the same key joining again after a Remove", () =>
    Effect.gen(function* () {
      const { machines, joinWith } = joinedMachines();
      const key = generateHostKey();
      const id = joinWith(key);
      const sent: Array<string> = [];
      const hosts = hostsOver(machines, {
        setToken: () => Effect.sync(() => void sent.push("sent")),
        forgetToken: Effect.succeed(true),
      });
      const { capture, captureId, print } = yield* startRun(hosts, [id]);
      // Removed while the browser sign-in is open, then joined and confirmed again, same key.
      expect((yield* post(hosts, MACHINES_REMOVE_PATH, { id }, capture)).status).toBe(200);
      expect(joinWith(key)).toBe(id);
      print(`${SETUP_TOKEN}\r\n`);
      yield* settle();
      expect(sent).toEqual([]);
      const status = yield* post(hosts, MACHINES_TOKEN_STATUS_PATH, { captureId }, capture);
      expect(JSON.parse(status.text)).toMatchObject({ results: [{ id, ok: false }] });
    }),
  );
});

/**
 * A login shell whose startup prints an already-exported token (as `set -x` in a profile would),
 * and a synthetic `claude` that prints its own token and records which risky settings it got.
 */
const shellFixture = (startupPrintsToken: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "gram-setup-token-shell-"));
  const report = join(root, "report.json");
  const claude = join(root, "claude");
  writeFileSync(
    claude,
    `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify({
  args: process.argv.slice(2),
  risky: ["NODE_OPTIONS", "BASH_ENV", "SSLKEYLOGFILE", "NODE_DEBUG", "CLAUDE_CODE_OAUTH_TOKEN"].filter((k) => process.env[k] !== undefined),
}));
process.stdout.write("Your OAuth token (valid for 1 year):\\r\\n\\r\\n${SETUP_TOKEN}\\r\\n\\r\\nStore this token securely.\\r\\n");
setTimeout(() => process.exit(0), 50);
`,
  );
  chmodSync(claude, 0o755);
  const shell = join(root, "shell");
  writeFileSync(
    shell,
    `#!${process.execPath}
const script = process.argv.at(-1) ?? "";
${startupPrintsToken ? `process.stdout.write("+ export CLAUDE_CODE_OAUTH_TOKEN=${STARTUP_TOKEN}\\n");` : ""}
if (script.includes("command -v claude")) {
  const env = Object.entries(process.env).map(([k, v]) => k + "=" + v + "\\0").join("");
  process.stdout.write("\\0__SB_PROBE__\\0${claude}\\n\\0__SB_ENV__\\0" + env);
} else {
  require("node:child_process").spawnSync(${JSON.stringify(claude)}, ["setup-token"], { stdio: "inherit" });
}
`,
  );
  chmodSync(shell, 0o755);
  return { root, shell, report, done: () => rmSync(root, { recursive: true, force: true }) };
};

/** Runs the real launch (no process injected) to its end under `fixture`'s shell. */
const launchUnder = (fixture: ReturnType<typeof shellFixture>) =>
  Effect.gen(function* () {
    const saved = { ...process.env };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
        Object.assign(process.env, saved);
        fixture.done();
      }),
    );
    Object.assign(process.env, {
      SHELL: fixture.shell,
      NODE_OPTIONS: "--no-deprecation",
      BASH_ENV: join(fixture.root, "nonexistent-bash-env"),
      SSLKEYLOGFILE: join(fixture.root, "nonexistent-keylog"),
      NODE_DEBUG: "gram-review-synthetic",
      CLAUDE_CODE_OAUTH_TOKEN: STARTUP_TOKEN,
    });
    const { machines, joinWith: joinOne } = joinedMachines();
    const id = joinOne(generateHostKey());
    const got: Array<string> = [];
    const hosts = hostsOver(machines, {
      setToken: (token) => Effect.sync(() => void got.push(Redacted.value(token))),
      forgetToken: Effect.succeed(true),
    });
    const capture = yield* claudeTokenCaptureFor(hosts);
    const started = yield* post(
      hosts,
      MACHINES_TOKEN_START_PATH,
      { ids: [id], consent: TOKEN_CONSENT },
      capture,
    );
    const { captureId } = JSON.parse(started.text) as { captureId: string };
    let view: { state?: string } = {};
    for (let i = 0; i < 100 && view.state !== "done" && view.state !== "failed"; i++) {
      yield* settle(50);
      view = JSON.parse(
        (yield* post(hosts, MACHINES_TOKEN_STATUS_PATH, { captureId }, capture)).text,
      ) as { state?: string };
    }
    return { view, got };
  });

describe("review findings 3 and 4: what the capture launches", () => {
  it.live(
    "3: takes only the token setup-token prints, not one the shell's startup printed",
    () =>
      Effect.gen(function* () {
        const { view, got } = yield* launchUnder(shellFixture(true));
        expect(view.state).toBe("done");
        expect(got).toEqual([SETUP_TOKEN]);
      }).pipe(Effect.scoped),
    20_000,
  );

  it.live(
    "4: launches claude itself, without debugger, preload, TLS-logging or token settings",
    () =>
      Effect.gen(function* () {
        const fixture = shellFixture(false);
        const report = fixture.report;
        const { view } = yield* launchUnder(fixture);
        expect(view.state).toBe("done");
        expect(existsSync(report)).toBe(true);
        expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({
          args: ["setup-token"],
          risky: [],
        });
      }).pipe(Effect.scoped),
    20_000,
  );
});

const HostLayer = WorktreesLive.pipe(Layer.provideMerge(ProcLive));

describe("review finding 5: a host's refusal is not passed on as it says it", () => {
  it.effect("is read as a fixed message when it quotes what it was sent", () =>
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
        claude: {
          setToken: (token) =>
            Effect.fail(new HostFailed({ message: `refused ${Redacted.value(token)}` })),
          forgetToken: Effect.succeed(false),
        },
      };
      yield* Effect.forkScoped(
        serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), service),
      );
      const connection = yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)));
      const failure = yield* connection.claude
        .setToken(Redacted.make(SETUP_TOKEN))
        .pipe(Effect.flip);
      expect(failure.message).not.toContain(SETUP_TOKEN.slice(13, 50));
    }).pipe(Effect.scoped, Effect.provide(HostLayer)),
  );
});

describe("review finding 6: the sign-in link the page is shown", () => {
  it("is only Claude's own authorization page, whole, with no token in it", () => {
    const good =
      "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(scanSetupTokenOutput(`Use the url below to sign in:\r\n${good}\r\n`).signInLink).toBe(
      good,
    );
    for (const output of [
      // Not yet ended: more may follow.
      `${good.slice(0, 60)}`,
      // A token in its query.
      `https://claude.ai/oauth/authorize?code=true&state=${SETUP_TOKEN}\r\n`,
      // Someone else's page.
      "https://claude.ai.example.net/oauth/authorize?code=true\r\n",
      "https://evil.example/oauth/authorize?code=true\r\n",
      // Credentials or another path on the right host.
      "https://user:pass@claude.ai/oauth/authorize?code=true\r\n",
      "https://claude.ai/logout?next=oauth\r\n",
    ])
      expect(scanSetupTokenOutput(output).signInLink, output).toBeUndefined();
  });
});

// Re-review of 8897fc4d (comment 6733115769). Each case failed on that head.

describe("re-review R1: Remove holds the machine for the whole operation", () => {
  it.effect(
    "refuses a second run for a machine being removed, so its delete is the last word",
    () =>
      Effect.gen(function* () {
        const { machines, joinWith } = joinedMachines();
        const id = joinWith(generateHostKey());
        const events: Array<string> = [];
        const deleting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const hosts = hostsOver(machines, {
          setToken: () => Effect.sync(() => void events.push("set")),
          forgetToken: Effect.sync(() => void events.push("delete")).pipe(
            Effect.andThen(Deferred.succeed(deleting, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as(true),
          ),
        });
        const processes: Array<ReturnType<typeof fakeProcess>> = [];
        const capture = yield* claudeTokenCaptureFor(hosts, () => {
          const next = fakeProcess();
          processes.push(next);
          return next.process;
        });
        const start = () =>
          post(hosts, MACHINES_TOKEN_START_PATH, { ids: [id], consent: TOKEN_CONSENT }, capture);
        // Run A delivers.
        expect((yield* start()).status).toBe(200);
        yield* settle();
        processes[0]!.print(`${SETUP_TOKEN}\r\n`);
        yield* settle();
        // Remove is waiting on the machine's delete...
        const removing = yield* Effect.forkScoped(
          post(hosts, MACHINES_REMOVE_PATH, { id }, capture),
        );
        yield* Deferred.await(deleting);
        // ...when another window starts run B for the same machine.
        const second = yield* start();
        if (second.status === 200) {
          yield* settle();
          processes[1]?.print(`${SETUP_TOKEN}\r\n`);
          yield* settle();
        }
        yield* Deferred.succeed(release, undefined);
        const removed = yield* Fiber.join(removing);
        expect(second.status).toBe(409);
        expect(events).toEqual(["set", "delete"]);
        expect(JSON.parse(removed.text)).not.toHaveProperty("tokenLeft");
      }),
  );
});

describe("re-review R3: a host's refusal is a fixed message chosen here", () => {
  it.effect("drops a refusal that carries anything beyond a known error code", () =>
    Effect.gen(function* () {
      const fragment = SETUP_TOKEN.slice(13, 40);
      const { host, control } = yield* streamPair;
      const refusals = [
        `Couldn't keep the Claude token: E ${fragment}.`,
        `Couldn't keep the Claude token: ${fragment}.`,
        "Couldn't keep the Claude token: EACCES.",
      ];
      let next = 0;
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
        claude: {
          setToken: () =>
            Effect.suspend(() => Effect.fail(new HostFailed({ message: refusals[next++]! }))),
          forgetToken: Effect.succeed(false),
        },
      };
      yield* Effect.forkScoped(
        serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), service),
      );
      const connection = yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)));
      const messages: Array<string> = [];
      for (const _ of refusals)
        messages.push(
          (yield* connection.claude.setToken(Redacted.make(SETUP_TOKEN)).pipe(Effect.flip)).message,
        );
      for (const message of messages) expect(message, message).not.toContain(fragment.slice(0, 12));
      // A known code still reads as itself.
      expect(messages[2]).toBe("Couldn't keep the Claude token: EACCES.");
    }).pipe(Effect.scoped, Effect.provide(HostLayer)),
  );
});

describe("re-review R4 and R5: links the output could carry", () => {
  it("rejects a malformed escape rather than throwing", () => {
    for (const output of [
      "https://claude.ai/oauth/authorize?code=true&state=%FF\r\n",
      "https://claude.ai/oauth/authorize?code=true&state=%E0%A4\r\n",
    ])
      expect(() => scanSetupTokenOutput(output)).not.toThrow();
    expect(
      scanSetupTokenOutput("https://claude.ai/oauth/authorize?code=true&state=%FF\r\n").signInLink,
    ).toBeUndefined();
  });

  it("rejects a token hidden by encoding it twice", () => {
    const twice = encodeURIComponent(encodeURIComponent(SETUP_TOKEN));
    const once = encodeURIComponent(SETUP_TOKEN.slice(13));
    for (const state of [twice, once, SETUP_TOKEN.slice(13)])
      expect(
        scanSetupTokenOutput(`https://claude.ai/oauth/authorize?code=true&state=${state}\r\n`)
          .signInLink,
        state,
      ).toBeUndefined();
  });
});

// Third review of e1a156b4 (comment 6733323388): R5 through `redirect_uri`. The token's alphabet is
// URL-unreserved, so encoding it changes nothing; these encode a character by hand.

/** `text` with its first `s` written as `%73`, so the raw link has no `sk-ant-` in it. */
const hide = (text: string) => text.replace("sk-ant-", "%73k-ant-");

describe("re-review R5 again: a token encoded into a link's parameters", () => {
  it("is refused in the decoded redirect_uri, as in any other parameter", () => {
    const token = `sk-ant-oat01-${"SYNTHETIC_".repeat(10)}`;
    const cases = [
      `redirect_uri=${hide(encodeURIComponent(`https://claude.ai/${token}`))}`,
      `redirect_uri=${hide(encodeURIComponent(`https://claude.ai/oauth/${token}`))}`,
      // The body alone, no prefix, still the whole credential's secret part.
      `redirect_uri=${encodeURIComponent(`https://claude.ai/${token.slice(13)}`)}`,
      `state=${hide(token)}`,
    ];
    for (const query of cases) {
      const output = `https://claude.ai/oauth/authorize?code=true&${query}\r\n`;
      expect(output).not.toContain("sk-ant-");
      expect(scanSetupTokenOutput(output).signInLink, query).toBeUndefined();
    }
  });

  it("still shows a real redirect", () => {
    const link =
      "https://claude.ai/oauth/authorize?code=true&client_id=00000000-0000-4000-8000-000000000000&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(scanSetupTokenOutput(`${link}\r\n`).signInLink).toBe(link);
  });
});
