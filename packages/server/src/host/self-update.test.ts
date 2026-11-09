import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  HOST_PROTOCOL_VERSION,
  type HostBusy,
  type HostUpdateProgress,
  LOCAL_HOST_ID,
} from "@gram/contracts";
import { Proc, ProcLive, Worktrees, WorktreesLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { attachmentsOnHost, fileReadsOn } from "./file-reads.ts";
import { filesOn } from "./files.ts";
import { gitOn } from "./git.ts";
import { RELEASES } from "./install-script.ts";
import { connectHost, HOST_SERVES, serveHost, type HostService } from "./protocol.ts";
import { reposOn } from "./repos.ts";
import {
  appLayout,
  busyText,
  compareReleases,
  makeSelfUpdate,
  LOCK_FILE,
  recoverUpdate,
  releaseAsset,
  STALE_MS,
  type SupervisorMode,
  type SelfUpdateDeps,
  superviseUpdate,
  supervisorCommand,
  UPDATE_FILE,
  type UpdatePlan,
} from "./self-update.ts";
import { hostUpdaterOf } from "./self-update-host.ts";
import { makeAdmission, UPDATING } from "./admission.ts";
import type { ServiceCommand } from "./service.ts";
import { noAgents, sessionsOnHost } from "./sessions.ts";
import { terminalsOnHost } from "./terminals.ts";
import { streamPair } from "./test-stream.ts";

const IDLE: HostBusy = { turns: 0, terminals: 0, clones: 0, checks: 0 };
const OLD = "1.16.0";
const NEW = "1.17.0";
const ASSET = releaseAsset(NEW, "linux", "x64")!;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "gram-self-update-"));
  dirs.push(dir);
  return dir;
};

/** A synthetic release: its download, and the checksum list that names it (or another hash). */
const fakeRelease = (body: string, listed = createHash("sha256").update(body).digest("hex")) => {
  const asked: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    asked.push(url);
    if (url === `${RELEASES}/v${NEW}/SHA256SUMS.txt`)
      return new Response(`${"0".repeat(64)}  other.zip\n${listed}  ${ASSET}\n`);
    if (url === `${RELEASES}/v${NEW}/${ASSET}`)
      return new Response(body, { headers: { "content-length": String(body.length) } });
    return new Response("not found", { status: 404 });
  };
  return { fetcher, asked };
};

/** The service running now: the old app, as the installer laid it out. */
const serviceOf = (apps: string, home: string, release = OLD): ServiceCommand => {
  const { bin, entry } = appLayout("linux", join(apps, release));
  return {
    program: [bin, entry, "run"],
    env: { GRAM_HOST_HOME: home, GRAM_HOST_SERVICE: "1", PATH: "/usr/bin:/bin" },
    home,
  };
};

/** An app laid out in `dir`, as unpacking a release leaves it. */
const layOut = (dir: string) => {
  const { bin, entry } = appLayout("linux", dir);
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(entry, "// gram-host\n");
};

/** A host on the old release, with a fake release to update to, and what it was asked to do. */
const setup = (
  options: {
    readonly release?: ReturnType<typeof fakeRelease>;
    readonly busy?: () => HostBusy;
    readonly probe?: boolean;
    readonly overrides?: Partial<SelfUpdateDeps>;
  } = {},
) => {
  const home = temp();
  const apps = join(home, "apps");
  layOut(join(apps, OLD));
  const release = options.release ?? fakeRelease("the new app");
  const handed: UpdatePlan[] = [];
  const modes: SupervisorMode[] = [];
  const unpacked: string[] = [];
  const admission = makeAdmission();
  const deps: SelfUpdateDeps = {
    release: OLD,
    platform: "linux",
    arch: "x64",
    home,
    apps,
    current: serviceOf(apps, home),
    busy: async () => (options.busy ?? (() => IDLE))(),
    fetch: release.fetcher,
    unpack: async (archive, into) => {
      unpacked.push(readFileSync(archive, "utf8"));
      layOut(into);
    },
    probe: async (bin) => (options.probe ?? true) && existsSync(bin),
    handOver: async (plan, mode) => {
      handed.push(plan);
      modes.push(mode);
    },
    admission,
    settleMs: 0,
    now: () => 1_000,
    ...options.overrides,
  };
  return {
    home,
    apps,
    deps,
    handed,
    modes,
    admission,
    unpacked,
    release,
    updater: makeSelfUpdate(deps),
  };
};

