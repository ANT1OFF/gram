import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import {
  SpeechModelId,
  SpeechModelManifest,
  SpeechRefused,
  SPEECH_MODEL_FOR_STOP,
  speechModelBytes,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, beforeEach, vi } from "vitest";

import { downloadModel, fileUrl, modelDir, stagingDir, type SpeechFetch } from "./download.ts";
import { electronFetch, type ElectronNet } from "./net.ts";
import { DEFAULT_HF_BASE, SPEECH_MODELS } from "./manifest.ts";
import { openSpeechModelStore, speechModelBase } from "./models.ts";
import { makeSpeechStore } from "./store.ts";

const BASE = "https://huggingface.co";
const REVISION = "52056fdc070914a48dcd68b31b44d6a6f5b85902";

const bytes = (n: number, seed: number) =>
  Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251));
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

const CONTENT: Record<string, Buffer> = {
  "encoder.int8.onnx": bytes(300_000, 1),
  "decoder.int8.onnx": bytes(20_000, 2),
  "joiner.int8.onnx": bytes(5_000, 3),
  "tokens.txt": Buffer.from("<blk> 0\n▁the 1\n"),
};

const MANIFEST: SpeechModelManifest = {
  ...SPEECH_MODELS[0]!,
  id: SpeechModelId.make("test-model"),
  repo: "csukuangfj2/test-model",
  revision: REVISION,
  files: Object.entries(CONTENT).map(([path, data]) => ({
    path,
    size: data.length,
    sha256: sha(data),
  })),
};

interface Request {
  readonly url: string;
  readonly range: string | undefined;
}

interface FakeOptions {
  /** Serve each file's bytes as this instead, at the same length. */
  readonly corrupt?: string;
  /** End the body after this many bytes of the first request for the file. */
  readonly cutAfter?: { readonly path: string; readonly bytes: number };
  /** Answer ranged requests with the whole file and a 200. */
  readonly ignoreRange?: boolean;
  readonly status?: number;
  /** Answer requests to huggingface.co with a 302 to this base, which then serves the file. */
  readonly redirectTo?: string;
  /** Redirect back to huggingface.co forever. */
  readonly loop?: boolean;
  readonly commit?: string;
  /** Holds the body of this file until `release` is called. */
  readonly hold?: string;
}

/** A Hugging Face that serves `CONTENT` at `REVISION`, with ranges, as configured. */
const fakeHub = (options: FakeOptions = {}) => {
  const requests: Request[] = [];
  let cut = false;
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const fetch: SpeechFetch = async (url, init) => {
    const range = init.headers["Range"];
    requests.push({ url, range });
    if (options.status !== undefined) return new Response("no", { status: options.status });
    if (options.loop === true)
      return new Response(null, { status: 302, headers: { location: url } });
    if (options.redirectTo !== undefined && new URL(url).host === "huggingface.co")
      return new Response(null, {
        status: 302,
        headers: { location: url.replace(BASE, options.redirectTo), "x-repo-commit": REVISION },
      });
    const path = decodeURIComponent(url.split(`/resolve/${REVISION}/`)[1] ?? "");
    let data = CONTENT[path];
    if (data === undefined) return new Response("missing", { status: 404 });
    if (options.corrupt === path) data = Buffer.alloc(data.length, 7);
    const start =
      range !== undefined && options.ignoreRange !== true
        ? Number(/bytes=(\d+)-/.exec(range)![1])
        : 0;
    let body = data.subarray(start);
    if (options.cutAfter?.path === path && !cut) {
      cut = true;
      body = body.subarray(0, options.cutAfter.bytes);
    }
    const chunks = [body.subarray(0, body.length >> 1), body.subarray(body.length >> 1)];
    const hold = options.hold === path;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) return controller.close();
        controller.enqueue(new Uint8Array(chunk));
        // Like a real fetch, aborting the request errors its body.
        if (hold && chunks.length === 1)
          await Promise.race([
            held,
            new Promise((_, reject) =>
              init.signal.addEventListener("abort", () => reject(init.signal.reason), {
                once: true,
              }),
            ),
          ]);
      },
    });
    const response = new Response(stream, {
      status: start > 0 ? 206 : 200,
      headers: {
        "x-repo-commit": options.commit ?? REVISION,
        ...(start > 0
          ? { "content-range": `bytes ${start}-${data.length - 1}/${data.length}` }
          : {}),
      },
    });
    init.signal.throwIfAborted();
    return response;
  };
  return { fetch, requests, release };
};

