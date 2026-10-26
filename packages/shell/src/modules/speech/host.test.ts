import { join, resolve as resolvePath } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  SpeechCrashPayload,
  SpeechHostMessage,
  SpeechModelPaths,
} from "../../speech-process/protocol.ts";
import { createSpeechHost, type SpeechChild, type SpeechSender } from "./host.ts";
import {
  microphoneAccess,
  openMicrophoneSettings,
  PRIVACY_MICROPHONE_URL_MAC,
  PRIVACY_MICROPHONE_URL_WIN,
  requestMicrophoneAccess,
} from "./microphone.ts";
import { resolveSpeechModel, type ModelFs, type SpeechModelResolution } from "./model.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const PATHS: SpeechModelPaths = {
  encoder: "/e",
  decoder: "/d",
  joiner: "/j",
  tokens: "/t",
  chunkMs: 560,
};

const fakeChild = () => {
  const posted: { message: SpeechHostMessage; transfer: unknown[] | undefined }[] = [];
  const listeners = {
    message: [] as ((message: unknown) => void)[],
    exit: [] as ((code: number) => void)[],
  };
  let killed = false;
  const child: SpeechChild = {
    postMessage: (message, transfer) => posted.push({ message, transfer }),
    on: ((event: "message" | "exit", listener: never) => {
      listeners[event].push(listener);
    }) as SpeechChild["on"],
    kill: () => {
      killed = true;
      return true;
    },
  };
  return {
    child,
    posted,
    reply: (message: unknown) => {
      for (const listener of listeners.message) listener(message);
    },
    exit: (code: number) => {
      for (const listener of listeners.exit) listener(code);
    },
    killed: () => killed,
  };
};

const fakeSender = () => {
  const ports: { sessionId: string; port: unknown }[] = [];
  const crashes: SpeechCrashPayload[] = [];
  const sender: SpeechSender = {
    postPort: (payload, port) => ports.push({ sessionId: payload.sessionId, port }),
    crashed: (payload) => crashes.push(payload),
    isDestroyed: () => false,
  };
  return { sender, ports, crashes };
};

const setup = (resolved: "ok" | "missing" = "ok") => {
  const children: ReturnType<typeof fakeChild>[] = [];
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  let channels = 0;
  const host = createSpeechHost({
    fork: () => {
      const child = fakeChild();
      children.push(child);
      return child.child;
    },
    channel: () => {
      channels++;
      return { port1: `main-${channels}`, port2: `page-${channels}` };
    },
    resolveModel: async () =>
      resolved === "ok"
        ? { ok: true, paths: PATHS }
        : { ok: false, code: "model-missing", message: "not installed" },
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
    log: () => {},
  });
  const liveTimers = () => timers.filter((t) => !t.cleared);
  return { host, children, liveTimers };
};

