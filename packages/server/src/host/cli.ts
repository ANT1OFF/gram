import { hostname } from "node:os";
import { createInterface } from "node:readline";
import type { HostId } from "@gram/contracts";
import { HostId as HostIdSchema } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { remoteOrigin } from "../http/remote-access.ts";
import { dialForever } from "./dial.ts";
import {
  ensureHostHome,
  forgetJoined,
  type HostConfig,
  hostHome,
  readHostConfig,
  readHostKey,
  writeJoined,
} from "./host-config.ts";
import {
  fingerprintOf,
  generateHostKey,
  HOST_JOIN_PATH,
  hostIdOf,
  privateKeyFrom,
  publicKeyText,
} from "./machine-keys.ts";
import type { HostService } from "./protocol.ts";
import {
  installService,
  serviceCommand,
  serviceFile,
  servicePlatform,
  serviceRunning,
  uninstallService,
} from "./service.ts";
import { createPublicKey } from "node:crypto";
import { superviseHere } from "./self-update-host.ts";

const USAGE = `gram-host: run this machine's work for a Gram on another machine, over Tailscale.

  gram-host join [--name <name>] [--no-service]
      Join the Gram that made a join link (Settings → Machines → Add a machine), pasted when
      asked or piped in, and run as a background service. Confirm the fingerprint it prints
      on that machine. The link can also follow \`join\`, but then it lands in shell history.
  gram-host run          Dial the main Gram and serve it, in the foreground.
  gram-host service install | uninstall | status
  gram-host status       What this machine joined, its fingerprint and the service's state.
  gram-host leave [--no-service]
      Stop the service and forget the join, its key and any Claude token. With --no-service, for
      a machine that joined with --no-service, it forgets them without stopping a service.

GRAM_HOST_HOME sets the folder the host keeps its join and key in, and GRAM_HOST_REPOS the one
it clones repositories into for the workers placed on it (by default, repos in GRAM_HOST_HOME).`;

/** A join link's origin and code, or why it isn't one. */
export const parseJoinLink = (
  link: string,
): { readonly origin: string; readonly code: string } | { readonly error: string } => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return { error: "That isn't a join link." };
  }
  const code = new URLSearchParams(url.hash.slice(1)).get("code");
  if (url.pathname !== HOST_JOIN_PATH || code === null || !/^[a-f0-9]{64}$/.test(code))
    return { error: "That isn't a join link. Make one in Settings → Machines on the main Gram." };
  try {
    const origin = remoteOrigin(url.origin);
    return origin === undefined ? { error: "That isn't a join link." } : { origin, code };
  } catch {
    return { error: "A join link must be the main Gram's https://….ts.net address." };
  }
};