const proxied: SpeechFetch = async () => {
  throw new TypeError("fetch failed", { cause: new Error("net::ERR_TUNNEL_CONNECTION_FAILED") });
};

let dataDir: string;
let root: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "gram-speech-"));
  root = join(dataDir, "speech");
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const download = (
  fetch: SpeechFetch,
  extra: { freeBytes?: number; signal?: AbortSignal; open?: typeof open } = {},
) =>
  downloadModel({
    ...(extra.open === undefined ? {} : { open: extra.open }),
    manifest: MANIFEST,
    root,
    base: BASE,
    fetch,
    signal: extra.signal ?? new AbortController().signal,
    freeBytes: async () => extra.freeBytes ?? 1e12,
    now: () => 42,
    onProgress: () => {},
    onVerifying: () => {},
  });

describe("speech model download", () => {
  it("fetches every pinned file at the revision and installs it whole", async () => {
    const hub = fakeHub();
    const outcome = await download(hub.fetch);
    expect(outcome.ok).toBe(true);
    expect(hub.requests.map((r) => r.url)).toEqual(
      MANIFEST.files.map(
        (file) => `${BASE}/csukuangfj2/test-model/resolve/${REVISION}/${file.path}`,
      ),
    );
    const dir = modelDir(root, MANIFEST.id);
    for (const [path, data] of Object.entries(CONTENT))
      expect(sha(await readFile(join(dir, path)))).toBe(sha(data));
    const verified = JSON.parse(await readFile(join(dir, "verified.json"), "utf8"));
    expect(verified).toMatchObject({ id: "test-model", revision: REVISION, verifiedAt: 42 });
    expect(await readFile(join(dir, "NOTICE"), "utf8")).toContain("NVIDIA Open Model License");
    expect(existsSync(stagingDir(root, MANIFEST.id))).toBe(false);
  });

  it("resumes a truncated file with a Range request, hashing the bytes already on disk", async () => {
    const hub = fakeHub({ cutAfter: { path: "encoder.int8.onnx", bytes: 120_000 } });
    const first = await download(hub.fetch);
    expect(first).toMatchObject({ ok: false, reason: "network", resumableBytes: 120_000 });
    const second = await download(hub.fetch);
    expect(second.ok).toBe(true);
    expect(hub.requests[1]).toMatchObject({ range: "bytes=120000-" });
    const encoder = await readFile(join(modelDir(root, MANIFEST.id), "encoder.int8.onnx"));
    expect(sha(encoder)).toBe(MANIFEST.files[0]!.sha256);
  });

  it("starts a file over when the host answers a Range request with a 200", async () => {
    const cutting = fakeHub({ cutAfter: { path: "encoder.int8.onnx", bytes: 50_000 } });
    expect((await download(cutting.fetch)).ok).toBe(false);
    const ignoring = fakeHub({ ignoreRange: true });
    expect((await download(ignoring.fetch)).ok).toBe(true);
    expect(ignoring.requests[0]!.range).toBe("bytes=50000-");
    const encoder = await readFile(join(modelDir(root, MANIFEST.id), "encoder.int8.onnx"));
    expect(encoder.length).toBe(CONTENT["encoder.int8.onnx"]!.length);
    expect(sha(encoder)).toBe(MANIFEST.files[0]!.sha256);
  });

  it("keeps nothing of a file whose sha256 doesn't match, and installs nothing", async () => {
    const outcome = await download(fakeHub({ corrupt: "decoder.int8.onnx" }).fetch);
    expect(outcome).toMatchObject({ ok: false, reason: "verification" });
    expect(outcome.ok === false && outcome.message).toContain("decoder.int8.onnx");
    expect(existsSync(join(stagingDir(root, MANIFEST.id), "decoder.int8.onnx.partial"))).toBe(
      false,
    );
    expect(existsSync(modelDir(root, MANIFEST.id))).toBe(false);
  });

  it("re-hashes a staged file before the move, so a file damaged on disk isn't installed", async () => {
    const staging = stagingDir(root, MANIFEST.id);
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, ".revision"), REVISION);
    await writeFile(join(staging, "tokens.txt"), Buffer.alloc(CONTENT["tokens.txt"]!.length, 1));
    const outcome = await download(fakeHub().fetch);
    expect(outcome).toMatchObject({ ok: false, reason: "verification" });
    expect(existsSync(modelDir(root, MANIFEST.id))).toBe(false);
    expect((await download(fakeHub().fetch)).ok).toBe(true);
  });

  it("refuses to start without room for the model, before fetching anything", async () => {
    const hub = fakeHub();
    const outcome = await download(hub.fetch, { freeBytes: 1_000 });
    expect(outcome).toMatchObject({ ok: false, reason: "disk-space" });
    expect(outcome.ok === false && outcome.message).toMatch(/GB free/);
    expect(hub.requests).toEqual([]);
  });

  it("stops with what it wrote kept when the disk fills mid-download, and resumes from it", async () => {
    let written = 0;
    const filling = (async (path, flags) => {
      const handle = await open(path, flags);
      const write = handle.write.bind(handle) as (chunk: Uint8Array) => Promise<unknown>;
      return Object.assign(handle, {
        write: async (chunk: Uint8Array) => {
          if (written > 0)
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
          written += chunk.byteLength;
          return write(chunk);
        },
      });
    }) as typeof open;
    const outcome = await download(fakeHub().fetch, { open: filling });
    expect(outcome).toMatchObject({ ok: false, reason: "disk-space", resumableBytes: 150_000 });
    const hub = fakeHub();
    expect((await download(hub.fetch)).ok).toBe(true);
    expect(hub.requests[0]!.range).toBe("bytes=150000-");
  });

  it("names the hosts to allow when a proxy stops it, and npm registry's needs when a mirror refuses", async () => {
    const outcome = await download(proxied);
    expect(outcome).toMatchObject({ ok: false, reason: "proxy" });
    expect(outcome.ok === false && outcome.message).toContain("huggingface.co and *.hf.co");
    expect(await download(fakeHub({ status: 407 }).fetch)).toMatchObject({ reason: "proxy" });

    const registry = await downloadModel({
      manifest: MANIFEST,
      root,
      base: "https://exampleprod.registry.io/artifactory/api/huggingfaceml/huggingfaceml-remote",
      fetch: fakeHub({ status: 401 }).fetch,
      signal: new AbortController().signal,
      freeBytes: async () => 1e12,
      onProgress: () => {},
      onVerifying: () => {},
    });
    expect(registry).toMatchObject({ ok: false, reason: "http" });
    expect(registry.ok === false && registry.message).toMatch(/npm registry.*token.*allowlist/);
  });

  it("refuses a redirect off the model hosts before asking it, and a revision not pinned", async () => {
    const evil = fakeHub({ redirectTo: "https://evil.example/x" });
    expect(await download(evil.fetch)).toMatchObject({ reason: "http" });
    // The off-host hop was never requested.
    expect(evil.requests.map((r) => new URL(r.url).host)).toEqual(["huggingface.co"]);
    expect(await download(fakeHub({ loop: true }).fetch)).toMatchObject({
      reason: "http",
      message: "The model host redirected too many times.",
    });
    // Hugging Face's CDN is a model host.
    expect(
      (await download(fakeHub({ redirectTo: "https://cas-bridge.xethub.hf.co/x" }).fetch)).ok,
    ).toBe(true);
    await rm(root, { recursive: true });
    expect(await download(fakeHub({ commit: "0".repeat(40) }).fetch)).toMatchObject({
      reason: "verification",
    });
  });

  it("leaves the files staged when cancelled while verifying, and installs them next time", async () => {
    const controller = new AbortController();
    const outcome = await downloadModel({
      manifest: MANIFEST,
      root,
      base: BASE,
      fetch: fakeHub().fetch,
      signal: controller.signal,
      freeBytes: async () => 1e12,
      onProgress: () => {},
      onVerifying: () => controller.abort(),
    });
    expect(outcome).toMatchObject({ ok: false, reason: undefined });
    expect(outcome.ok === false && outcome.resumableBytes).toBe(speechModelBytes(MANIFEST));
    expect(existsSync(modelDir(root, MANIFEST.id))).toBe(false);
    const hub = fakeHub();
    expect((await download(hub.fetch)).ok).toBe(true);
    expect(hub.requests).toEqual([]);
  });

  it("puts back the installed model when an update's move fails, or the app quit mid-move", async () => {
    expect((await download(fakeHub().fetch)).ok).toBe(true);
    const installed = modelDir(root, MANIFEST.id);
    const before = await readFile(join(installed, "verified.json"), "utf8");
    const failing = await downloadModel({
      manifest: MANIFEST,
      root,
      base: BASE,
      fetch: fakeHub().fetch,
      signal: new AbortController().signal,
      freeBytes: async () => 1e12,
      onProgress: () => {},
      onVerifying: () => {},
      now: () => 7,
      rename: async (from, to) => {
        if (from === stagingDir(root, MANIFEST.id) && to === installed)
          throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
        await rename(from, to);
      },
    });
    expect(failing).toMatchObject({ ok: false, reason: "filesystem" });
    expect(await readFile(join(installed, "verified.json"), "utf8")).toBe(before);

    // Quit between the two renames: the old copy sits aside, and the store's start puts it back.
    await rename(installed, join(root, "staging", `${MANIFEST.id}.replaced`));
    const status = await Effect.runPromise(
      Effect.scoped(store(fakeHub().fetch).pipe(Effect.flatMap((s) => s.status(MANIFEST.id)))),
    );
    expect(status.installed).toBeDefined();
    expect(await readFile(join(installed, "verified.json"), "utf8")).toBe(before);
  });

  it("builds the Hub's resolve path from any base", () => {
    expect(fileUrl(`${DEFAULT_HF_BASE}/`, MANIFEST, MANIFEST.files[0]!)).toBe(
      `https://huggingface.co/csukuangfj2/test-model/resolve/${REVISION}/encoder.int8.onnx`,
    );
    expect(fileUrl(`${DEFAULT_HF_BASE}///`, MANIFEST, MANIFEST.files[0]!)).toBe(
      `https://huggingface.co/csukuangfj2/test-model/resolve/${REVISION}/encoder.int8.onnx`,
    );
    // Linear in the run of slashes, which a backtracking `/\/+$/` isn't.
    const slashes = `https://m.example${"/".repeat(100_000)}x`;
    expect(fileUrl(slashes, MANIFEST, MANIFEST.files[0]!)).toContain(`${slashes}/csukuangfj2`);
  });
});