describe("speech host", () => {
  it("forks lazily on the first session and hands each side one end of a channel", async () => {
    const { host, children } = setup();
    expect(host.running()).toBe(false);
    const page = fakeSender();
    expect(
      await host.open({ sessionId: "s-1", modelId: "m", language: "en" }, page.sender),
    ).toEqual({ ok: true });
    expect(children).toHaveLength(1);
    expect(children[0]!.posted).toEqual([
      {
        message: { type: "open", sessionId: "s-1", model: PATHS, threads: 2, language: "en" },
        transfer: ["main-1"],
      },
    ]);
    expect(page.ports).toEqual([{ sessionId: "s-1", port: "page-1" }]);
    await host.open({ sessionId: "s-2", modelId: "m" }, page.sender);
    expect(children).toHaveLength(1);
  });

  it("runs each performance stop at its thread count, the default's for anything else", async () => {
    const { host, children } = setup();
    const page = fakeSender();
    for (const performance of ["efficient", "responsive", "fastest", undefined]) {
      await host.open({ sessionId: "s", modelId: "m", performance }, page.sender);
    }
    void host.prewarm("m", "efficient");
    await flush();
    expect(children[0]!.posted.map(({ message }) => Reflect.get(message, "threads"))).toEqual([
      1, 2, 2, 2, 1,
    ]);
  });

  it("refuses a bad session id or a missing model without starting anything", async () => {
    const bad = setup();
    const page = fakeSender();
    expect(await bad.host.open({ sessionId: "../x", modelId: "m" }, page.sender)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(await bad.host.open(null, page.sender)).toMatchObject({ ok: false });
    const missing = setup("missing");
    expect(await missing.host.open({ sessionId: "s", modelId: "m" }, page.sender)).toEqual({
      ok: false,
      code: "model-missing",
      message: "not installed",
    });
    expect(await missing.host.prewarm("m")).toMatchObject({ code: "model-missing" });
    expect(bad.children).toHaveLength(0);
    expect(missing.children).toHaveLength(0);
    expect(page.ports).toHaveLength(0);
  });

  it("reports a crash to the open session's page, and forks afresh for the next", async () => {
    const { host, children } = setup();
    const page = fakeSender();
    await host.open({ sessionId: "s-1", modelId: "m" }, page.sender);
    const prewarmed = host.prewarm("m");
    await flush();
    children[0]!.exit(139);
    expect(page.crashes).toEqual([
      { sessionId: "s-1", message: "the speech process exited with code 139" },
    ]);
    expect(await prewarmed).toMatchObject({ ok: false, code: "crashed" });
    expect(host.running()).toBe(false);
    await host.open({ sessionId: "s-2", modelId: "m" }, page.sender);
    expect(children).toHaveLength(2);
  });

  it("stops the process once it has been idle, and doesn't call that a crash", async () => {
    const { host, children, liveTimers } = setup();
    const page = fakeSender();
    await host.open({ sessionId: "s-1", modelId: "m" }, page.sender);
    expect(liveTimers()).toHaveLength(0);
    children[0]!.reply({ type: "ended", sessionId: "s-1" });
    expect(liveTimers()).toHaveLength(1);
    expect(liveTimers()[0]!.ms).toBe(5 * 60_000);
    await host.open({ sessionId: "s-2", modelId: "m" }, page.sender);
    expect(liveTimers()).toHaveLength(0);
    children[0]!.reply({ type: "ended", sessionId: "s-2" });
    liveTimers()[0]!.callback();
    expect(children[0]!.posted.at(-1)?.message).toEqual({ type: "shutdown" });
    expect(children[0]!.killed()).toBe(false);
    expect(host.running()).toBe(false);
    // A session asked for before the stopped process has gone gets a fresh one.
    await host.open({ sessionId: "s-3", modelId: "m" }, page.sender);
    expect(children).toHaveLength(2);
    children[0]!.exit(0);
    expect(page.crashes).toEqual([]);
    expect(host.running()).toBe(true);
  });

  it("resolves a prewarm with the process's answer, then idles", async () => {
    const { host, children, liveTimers } = setup();
    const prewarmed = host.prewarm("m");
    await flush();
    const request = children[0]!.posted[0]!.message;
    expect(request).toMatchObject({ type: "prewarm", model: PATHS, threads: 2 });
    children[0]!.reply({
      type: "prewarmed",
      requestId: (request as { requestId: number }).requestId,
      result: { ok: true },
    });
    expect(await prewarmed).toEqual({ ok: true });
    expect(liveTimers()).toHaveLength(1);
  });

  it("probes the runtime in a fresh process, for the smoke test", async () => {
    const { host, children } = setup();
    const probed = host.probe();
    const request = children[0]!.posted[0]!.message;
    expect(request).toMatchObject({ type: "probe" });
    children[0]!.reply({
      type: "prewarmed",
      requestId: (request as { requestId: number }).requestId,
      result: { ok: true },
    });
    expect(await probed).toEqual({ ok: true });
  });

  it("shuts the process down at once, waiting for it to go, without calling it a crash", async () => {
    const { host, children, liveTimers } = setup();
    expect(await host.shutdown()).toBeUndefined();
    const page = fakeSender();
    await host.open({ sessionId: "s-1", modelId: "m" }, page.sender);
    let done = false;
    const shutdown = host.shutdown().then(() => {
      done = true;
    });
    expect(children[0]!.posted.at(-1)!.message).toEqual({ type: "shutdown" });
    expect(host.running()).toBe(false);
    await flush();
    expect(done).toBe(false);
    children[0]!.exit(0);
    await shutdown;
    expect(page.crashes).toEqual([]);
    expect(children[0]!.killed()).toBe(false);
    expect(liveTimers()).toHaveLength(0);

    // One that doesn't exit by itself is killed after the grace period, and every shutdown,
    // overlapping ones too, waits until it has actually gone.
    await host.open({ sessionId: "s-2", modelId: "m" }, page.sender);
    let stuckDone = 0;
    const stuck = host.shutdown().then(() => stuckDone++);
    const again = host.shutdown().then(() => stuckDone++);
    liveTimers()[0]!.callback();
    expect(children[1]!.killed()).toBe(true);
    await flush();
    expect(stuckDone).toBe(0);
    children[1]!.exit(1);
    await Promise.all([stuck, again]);
    expect(stuckDone).toBe(2);
    expect(page.crashes).toEqual([]);
  });

  it("refuses an open or prewarm that was resolving its model when shutdown began", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    let release: (() => void) | undefined;
    const host = createSpeechHost({
      fork: () => {
        const child = fakeChild();
        children.push(child);
        return child.child;
      },
      channel: () => ({ port1: 1, port2: 2 }),
      resolveModel: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, paths: PATHS });
        }),
      setTimeout: () => 0,
      clearTimeout: () => {},
      log: () => {},
    });
    const page = fakeSender();
    const opening = host.open({ sessionId: "s", modelId: "m" }, page.sender);
    await host.shutdown();
    release?.();
    expect(await opening).toMatchObject({ ok: false, code: "stopped" });
    const prewarming = host.prewarm("m");
    await host.shutdown();
    release?.();
    expect(await prewarming).toMatchObject({ ok: false, code: "stopped" });
    expect(children).toHaveLength(0);
    expect(page.ports).toHaveLength(0);
  });

  it("reports a fork that throws as unavailable", async () => {
    const host = createSpeechHost({
      fork: () => {
        throw new Error("no such file");
      },
      channel: () => ({ port1: 1, port2: 2 }),
      resolveModel: async () => ({ ok: true, paths: PATHS }),
      setTimeout: () => 0,
      clearTimeout: () => {},
      log: () => {},
    });
    expect(await host.open({ sessionId: "s", modelId: "m" }, fakeSender().sender)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });
});