/** The name a machine joins with by default: its host name, cut to what the main Gram accepts. */
export const defaultName = (raw = hostname()): string => {
  const name = raw
    .replace(/\.local$/, "")
    .replace(/[^\p{L}\p{N} ._'-]/gu, "-")
    .slice(0, 64);
  return name === "" ? "machine" : name;
};

/** One line from standard input, the prompt shown when it is a terminal; undefined at its end. */
const readLine = (prompt: string) =>
  Effect.callback<string | undefined>((resume) => {
    const lines = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    if (process.stdin.isTTY) process.stdout.write(prompt);
    let done = false;
    lines.once("line", (line) => {
      done = true;
      lines.close();
      resume(Effect.succeed(line.trim()));
    });
    lines.once("close", () => {
      if (!done) resume(Effect.succeed(undefined));
    });
    return Effect.sync(() => lines.close());
  });

const flag = (args: ReadonlyArray<string>, name: string) => args.includes(name);
const option = (args: ReadonlyArray<string>, name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const say = (text: string) => Effect.sync(() => process.stdout.write(`${text}\n`));
const fail = (text: string) =>
  Effect.sync(() => {
    process.stderr.write(`gram-host: ${text}\n`);
    process.exitCode = 1;
  });

const install = (home: string) =>
  Effect.gen(function* () {
    const platform = servicePlatform();
    if (platform === undefined)
      return yield* fail(
        "A background service is only made on macOS and Linux; use `gram-host run`.",
      );
    const exit = yield* installService(platform, serviceCommand(home)).pipe(Effect.exit);
    if (exit._tag === "Failure")
      return yield* fail(`The service didn't start: ${String(exit.cause)}`);
    yield* say(`Running as a background service (${exit.value}).`);
    if (platform === "linux")
      yield* say('To keep it running while you\'re logged out: loginctl enable-linger "$USER"');
  });

const join = (args: ReadonlyArray<string>, home: string) =>
  Effect.gen(function* () {
    // Read from the terminal by default, so the code stays out of shell history and `ps`.
    const link =
      args.find((arg) => !arg.startsWith("--") && arg !== option(args, "--name")) ??
      (yield* readLine("Paste the join link from the main Gram: "));
    if (link === undefined || link === "")
      return yield* fail("Give the join link: gram-host join, then paste it.");
    const parsed = parseJoinLink(link);
    if ("error" in parsed) return yield* fail(parsed.error);
    // Refuse an unsafe destination before the one-use invitation can be consumed.
    ensureHostHome(home);
    const existing = readHostConfig(home);
    if (existing !== undefined)
      return yield* fail(
        `This machine already joined ${existing.origin}. Run \`gram-host leave\` first to join another.`,
      );
    const name = option(args, "--name") ?? defaultName();
    const key = generateHostKey();
    const response = yield* Effect.tryPromise(() =>
      fetch(`${parsed.origin}${HOST_JOIN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: parsed.code,
          name,
          platform: process.platform,
          publicKey: key.publicKey,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }),
    ).pipe(Effect.option);
    if (response._tag === "None")
      return yield* fail(`Couldn't reach ${parsed.origin}. Is Tailscale on here and there?`);
    const text = yield* Effect.promise(() => response.value.text().catch(() => ""));
    if (!response.value.ok)
      return yield* fail(`The main Gram refused the join: ${text.slice(0, 200)}`);
    let hostId: string | undefined;
    try {
      hostId = (JSON.parse(text) as { hostId?: unknown }).hostId as string | undefined;
    } catch {
      hostId = undefined;
    }
    if (hostId !== hostIdOf(key.publicKey))
      return yield* fail("The main Gram answered with another machine's id; nothing was kept.");
    const config: HostConfig = { version: 1, origin: parsed.origin, hostId, name };
    writeJoined(home, config, key.privateKeyPem);
    yield* say(`Joined ${parsed.origin} as "${name}".`);
    yield* say(`Fingerprint: ${fingerprintOf(key.publicKey)}`);
    yield* say("Confirm this fingerprint on the main Gram before it gives this machine work.");
    if (!flag(args, "--no-service")) yield* install(home);
  });

const joined = (home: string) => {
  const config = readHostConfig(home);
  const pem = readHostKey(home);
  if (config === undefined || pem === undefined) return undefined;
  const key = privateKeyFrom(pem);
  const publicKey = publicKeyText(createPublicKey(key));
  if (hostIdOf(publicKey) !== config.hostId)
    throw new Error(`The key in ${home} isn't the one this machine joined with.`);
  return { config, key, publicKey };
};

/**
 * Leaves the Gram this machine joined: stops its service (`stopService`), then forgets the join
 * and its key. When the service may still be running, the join is kept, so the machine still has
 * what it needs to stop it, and nothing claims it left.
 */
export const leave = (home: string, stopService: Effect.Effect<void, Error> | undefined) =>
  (stopService ?? Effect.void).pipe(
    Effect.andThen(Effect.sync(() => forgetJoined(home))),
    Effect.andThen(say("Left. Remove this machine on the main Gram too.")),
    Effect.catch((error) =>
      fail(
        `${error.message} This machine is still joined; stop its host, then run \`gram-host leave\` again (with --no-service if no service was ever installed here).`,
      ),
    ),
  );

/**
 * The `gram-host` commands. `service` is what the host serves on each connection, with `layer`
 * the services it runs on, built once for as long as `run` runs.
 */
export const runCli = <R>(
  args: ReadonlyArray<string>,
  host: {
    readonly service: (
      hostId: HostId,
      home: string,
    ) => Effect.Effect<HostService, never, Scope.Scope | R>;
    readonly layer: Layer.Layer<R>;
  },
): Effect.Effect<void> =>
  Effect.suspend((): Effect.Effect<void> => {
    const home = hostHome();
    const [command, ...rest] = args;
    switch (command) {
      case "join":
        return join(rest, home);
      case "run": {
        const found = joined(home);
        if (found === undefined) return fail("This machine hasn't joined a Gram: gram-host join.");
        return dialForever(
          { origin: found.config.origin, hostId: found.config.hostId, key: found.key },
          host.service(HostIdSchema.make(found.config.hostId), home),
        ).pipe(Effect.provide(host.layer));
      }
      case "service": {
        const platform = servicePlatform();
        if (platform === undefined) return fail("Services are made on macOS and Linux only.");
        switch (rest[0]) {
          case "install":
            return joined(home) === undefined
              ? fail("Join a Gram first: gram-host join.")
              : install(home);
          case "uninstall":
            return uninstallService(platform).pipe(
              Effect.andThen(say("The background service is removed.")),
              Effect.catch((error) => fail(error.message)),
            );
          case "status":
            return serviceRunning(platform).pipe(
              Effect.flatMap((running) =>
                say(running ? `Running (${serviceFile(platform)}).` : "Not running."),
              ),
            );
          default:
            return fail("gram-host service install | uninstall | status");
        }
      }
      case "status":
        return Effect.gen(function* () {
          const found = joined(home);
          if (found === undefined) return yield* say("Not joined to a Gram.");
          yield* say(`Joined ${found.config.origin} as "${found.config.name}".`);
          yield* say(`Fingerprint: ${fingerprintOf(found.publicKey)}`);
          const platform = servicePlatform();
          if (platform !== undefined)
            yield* say(
              (yield* serviceRunning(platform)) ? "Service: running." : "Service: not running.",
            );
        });
      // Started by the host itself when it updates (`self-update.ts`), outside its own service.
      case "update-supervise":
        return superviseHere(home);
      case "leave": {
        const platform = servicePlatform();
        return leave(
          home,
          platform === undefined || flag(rest, "--no-service")
            ? undefined
            : uninstallService(platform),
        );
      }
      default:
        return say(USAGE);
    }
  }).pipe(
    Effect.catchDefect((defect) => fail(defect instanceof Error ? defect.message : String(defect))),
  );