const store = (fetch: SpeechFetch) =>
  makeSpeechStore({
    root: join(dataDir, "speech"),
    dataDir,
    base: BASE,
    fetch,
    freeBytes: async () => 5e11,
    lookup: (id) => (id === MANIFEST.id ? MANIFEST : undefined),
    models: [MANIFEST],
  });

describe("speech model store", () => {
  it.effect("installs, reports progress through watch, and removes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* store(fakeHub().fetch);
        const before = yield* s.status(MANIFEST.id);
        expect(before).toMatchObject({ install: { state: "idle" }, freeBytes: 5e11 });
        expect(before.installed).toBeUndefined();
        const started = yield* s.install(MANIFEST.id);
        expect(started.install.state).toBe("downloading");
        const seen = yield* s.watch(MANIFEST.id).pipe(
          Stream.takeUntil((status) => status.installed !== undefined),
          Stream.runCollect,
        );
        const done = seen.at(-1)!;
        expect(done.installed).toMatchObject({
          id: "test-model",
          sizeBytes: speechModelBytes(MANIFEST),
        });
        const removed = yield* s.remove(MANIFEST.id);
        expect(removed.installed).toBeUndefined();
        expect(existsSync(modelDir(root, MANIFEST.id))).toBe(false);
      }),
    ),
  );

  it.effect("cancels a download, keeping its bytes to resume, and refuses a second install", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = fakeHub({ hold: "encoder.int8.onnx" });
        const s = yield* store(hub.fetch);
        yield* s.install(MANIFEST.id);
        const busy = yield* s.install(MANIFEST.id).pipe(Effect.flip);
        expect(busy).toBeInstanceOf(SpeechRefused);
        expect(busy).toMatchObject({ reason: "busy" });
        expect(yield* s.remove(MANIFEST.id).pipe(Effect.flip)).toMatchObject({ reason: "busy" });
        // Wait for the first half of the encoder to land.
        yield* s.watch(MANIFEST.id).pipe(
          Stream.takeUntil(
            (status) => status.install.state === "downloading" && status.install.receivedBytes > 0,
          ),
          Stream.runDrain,
        );
        const cancelled = yield* s.cancel(MANIFEST.id);
        hub.release();
        expect(cancelled.install).toEqual({ state: "idle", resumableBytes: 150_000 });
        expect(cancelled.installed).toBeUndefined();
      }),
    ),
  );

  it.effect("deletes the other variant of the model once a new one is in", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const other = { ...MANIFEST, id: SpeechModelId.make("test-model-other") };
        const unrelated = {
          ...MANIFEST,
          id: SpeechModelId.make("test-unrelated"),
          source: { ...MANIFEST.source, repo: "nvidia/another-model" },
        };
        const models = [MANIFEST, other, unrelated];
        const s = yield* makeSpeechStore({
          root,
          dataDir,
          base: BASE,
          fetch: fakeHub().fetch,
          freeBytes: async () => 5e11,
          lookup: (id) => models.find((model) => model.id === id),
          models,
        });
        const installed = (id: string) =>
          s.status(id).pipe(Effect.map((status) => status.installed !== undefined));
        const installAndWait = (id: string) =>
          s.install(id).pipe(
            Effect.andThen(
              s.watch(id).pipe(
                Stream.takeUntil((status) => status.installed !== undefined),
                Stream.runDrain,
              ),
            ),
          );
        yield* installAndWait(MANIFEST.id);
        // One variant downloads at a time, so the one that finishes last is the one wanted.
        const held = fakeHub({ hold: "encoder.int8.onnx" });
        const busy = yield* makeSpeechStore({
          root: join(dataDir, "other-root"),
          dataDir,
          base: BASE,
          fetch: held.fetch,
          freeBytes: async () => 5e11,
          lookup: (id) => models.find((model) => model.id === id),
          models,
        });
        yield* busy.install(MANIFEST.id);
        expect(yield* busy.install(other.id).pipe(Effect.flip)).toMatchObject({
          reason: "busy",
          message: "Another variant of the speech model is downloading. Pause it first.",
        });
        yield* busy.install(unrelated.id);
        yield* busy.cancel(MANIFEST.id);
        yield* busy.cancel(unrelated.id);
        held.release();
        yield* installAndWait(unrelated.id);
        yield* installAndWait(other.id);
        // The install's own fiber removes it just after it reports installed.
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(existsSync(modelDir(root, MANIFEST.id))).toBe(false)),
        );
        expect(yield* installed(MANIFEST.id)).toBe(false);
        expect(yield* installed(other.id)).toBe(true);
        expect(yield* installed(unrelated.id)).toBe(true);
      }),
    ),
  );

  it.effect("refuses an install while a removal is deleting the model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* store(fakeHub().fetch);
        const [removed, install] = yield* Effect.all(
          [s.remove(MANIFEST.id), s.install(MANIFEST.id).pipe(Effect.flip)],
          { concurrency: "unbounded" },
        );
        expect(removed.installed).toBeUndefined();
        expect(install).toMatchObject({ reason: "busy", message: "The model is being removed." });
      }),
    ),
  );

  it.effect("refuses a model this build doesn't pin, on every RPC", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const s = yield* store(fakeHub().fetch);
        for (const run of [s.status, s.install, s.cancel, s.remove]) {
          const error = yield* run("other-model").pipe(Effect.flip);
          expect(error).toMatchObject({ reason: "unknown-model" });
        }
      }),
    ),
  );
});