/** The phases in order, a run of download steps as one. */
const phases = (seen: ReadonlyArray<HostUpdateProgress>) =>
  seen.map((step) => step.phase).filter((phase, at, all) => at === 0 || all[at - 1] !== phase);

const steps = async (
  updater: ReturnType<typeof makeSelfUpdate>,
  release = NEW,
): Promise<{ readonly steps: HostUpdateProgress[]; readonly refused: unknown }> => {
  const seen: HostUpdateProgress[] = [];
  const refused = await updater.start(release, (step) => seen.push(step));
  return { steps: seen, refused };
};

describe("releases", () => {
  it("orders releases, a prerelease before its release", () => {
    expect(compareReleases("1.16.0", "1.17.0")).toBeLessThan(0);
    expect(compareReleases("1.17.0", "1.16.9")).toBeGreaterThan(0);
    expect(compareReleases("1.17.0-beta.1", "1.17.0")).toBeLessThan(0);
    expect(compareReleases("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareReleases("1.17.0", "1.17.0")).toBe(0);
    // Numeric prerelease identifiers by value, as semver and the release tooling order them.
    expect(compareReleases("1.17.0-rc.2", "1.17.0-rc.10")).toBeLessThan(0);
    expect(compareReleases("1.17.0-rc.10", "1.17.0-rc.2")).toBeGreaterThan(0);
    expect(compareReleases("1.17.0-beta.11", "1.17.0-rc.1")).toBeLessThan(0);
    expect(compareReleases("1.17.0-rc.1", "1.17.0-rc.1.1")).toBeLessThan(0);
    expect(compareReleases("1.17.0-1", "1.17.0-alpha")).toBeLessThan(0);
  });

  it("names the release's own downloads, and none for a platform Gram doesn't make", () => {
    expect(releaseAsset("1.17.0", "darwin", "arm64")).toBe("gram_1.17.0_darwin-arm64_signed.zip");
    expect(releaseAsset("1.17.0", "linux", "x64")).toBe("gram_1.17.0_x86_64.AppImage");
    expect(releaseAsset("1.17.0", "linux", "arm64")).toBeUndefined();
    expect(releaseAsset("1.17.0", "darwin", "x64")).toBeUndefined();
  });

  it("words what keeps a machine busy", () => {
    expect(busyText({ turns: 1, terminals: 2, clones: 0, checks: 0 })).toBe(
      "1 running turn and 2 busy terminals",
    );
    expect(busyText({ turns: 0, terminals: 0, clones: 1, checks: 0 })).toBe("1 clone");
  });
});

describe("a host updating itself", () => {
  it("downloads only from Gram's own release, checks it, unpacks and tests it, then hands over", async () => {
    const { apps, home, updater, handed, release, unpacked } = setup();
    const run = await steps(updater);
    expect(run.refused).toBeUndefined();
    expect(release.asked).toEqual([
      `${RELEASES}/v${NEW}/SHA256SUMS.txt`,
      `${RELEASES}/v${NEW}/${ASSET}`,
    ]);
    expect(unpacked).toEqual(["the new app"]);
    expect(run.steps.at(1)).toEqual({ phase: "downloading", received: 11, total: 11 });
    expect(phases(run.steps)).toEqual([
      "downloading",
      "verifying",
      "unpacking",
      "testing",
      "switching",
    ]);
    // The new app is in place beside the old one, which stays until the new one dials in.
    expect(existsSync(join(apps, NEW, ".complete"))).toBe(true);
    expect(existsSync(appLayout("linux", join(apps, OLD)).bin)).toBe(true);
    expect(handed).toHaveLength(1);
    const plan = handed[0]!;
    expect(plan).toMatchObject({ release: NEW, from: OLD, phase: "switching" });
    expect(plan.previous.program[0]).toBe(appLayout("linux", join(apps, OLD)).bin);
    expect(plan.next.program).toEqual([
      appLayout("linux", join(apps, NEW)).bin,
      appLayout("linux", join(apps, NEW)).entry,
      "run",
    ]);
    expect(plan.next.env).toEqual(plan.previous.env);
    expect(JSON.parse(readFileSync(join(home, UPDATE_FILE), "utf8"))).toMatchObject({
      release: NEW,
      phase: "switching",
    });
    // The supervisor runs the app the host ran, outside the service.
    expect(supervisorCommand(plan.previous, plan.id).program).toEqual([
      ...plan.previous.program.slice(0, 2),
      "update-supervise",
      plan.id,
    ]);
    expect(supervisorCommand(plan.previous, plan.id, "rollback").program.at(-1)).toBe("rollback");
    expect(supervisorCommand(plan.previous, plan.id).env["GRAM_HOST_SERVICE"]).toBeUndefined();
  });

  it("installs nothing and runs nothing from a download that doesn't match its checksum", async () => {
    const { apps, home, updater, handed, unpacked } = setup({
      release: fakeRelease(
        "a tampered app",
        createHash("sha256").update("the real app").digest("hex"),
      ),
    });
    const run = await steps(updater);
    expect(run.refused).toMatchObject({
      reason: "failed",
      message: `${ASSET} doesn't match its checksum; nothing was installed.`,
    });
    expect(unpacked).toEqual([]);
    expect(handed).toEqual([]);
    expect(existsSync(join(apps, NEW))).toBe(false);
    expect(existsSync(join(home, UPDATE_FILE))).toBe(false);
    // Nothing of the download is left behind either.
    expect(readFileSyncDir(apps)).toEqual([OLD]);
  });

  it("refuses a release the release lists no checksum for", async () => {
    const release = fakeRelease("the new app");
    const { updater, handed } = setup({
      release: {
        ...release,
        fetcher: async (input, init) =>
          String(input).endsWith("SHA256SUMS.txt")
            ? new Response(`${"0".repeat(64)}  other.zip\n`)
            : release.fetcher(input, init),
      },
    });
    expect((await steps(updater)).refused).toMatchObject({
      reason: "failed",
      message: `The release lists no checksum for ${ASSET}.`,
    });
    expect(handed).toEqual([]);
  });

  it("doesn't move to an app that doesn't start, and leaves it out of place", async () => {
    const { apps, updater, handed } = setup({ probe: false });
    expect((await steps(updater)).refused).toMatchObject({
      reason: "failed",
      message: `Gram ${NEW} didn't start here, so nothing was installed.`,
    });
    expect(handed).toEqual([]);
    expect(readFileSyncDir(apps)).toEqual([OLD]);
  });

  it("defers while busy, then updates without downloading again once idle", async () => {
    let busy: HostBusy = { turns: 1, terminals: 0, clones: 0, checks: 0 };
    const { updater, handed, release } = setup({ busy: () => busy });
    // Busy before it starts: nothing is fetched.
    expect((await steps(updater)).refused).toMatchObject({
      reason: "busy",
      message: "It is busy: 1 running turn.",
      busy: { turns: 1 },
    });
    expect(release.asked).toEqual([]);

    // Work starts while it downloads: the app stays ready, the service stays where it is.
    let calls = 0;
    const flipping = setup({
      busy: () => (calls++ === 0 ? IDLE : { turns: 0, terminals: 2, clones: 0, checks: 0 }),
    });
    expect((await steps(flipping.updater)).refused).toMatchObject({
      reason: "busy",
      busy: { terminals: 2 },
    });
    expect(flipping.handed).toEqual([]);
    expect(flipping.release.asked).toHaveLength(2);
    calls = 0;
    const flippingAgain = makeSelfUpdate({ ...flipping.deps, busy: async () => IDLE });
    expect((await steps(flippingAgain)).refused).toBeUndefined();
    // Already unpacked and tested: no second download.
    expect(flipping.release.asked).toHaveLength(2);
    expect(flipping.handed).toHaveLength(1);

    busy = IDLE;
    expect((await steps(updater)).refused).toBeUndefined();
    expect(handed).toHaveLength(1);
  });

  it("takes only a newer release, never from source or outside its service", async () => {
    expect((await steps(setup().updater, "../../evil")).refused).toMatchObject({
      reason: "invalid",
    });
    expect((await steps(setup().updater, "https://example.com/x")).refused).toMatchObject({
      reason: "invalid",
    });
    expect((await steps(setup().updater, OLD)).refused).toMatchObject({ reason: "invalid" });
    expect((await steps(setup().updater, "1.15.0")).refused).toMatchObject({ reason: "invalid" });
    expect(
      (await steps(setup({ overrides: { release: undefined } }).updater)).refused,
    ).toMatchObject({ reason: "unsupported" });
    expect(
      (await steps(setup({ overrides: { current: undefined } }).updater)).refused,
    ).toMatchObject({ reason: "unsupported" });
    expect(
      (await steps(setup({ overrides: { platform: "linux", arch: "arm64" } }).updater)).refused,
    ).toMatchObject({ reason: "unsupported" });
  });
});

/** The names in `dir`. */
const readFileSyncDir = (dir: string) => (existsSync(dir) ? readdirSync(dir).toSorted() : []);

/** A fake clock the supervisor's waits advance. */
const clock = () => {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
};

describe("the update's supervisor", () => {
  it("moves the service, and once the new host is asked its check, lets the old app go", async () => {
    const { apps, home, updater, handed } = setup();
    expect((await steps(updater)).refused).toBeUndefined();
    const plan = handed[0]!;
    const shim = join(home, "gram-host");
    writeFileSync(shim, "#!/bin/sh\n# Gram's own app, run as Node: its gram-host.\nexec old\n");
    const installed: ServiceCommand[] = [];
    // The new host: on the new release, it dials in and the main Gram asks it its check.
    const newHost = makeSelfUpdate({ ...setup().deps, home, apps, release: NEW });
    const time = clock();
    const outcome = await superviseUpdate(
      {
        home,
        apps,
        shim,
        install: async (command) => {
          installed.push(command);
        },
        now: time.now,
        sleep: async (ms) => {
          await time.sleep(ms);
          if (time.now() >= 6_000) {
            const check = await newHost.check();
            expect(check.last).toMatchObject({ release: NEW, outcome: "updated" });
          }
        },
        log: () => undefined,
      },
      plan.id,
    );
    expect(outcome).toMatchObject({ release: NEW, outcome: "updated" });
    expect(installed).toEqual([plan.next]);
    expect(readFileSyncDir(apps)).toEqual([NEW]);
    expect(readFileSync(shim, "utf8")).toContain(appLayout("linux", join(apps, NEW)).bin);
    expect(JSON.parse(readFileSync(join(home, UPDATE_FILE), "utf8"))).toMatchObject({
      phase: "done",
      outcome: { outcome: "updated" },
    });
  });

  it("rolls back to the previous app when the new one never dials in", async () => {
    const { apps, home, updater, handed, deps } = setup();
    expect((await steps(updater)).refused).toBeUndefined();
    const plan = handed[0]!;
    const installed: ServiceCommand[] = [];
    const time = clock();
    const outcome = await superviseUpdate(
      {
        home,
        apps,
        install: async (command) => {
          installed.push(command);
        },
        now: time.now,
        sleep: time.sleep,
        log: () => undefined,
      },
      plan.id,
    );
    expect(outcome).toMatchObject({
      release: NEW,
      outcome: "rolledBack",
      message: `Gram ${NEW} didn't dial in within 2 minutes.`,
    });
    // Onto the new app, then back to the one it ran.
    expect(installed).toEqual([plan.next, plan.previous]);
    expect(readFileSyncDir(apps)).toEqual([OLD]);
    // The old host, back, says so when asked, and doesn't confirm anything.
    const back = await makeSelfUpdate(deps).check();
    expect(back.last).toMatchObject({ release: NEW, outcome: "rolledBack" });
  });

  it("rolls back when the service can't move to the new app", async () => {
    const { apps, home, updater, handed } = setup();
    expect((await steps(updater)).refused).toBeUndefined();
    const installed: ServiceCommand[] = [];
    const time = clock();
    const outcome = await superviseUpdate(
      {
        home,
        apps,
        install: async (command) => {
          installed.push(command);
          if (installed.length === 1) throw new Error("systemctl --user restart failed (1)");
        },
        now: time.now,
        sleep: time.sleep,
        log: () => undefined,
      },
      handed[0]!.id,
    );
    expect(outcome?.outcome).toBe("rolledBack");
    expect(installed).toEqual([handed[0]!.next, handed[0]!.previous]);
    expect(readFileSyncDir(apps)).toEqual([OLD]);
  });

  it("does nothing when no update is waiting", async () => {
    const home = temp();
    const time = clock();
    const installed: ServiceCommand[] = [];
    expect(
      await superviseUpdate(
        {
          home,
          apps: join(home, "apps"),
          install: async (command) => {
            installed.push(command);
          },
          now: time.now,
          sleep: time.sleep,
          log: () => undefined,
        },
        "0123456789abcdef",
      ),
    ).toBeUndefined();
    expect(installed).toEqual([]);
  });
});

/** The supervisor's own seams over `fixture`, on a fake clock, recording what it installed. */
const supervising = (
  fixture: { readonly home: string; readonly apps: string },
  options: {
    readonly install?: (command: ServiceCommand) => Promise<void>;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly confirmMs?: number;
  } = {},
) => {
  const time = clock();
  const installed: ServiceCommand[] = [];
  return {
    installed,
    deps: {
      home: fixture.home,
      apps: fixture.apps,
      install: async (command: ServiceCommand) => {
        installed.push(command);
        await options.install?.(command);
      },
      now: time.now,
      sleep: async (ms: number) => {
        await time.sleep(ms);
        await options.sleep?.(ms);
      },
      ...(options.confirmMs === undefined ? {} : { confirmMs: options.confirmMs }),
      log: () => undefined,
    },
  };
};

// Each of these failed on c0a36524, in the independent review's synthetic reproductions.
describe("review regressions", () => {
  it("closes admission before its last look at what runs, and keeps it closed through the handover", async () => {
    let refusedAtHandover: unknown;
    const fixture = setup({
      overrides: {
        handOver: async () => {
          // Work that arrives while the supervisor is starting: refused, not started.
          refusedAtHandover = await Effect.runPromise(
            fixture.admission.admit(Effect.succeed("started"), () => UPDATING).pipe(Effect.flip),
          );
        },
      },
    });
    expect((await steps(fixture.updater)).refused).toBeUndefined();
    expect(refusedAtHandover).toBe(UPDATING);
    // Still closed once handed over: the service stops this process next.
    expect(fixture.admission.closed()).toBe(true);
  });

  it("counts work admitted just before the gate closed, and opens the gate again when it waits", async () => {
    const fixture = setup();
    let finish!: () => void;
    // A delivery admitted before the gate closes, not yet answered and not yet a running turn.
    const delivery = Effect.runPromise(
      fixture.admission.admit(
        Effect.promise(() => new Promise<void>((resolve) => (finish = resolve))),
        () => UPDATING,
      ),
    );
    const run = await steps(fixture.updater);
    expect(run.refused).toMatchObject({ reason: "busy", busy: { turns: 1 } });
    expect(fixture.handed).toEqual([]);
    expect(fixture.admission.closed()).toBe(false);
    finish();
    await delivery;
    // Once it has answered, the next try goes ahead without downloading again.
    expect((await steps(fixture.updater)).refused).toBeUndefined();
    expect(fixture.release.asked).toHaveLength(2);
  });

  it("takes one start at a time, and none while an update is under way", async () => {
    const fixture = setup();
    const results = await Promise.all([
      fixture.updater.start(NEW, () => undefined),
      fixture.updater.start(NEW, () => undefined),
    ]);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    expect(results).toContainEqual(expect.objectContaining({ reason: "failed" }));
    expect(fixture.handed).toHaveLength(1);
    // Another process (a host restarted meanwhile) sees the plan and leaves it alone too.
    const again = makeSelfUpdate({ ...fixture.deps, admission: makeAdmission() });
    expect(await again.start(NEW, () => undefined)).toMatchObject({
      reason: "failed",
      message: `An update to ${NEW} is still under way.`,
    });
    expect(fixture.handed).toHaveLength(1);
  });

  it("lets one supervisor act, on its own plan only, and keeps both apps through it", async () => {
    const fixture = setup();
    await steps(fixture.updater);
    const plan = fixture.handed[0]!;
    // A wrong id is no supervisor of this plan.
    const stranger = supervising(fixture);
    expect(await superviseUpdate(stranger.deps, "0123456789abcdef")).toBeUndefined();
    expect(stranger.installed).toEqual([]);
    // While the first holds the lock, a second started for the same plan leaves it alone.
    let second: Promise<unknown> | undefined;
    const secondSupervisor = supervising(fixture);
    const newHost = makeSelfUpdate({ ...fixture.deps, release: NEW, admission: makeAdmission() });
    const first = supervising(fixture, {
      sleep: async () => {
        second ??= superviseUpdate(secondSupervisor.deps, plan.id);
        await newHost.check();
      },
    });
    expect(await superviseUpdate(first.deps, plan.id)).toMatchObject({ outcome: "updated" });
    expect(await second).toBeUndefined();
    expect(secondSupervisor.installed).toEqual([]);
    expect(readFileSyncDir(fixture.apps)).toEqual([NEW]);
    expect(existsSync(join(fixture.home, LOCK_FILE))).toBe(false);
  });

  it("removes only the app it ran before, not one staged since", async () => {
    const fixture = setup();
    await steps(fixture.updater);
    layOut(join(fixture.apps, "1.18.0"));
    const newHost = makeSelfUpdate({ ...fixture.deps, release: NEW, admission: makeAdmission() });
    const supervisor = supervising(fixture, { sleep: async () => void (await newHost.check()) });
    expect(await superviseUpdate(supervisor.deps, fixture.handed[0]!.id)).toMatchObject({
      outcome: "updated",
    });
    expect(readFileSyncDir(fixture.apps)).toEqual([NEW, "1.18.0"]);
  });

  it("keeps both apps and says it failed when moving the service back fails", async () => {
    const fixture = setup();
    await steps(fixture.updater);
    const plan = fixture.handed[0]!;
    let service = plan.previous;
    const supervisor = supervising(fixture, {
      confirmMs: 0,
      install: async (command) => {
        if (command.program[0] === plan.previous.program[0])
          throw new Error("rollback cannot rewrite service file");
        service = command;
      },
    });
    const outcome = await superviseUpdate(supervisor.deps, plan.id);
    expect(outcome).toMatchObject({ outcome: "failed" });
    expect(outcome?.message).toContain("both apps are kept");
    // The service still names the new app, and it is still there.
    expect(service).toEqual(plan.next);
    expect(existsSync(service.program[0]!)).toBe(true);
    expect(readFileSyncDir(fixture.apps)).toEqual([OLD, NEW]);
  });

  it("never downgrades by prerelease order", async () => {
    let fetches = 0;
    const fixture = setup({
      overrides: {
        release: "1.17.0-rc.10",
        fetch: async () => {
          fetches += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });
    expect(await fixture.updater.start("1.17.0-rc.2", () => undefined)).toMatchObject({
      reason: "invalid",
    });
    expect(fetches).toBe(0);
  });

  it("rolls back on its next start an update a reboot left without its supervisor", async () => {
    const fixture = setup();
    await steps(fixture.updater);
    const plan = fixture.handed[0]!;
    const handed: Array<[UpdatePlan, SupervisorMode]> = [];
    const recover = (now: number, release = OLD) =>
      recoverUpdate({
        home: fixture.home,
        release,
        now: () => now,
        handOver: async (each, mode) => void handed.push([each, mode]),
      });
    // Within its wait the supervisor may still be starting: left alone.
    expect(await recover(plan.startedAt + 1_000)).toBeUndefined();
    expect(await recover(plan.startedAt + STALE_MS + 1)).toBe("rollback");
    expect(handed).toEqual([[plan, "rollback"]]);
    // The supervisor it starts only moves the service back.
    const supervisor = supervising(fixture);
    expect(await superviseUpdate(supervisor.deps, plan.id, "rollback")).toMatchObject({
      outcome: "rolledBack",
    });
    expect(supervisor.installed).toEqual([plan.previous]);
    expect(readFileSyncDir(fixture.apps)).toEqual([OLD]);
  });

  it("finishes on its next start an update confirmed before a reboot", async () => {
    const fixture = setup();
    await steps(fixture.updater);
    const plan = fixture.handed[0]!;
    await makeSelfUpdate({ ...fixture.deps, release: NEW, admission: makeAdmission() }).check();
    expect(
      await recoverUpdate({
        home: fixture.home,
        release: NEW,
        now: () => plan.startedAt + 10,
        handOver: async () => undefined,
      }),
    ).toBe("finished");
    expect(JSON.parse(readFileSync(join(fixture.home, UPDATE_FILE), "utf8"))).toMatchObject({
      phase: "done",
      outcome: { outcome: "updated" },
    });
    // And a later update can start.
    expect(
      await makeSelfUpdate({ ...fixture.deps, release: NEW, admission: makeAdmission() }).start(
        "1.18.0",
        () => undefined,
      ),
    ).not.toMatchObject({ message: expect.stringContaining("still under way") });
  });
});

/** A fake host on one end of a stream that serves `update`, and the main Gram's connection. */
const connected = (
  updater: ReturnType<typeof makeSelfUpdate>,
  admission?: ReturnType<typeof makeAdmission>,
) =>
  Effect.gen(function* () {
    const { host, control } = yield* streamPair;
    const service: HostService = {
      hello: {
        protocol: HOST_PROTOCOL_VERSION,
        hostId: LOCAL_HOST_ID,
        capabilities: [...HOST_SERVES, "update"],
        platform: "linux",
        pid: 4242,
        release: OLD,
      },
      files: filesOn(yield* Proc),
      reads: fileReadsOn(yield* Proc),
      attachments: yield* attachmentsOnHost(temp()),
      repos: reposOn(yield* Proc, "/nonexistent/gram-host-repos"),
      worktrees: yield* Worktrees,
      git: gitOn(yield* Proc),
      terminals: yield* terminalsOnHost,
      sessions: yield* sessionsOnHost(noAgents),
      scan: Effect.succeed({ listening: new Map(), children: new Map() }),
      update: hostUpdaterOf(updater),
      ...(admission === undefined ? {} : { admission }),
    };
    yield* Effect.forkScoped(
      serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), service),
    );
    return yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)));
  });