describe("speech model resolution", () => {
  // `resolve`, so a Windows run has the drive letter `resolveSpeechModel` will see.
  const data = resolvePath("/data");
  const etc = resolvePath("/etc");
  const dir = join(data, "speech", "models", "nemotron-en");
  const verified = {
    recognizer: {
      kind: "sherpa-onnx-online-transducer",
      encoder: "encoder.int8.onnx",
      decoder: "decoder.int8.onnx",
      joiner: "joiner.int8.onnx",
      tokens: "tokens.txt",
    },
    files: [
      { path: "encoder.int8.onnx", size: 100, sha256: "a" },
      { path: "decoder.int8.onnx", size: 10, sha256: "b" },
      { path: "joiner.int8.onnx", size: 5, sha256: "c" },
      { path: "tokens.txt", size: 1, sha256: "d" },
    ],
  };
  /** A data dir holding the model, with `links` as symlinks (path → target). */
  const fsWith = (
    manifest: unknown,
    sizes: Record<string, number> = {},
    links: Record<string, string> = {},
  ): ModelFs => {
    const files = new Map<string, number>(
      verified.files.map((file) => [join(dir, file.path), sizes[file.path] ?? file.size]),
    );
    if (manifest !== undefined) files.set(join(dir, "verified.json"), 0);
    files.set(join(etc, "tokens.txt"), 1);
    const directories = new Set([join(data, "speech", "models"), dir, etc]);
    const realpath = async (path: string) => {
      const target = links[path] ?? path;
      if (!files.has(target) && !directories.has(target)) throw new Error("ENOENT");
      return target;
    };
    return {
      realpath,
      readFile: async (path) => {
        if (path !== join(dir, "verified.json") || manifest === undefined) {
          throw new Error("ENOENT");
        }
        return JSON.stringify(manifest);
      },
      size: async (path) => {
        const size = files.get(path);
        if (size === undefined) throw new Error("ENOENT");
        return size;
      },
    };
  };

  it("resolves the recogniser's files from verified.json", async () => {
    expect(await resolveSpeechModel(data, "nemotron-en", fsWith(verified))).toEqual({
      ok: true,
      paths: {
        encoder: join(dir, "encoder.int8.onnx"),
        decoder: join(dir, "decoder.int8.onnx"),
        joiner: join(dir, "joiner.int8.onnx"),
        tokens: join(dir, "tokens.txt"),
        chunkMs: 560,
      },
    });
    const efficient = { ...verified, recognizer: { ...verified.recognizer, chunkMs: 1120 } };
    expect(await resolveSpeechModel(data, "nemotron-en", fsWith(efficient))).toMatchObject({
      paths: { chunkMs: 1120 },
    });
  });

  it("refuses anything short of a verified, complete model in its own directory", async () => {
    const cases: [unknown, unknown, Record<string, number>?, Record<string, string>?][] = [
      ["../etc", verified],
      ["nemotron-en", undefined],
      ["nemotron-en", { ...verified, recognizer: { ...verified.recognizer, kind: "whisper" } }],
      ["nemotron-en", { ...verified, recognizer: { ...verified.recognizer, joiner: undefined } }],
      [
        "nemotron-en",
        { ...verified, recognizer: { ...verified.recognizer, tokens: "../../../tokens.txt" } },
      ],
      [
        "nemotron-en",
        { ...verified, recognizer: { ...verified.recognizer, tokens: "/tokens.txt" } },
      ],
      ["nemotron-en", { ...verified, files: verified.files.slice(1) }],
      ["nemotron-en", verified, { "encoder.int8.onnx": 99 }],
      // A file that is a symlink out of the directory, even to one of the verified size.
      ["nemotron-en", verified, {}, { [join(dir, "tokens.txt")]: join(etc, "tokens.txt") }],
      // The model directory itself a symlink out of the models directory.
      ["nemotron-en", verified, {}, { [dir]: etc }],
    ];
    for (const [id, manifest, sizes, links] of cases) {
      expect(await resolveSpeechModel(data, id, fsWith(manifest, sizes, links))).toMatchObject({
        ok: false,
        code: "model-missing",
      });
    }
  });
});