describe("pinned speech models", () => {
  it("decode, pin a commit, and list every file the speech process loads", () => {
    expect(SPEECH_MODELS.map((model) => model.id)).toEqual([
      SPEECH_MODEL_FOR_STOP.balanced,
      SPEECH_MODEL_FOR_STOP.responsive,
      SPEECH_MODEL_FOR_STOP.efficient,
    ]);
    for (const model of SPEECH_MODELS) {
      expect(Schema.decodeUnknownSync(SpeechModelManifest)(model)).toEqual(model);
      const paths = model.files.map((file) => file.path);
      const { kind, chunkMs, ...roles } = model.recognizer;
      expect(model.repo).toContain(`-${chunkMs}ms-`);
      expect(kind).toBe("sherpa-onnx-online-transducer");
      for (const path of Object.values(roles)) expect(paths, path).toContain(path);
      expect(new Set(paths).size).toBe(paths.length);
    }
  });
});

/** A `net` whose one request answers 200 and hands its data listener to the test. */
const fakeNet = () => {
  const calls = { aborted: 0, paused: 0, resumed: 0 };
  let data: ((chunk: Buffer) => void) | undefined;
  let end: (() => void) | undefined;
  const net: ElectronNet = {
    request: () => {
      const listeners: Record<string, (...args: never[]) => void> = {};
      return {
        setHeader: () => {},
        on: (event: string, listener: (...args: never[]) => void) => {
          listeners[event] = listener;
        },
        abort: () => {
          calls.aborted += 1;
        },
        end: () =>
          queueMicrotask(() =>
            (listeners["response"] as (response: unknown) => void)({
              statusCode: 200,
              headers: { "content-length": "3" },
              on: (event: string, listener: never) => {
                if (event === "data") data = listener;
                if (event === "end") end = listener;
              },
              pause: () => {
                calls.paused += 1;
              },
              resume: () => {
                calls.resumed += 1;
              },
            }),
          ),
      } as never;
    },
  };
  return { net, calls, data: (chunk: Buffer) => data?.(chunk), end: () => end?.() };
};