describe("host.update over the wire", () => {
  const layer = WorktreesLive.pipe(Layer.provideMerge(ProcLive));

  it.effect("refuses new work over the wire while an update has closed the gate", () =>
    Effect.gen(function* () {
      const fixture = setup();
      const connection = yield* connected(fixture.updater, fixture.admission);
      fixture.admission.close();
      const clone = yield* connection.repos.ensure("https://example.com/a/b.git").pipe(Effect.flip);
      expect(clone.message).toContain(UPDATING);
      const shell = yield* connection.terminals
        .open({ cwd: tmpdir(), cols: 80, rows: 24 }, undefined)
        .pipe(Effect.flip);
      expect(shell.message).toContain(UPDATING);
      // Open again, the same call reaches the host's own answer instead.
      fixture.admission.open();
      const after = yield* connection.repos.ensure("https://example.com/a/b.git").pipe(Effect.flip);
      expect(after.message).not.toContain(UPDATING);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("streams the update's steps, and a refusal as the host's own answer", () =>
    Effect.gen(function* () {
      const ok = setup();
      const connection = yield* connected(ok.updater);
      expect(connection.update).toBeDefined();
      const seen = yield* connection.update!.start(NEW).pipe(Stream.runCollect);
      expect(phases(seen)).toEqual([
        "downloading",
        "verifying",
        "unpacking",
        "testing",
        "switching",
      ]);
      expect(ok.handed).toHaveLength(1);

      const tampered = setup({
        release: fakeRelease("tampered", createHash("sha256").update("real").digest("hex")),
      });
      const refused = yield* (yield* connected(tampered.updater))
        .update!.start(NEW)
        .pipe(Stream.runCollect, Effect.flip);
      expect(refused).toMatchObject({ _tag: "HostUpdateRefused", reason: "failed" });
      expect(tampered.handed).toEqual([]);

      const busy = setup({ busy: () => ({ turns: 0, terminals: 1, clones: 0, checks: 0 }) });
      const busyConnection = yield* connected(busy.updater);
      const deferred = yield* busyConnection
        .update!.start(NEW)
        .pipe(Stream.runCollect, Effect.flip);
      expect(deferred).toMatchObject({
        _tag: "HostUpdateRefused",
        reason: "busy",
        busy: { terminals: 1 },
      });
      // The connection stays up after a refusal.
      expect(busyConnection.gone()).toBe(false);
      expect(yield* busyConnection.update!.check).toEqual({
        busy: { turns: 0, terminals: 1, clones: 0, checks: 0 },
      });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("leaves update out for a host that doesn't advertise it", () =>
    Effect.gen(function* () {
      const { host, control } = yield* streamPair;
      const service: HostService = {
        hello: {
          protocol: HOST_PROTOCOL_VERSION,
          hostId: LOCAL_HOST_ID,
          capabilities: HOST_SERVES,
          platform: "linux",
          pid: 1,
        },
        files: filesOn(yield* Proc),
        reads: fileReadsOn(yield* Proc),
        attachments: yield* attachmentsOnHost(temp()),
        repos: reposOn(yield* Proc, "/nonexistent/gram-host-repos"),
        worktrees: yield* Worktrees,
        git: gitOn(yield* Proc),
        terminals: yield* terminalsOnHost,
        sessions: yield* sessionsOnHost(noAgents),
        scan: Effect.succeed({ listening: new Map(), children: new Map() }),
      };
      yield* Effect.forkScoped(
        serveHost(yield* NodeSocket.fromDuplex(Effect.succeed(host)), service),
      );
      const connection = yield* connectHost(yield* NodeSocket.fromDuplex(Effect.succeed(control)));
      expect(connection.update).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