const media = (status: string, asked: string[] = []) => ({
  getMediaAccessStatus: () => status,
  askForMediaAccess: async () => {
    asked.push("microphone");
    return status === "granted";
  },
});

describe("microphone access", () => {
  it("reports the OS status, and unknown where there is none", () => {
    expect(microphoneAccess(media("denied"), "darwin")).toBe("denied");
    expect(microphoneAccess(media("granted"), "win32")).toBe("granted");
    expect(microphoneAccess(media("granted"), "linux")).toBe("unknown");
    expect(microphoneAccess(media("something-new"), "darwin")).toBe("unknown");
  });

  it("asks only on macOS", async () => {
    const asked: string[] = [];
    expect(await requestMicrophoneAccess(media("granted", asked), "darwin")).toBe("granted");
    expect(await requestMicrophoneAccess(media("denied", asked), "win32")).toBe("denied");
    expect(asked).toEqual(["microphone"]);
  });

  it("opens each platform's microphone privacy settings", async () => {
    const opened: string[] = [];
    const openExternal = async (url: string) => {
      opened.push(url);
    };
    expect(await openMicrophoneSettings({ platform: "darwin", openExternal })).toBe(true);
    expect(await openMicrophoneSettings({ platform: "win32", openExternal })).toBe(true);
    expect(await openMicrophoneSettings({ platform: "linux", openExternal })).toBe(false);
    expect(opened).toEqual([PRIVACY_MICROPHONE_URL_MAC, PRIVACY_MICROPHONE_URL_WIN]);
  });
});

