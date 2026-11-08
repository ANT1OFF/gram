import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import type { HostId } from "@gram/contracts";
import { HostId as HostIdSchema } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { remoteOrigin } from "../http/remote-access.ts";
import { dialForever } from "./dial.ts";
import {
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
  type ServiceCommand,
  serviceFile,
  servicePlatform,
  serviceRunning,
  uninstallService,
} from "./service.ts";
import { createPublicKey } from "node:crypto";

const USAGE = `gram-host: run this machine's work for a Gram on another machine, over Tailscale.

  gram-host join '<join link>' [--name <name>] [--no-service]
      Join the Gram that made the link (Settings → Machines → Add a machine), and run as a
      background service. Confirm the fingerprint it prints on that machine.
  gram-host run          Dial the main Gram and serve it, in the foreground.
  gram-host service install | uninstall | status
  gram-host status       What this machine joined, its fingerprint and the service's state.
  gram-host leave        Stop the service and forget the join and its key.

GRAM_HOST_HOME sets the folder the host keeps its join and key in.`;

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
    return { origin: remoteOrigin(url.origin) ?? "", code };
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

/** The program a service runs: this same Node and entry, with `run`. */
const serviceCommand = (home: string): ServiceCommand => {
  const entry = process.argv[1] ?? fileURLToPath(new URL("./main.ts", import.meta.url));
  return {
    program: [process.execPath, entry, "run"],
    env: {
      GRAM_HOST_HOME: home,
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      // Run under Electron's own binary, as a packaged app's host is, it has to be plain Node.
      ...(process.versions["electron"] === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
    },
    home,
  };
};

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
    const link = args.find((arg) => !arg.startsWith("--") && arg !== option(args, "--name"));
    if (link === undefined) return yield* fail("Give the join link: gram-host join '<link>'.");
    const parsed = parseJoinLink(link);
    if ("error" in parsed) return yield* fail(parsed.error);
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
 * The `gram-host` commands. `service` is what the host serves on each connection, with `layer`
 * the services it runs on, built once for as long as `run` runs.
 */
export const runCli = <R>(
  args: ReadonlyArray<string>,
  host: {
    readonly service: (hostId: HostId) => Effect.Effect<HostService, never, Scope.Scope | R>;
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
          host.service(HostIdSchema.make(found.config.hostId)),
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
      case "leave":
        return Effect.gen(function* () {
          const platform = servicePlatform();
          if (platform !== undefined) yield* uninstallService(platform);
          forgetJoined(home);
          yield* say("Left. Remove this machine on the main Gram too.");
        });
      default:
        return say(USAGE);
    }
  }).pipe(
    Effect.catchDefect((defect) => fail(defect instanceof Error ? defect.message : String(defect))),
  );