describe("Electron's net as a SpeechFetch", () => {
  it("holds the transfer while the reader is behind, and stops it when the reader gives up", async () => {
    const fake = fakeNet();
    const response = await electronFetch(fake.net)("https://huggingface.co/x", {
      headers: {},
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(200);
    for (let i = 0; i < 20; i++) fake.data(Buffer.from([i]));
    expect(fake.calls.paused).toBeGreaterThan(0);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([0]));
    expect(fake.calls.resumed).toBeGreaterThan(0);
    await reader.cancel();
    expect(fake.calls.aborted).toBe(1);
    // Data still in flight after the cancel is dropped, not pushed into a closed stream.
    expect(() => fake.data(Buffer.from([99]))).not.toThrow();
    expect(() => fake.end()).not.toThrow();
  });

  it("answers a redirect with its location instead of following it", async () => {
    const net: ElectronNet = {
      request: () => {
        const listeners: Record<string, (...args: never[]) => void> = {};
        return {
          setHeader: () => {},
          on: (event: string, listener: (...args: never[]) => void) => {
            listeners[event] = listener;
          },
          abort: () => {},
          end: () =>
            queueMicrotask(() =>
              (listeners["redirect"] as (...args: unknown[]) => void)(
                302,
                "GET",
                "https://cas-bridge.xethub.hf.co/y",
                { "x-repo-commit": [REVISION] },
              ),
            ),
        } as never;
      },
    };
    const response = await electronFetch(net)("https://huggingface.co/x", {
      headers: {},
      signal: new AbortController().signal,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://cas-bridge.xethub.hf.co/y");
    expect(response.headers.get("x-repo-commit")).toBe(REVISION);
  });
});

describe("the store as main serves it", () => {
  const lines: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
  const log = {
    info: (fields: Readonly<Record<string, unknown>>, message: string) =>
      void lines.push({ level: "info", fields: { ...fields }, message }),
    warn: (fields: Readonly<Record<string, unknown>>, message: string) =>
      void lines.push({ level: "warn", fields: { ...fields }, message }),
    error: (fields: Readonly<Record<string, unknown>>, message: string) =>
      void lines.push({ level: "error", fields: { ...fields }, message }),
  };
  const openStore = () => openSpeechModelStore({ dataDir, base: BASE, fetch: proxied, log });
  const pinned = SPEECH_MODELS[0]!.id;

  it("takes a model mirror only over HTTPS and without credentials", () => {
    const base =
      "https://exampleprod.registry.io/artifactory/api/huggingfaceml/huggingfaceml-remote";
    expect(speechModelBase({ GRAM_HF_BASE: ` ${base} ` })).toBe(base);
    for (const bad of [
      "http://mirror.example",
      "https://user:pw@mirror.example",
      "https://m.example/?t=1",
      undefined,
    ])
      expect(speechModelBase({ GRAM_HF_BASE: bad }), bad).toBe(DEFAULT_HF_BASE);
  });

  it("answers with the status, or the refusal as data that crosses IPC", async () => {
    const served = await openStore();
    const status = await served.status(pinned);
    expect(status).toMatchObject({ ok: true, status: { install: { state: "idle" } } });
    for (const model of ["no-such-model", 42, undefined]) {
      const refused = await served.status(model);
      expect(refused, String(model)).toMatchObject({
        ok: false,
        error: { _tag: "SpeechRefused", reason: "unknown-model" },
      });
      // Plain data: a class instance would reach the page as a bare object anyway.
      expect(Object.getPrototypeOf(refused.ok ? null : refused.error)).toBe(Object.prototype);
    }
    await served.close();
  });

  it("watches until aborted, and logs the store's lines to the shell's log", async () => {
    lines.length = 0;
    const served = await openStore();
    const controller = new AbortController();
    const seen: string[] = [];
    const failed = Promise.withResolvers<void>();
    served.watch(
      pinned,
      (answer) => {
        if (!answer.ok) return;
        seen.push(answer.status.install.state);
        if (answer.status.install.state === "failed") failed.resolve();
      },
      controller.signal,
    );
    // The proxy refuses, or the temp disk is too small: either way the download fails.
    await served.install(pinned);
    await failed.promise;
    controller.abort();
    expect(seen.at(-1)).toBe("failed");
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "speech model download failed",
        fields: expect.objectContaining({ source: "speech-models", model: pinned }),
      }),
    );
    await served.close();
  });
});