describe("update-only observed speech shutdown", () => {
  it("accepts a previously idle child only after graceful zero EXIT", async () => {
    const { host, children, liveTimers } = setup();
    await host.open({ sessionId: "idle-before-update", modelId: "m" }, fakeSender().sender);
    children[0]!.reply({ type: "ended", sessionId: "idle-before-update" });
    liveTimers()[0]!.callback();
    children[0]!.exit(0);
    await expect(host.shutdownForUpdate()).resolves.toBeUndefined();
  });
  it.each(["forced", "nonzero", "lingering"])(
    "refuses or waits for %s idle cleanup before update",
    async (kind) => {
      const { host, children, liveTimers } = setup();
      await host.open({ sessionId: "idle-before-update", modelId: "m" }, fakeSender().sender);
      children[0]!.reply({ type: "ended", sessionId: "idle-before-update" });
      liveTimers()[0]!.callback();
      let settled = false;
      const closing = host.shutdownForUpdate().finally(() => {
        settled = true;
      });
      const result =
        kind === "lingering"
          ? expect(closing).resolves.toBeUndefined()
          : expect(closing).rejects.toThrow("forced, crashed or nonzero");
      if (kind === "forced") {
        liveTimers()
          .find((timer) => timer.ms === 2_000)!
          .callback();
        expect(children[0]!.killed()).toBe(true);
      }
      await flush();
      expect(settled).toBe(false);
      expect(() => host.resumeAfterUpdate()).toThrow("still running");
      children[0]!.exit(kind === "nonzero" ? 7 : 0);
      await result;
    },
  );
  it("starts new voice work while an idle child exits, then update waits for both children", async () => {
    const { host, children, liveTimers } = setup();
    const page = fakeSender();
    await host.open({ sessionId: "old-idle", modelId: "m" }, page.sender);
    children[0]!.reply({ type: "ended", sessionId: "old-idle" });
    liveTimers()[0]!.callback();
    expect(await host.open({ sessionId: "new-voice", modelId: "m" }, page.sender)).toEqual({
      ok: true,
    });
    expect(children).toHaveLength(2);
    expect(children[0]!.killed()).toBe(false);
    let settled = false;
    const closing = host.shutdownForUpdate().then(() => {
      settled = true;
    });
    expect(children[1]!.posted.at(-1)?.message).toEqual({ type: "shutdown" });
    children[1]!.exit(0);
    await flush();
    expect(settled).toBe(false);
    expect(() => host.resumeAfterUpdate()).toThrow("still running");
    children[0]!.exit(0);
    await closing;
    expect(settled).toBe(true);
    expect(page.crashes).toEqual([]);
  });
  it("does not invalidate ordinary voice work resolving when the old child becomes idle", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const timers: (() => void)[] = [];
    let finish!: (value: SpeechModelResolution) => void;
    let first = true;
    const host = createSpeechHost({
      fork: () => {
        const c = fakeChild();
        children.push(c);
        return c.child;
      },
      channel: () => ({ port1: "main", port2: "page" }),
      resolveModel: () => {
        if (first) {
          first = false;
          return Promise.resolve({ ok: true, paths: PATHS });
        }
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimeout: () => {},
      log: () => {},
    });
    const page = fakeSender();
    await host.open({ sessionId: "old-idle", modelId: "m" }, page.sender);
    children[0]!.reply({ type: "ended", sessionId: "old-idle" });
    const opening = host.open({ sessionId: "new-voice", modelId: "m" }, page.sender);
    timers[0]!();
    finish({ ok: true, paths: PATHS });
    await expect(opening).resolves.toEqual({ ok: true });
    expect(children).toHaveLength(2);
    children[0]!.exit(0);
    const closing = host.shutdownForUpdate();
    children[1]!.exit(0);
    await closing;
  });
  it("accepts graceful owned child zero EXIT, blocks new sessions, and restores lazy startup", async () => {
    const { host, children } = setup();
    const page = fakeSender();
    await host.open({ sessionId: "update-session", modelId: "m" }, page.sender);
    const closing = host.shutdownForUpdate();
    expect(await host.open({ sessionId: "blocked", modelId: "m" }, page.sender)).toEqual({
      ok: false,
      code: "stopped",
      message: "voice input was turned off",
    });
    await expect(host.probe()).resolves.toMatchObject({ ok: false, code: "unavailable" });
    expect(() => host.resumeAfterUpdate()).toThrow("still running");
    children[0]!.exit(0);
    await closing;
    host.resumeAfterUpdate();
    expect(await host.open({ sessionId: "restored", modelId: "m" }, page.sender)).toEqual({
      ok: true,
    });
    expect(children).toHaveLength(2);
    children[1]!.exit(0);
  });
  it.each(["forced", "nonzero", "crashed", "previous-lingering"])(
    "refuses observed %s cleanup",
    async (kind) => {
      const { host, children, liveTimers } = setup();
      await host.open({ sessionId: "update-session", modelId: "m" }, fakeSender().sender);
      if (kind === "crashed") children[0]!.exit(1);
      if (kind === "previous-lingering") host.stop();
      let settled = false;
      const closing = host.shutdownForUpdate().finally(() => {
        settled = true;
      });
      const refused = expect(closing).rejects.toThrow("forced, crashed or nonzero");
      if (kind === "forced") liveTimers()[0]!.callback();
      if (kind !== "crashed") {
        await flush();
        expect(settled).toBe(false);
        expect(() => host.resumeAfterUpdate()).toThrow("still running");
        children[0]!.exit(kind === "nonzero" ? 7 : 0);
      }
      await refused;
      host.resumeAfterUpdate();
      expect(await host.open({ sessionId: "restored", modelId: "m" }, fakeSender().sender)).toEqual(
        { ok: true },
      );
      children[1]!.exit(0);
    },
  );
});

it("retains an observed forced zero exit as a refusal until cancellation recovery acknowledges quiescence", async () => {
  const { host, children } = setup();
  await host.open({ sessionId: "before-update", modelId: "m" }, fakeSender().sender);
  host.stop();
  children[0]!.exit(0);
  await expect(host.shutdownForUpdate()).rejects.toThrow("forced, crashed or nonzero");
  host.resumeAfterUpdate();
  await expect(host.shutdownForUpdate()).resolves.toBeUndefined();
});
