// A reply's files: read once before the decision hook is asked, so the hook decides on the bytes
// that go out; kept by the reply's id for the host to read back; refused when the hook refuses,
// and never read from a file that may hold credentials.
import { describe, expect, it } from "@effect/vitest";
import { applySettingsPatch, type SinkBatch, type SinkEvent } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationAppToolsLive } from "../app-tools/conversation-tools.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { ServerConfig } from "../config.ts";
import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { FakeAgentControl, makeFakeAgentAdapter } from "../runtime/fake-agent.ts";
import { CheckoutService, TurnHooks } from "../runtime/hooks.ts";
import { TEST_CONFIG } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { UsageLimitReadings } from "../usage/limit-readings.ts";
import { Conversations } from "./conversations.ts";
import { DecisionHook, type DecisionQuestion } from "./decision-hook.ts";
import { EventSink } from "./event-sink.ts";
import { readKeptReplyFile } from "./reply-files.ts";

const receiver = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ close: () => void; url: string; held: Array<SinkEvent> }>((resolve) => {
        const held: Array<SinkEvent> = [];
        const server = createServer((request, response) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const batch = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SinkBatch;
            for (const event of batch.events) if (event.seq === held.length + 1) held.push(event);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ ack: held.length }));
          });
        });
        server.listen(0, "127.0.0.1", () =>
          resolve({
            held,
            url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
            close: () => {
              server.closeAllConnections();
              server.close();
            },
          }),
        );
      }),
  ),
  ({ close }) => Effect.sync(close),
);

/** A decision hook that keeps what it is asked and answers what `answer` says. */
const hookOf = (asked: Array<DecisionQuestion>, answer: { decision: "allow" | "refuse" }) =>
  Layer.succeed(DecisionHook)({
    enabled: Effect.succeed(true),
    decide: (question) =>
      Effect.sync(() => {
        asked.push(question);
        return {
          id: `d${asked.length}`,
          decision: answer.decision,
          ...(answer.decision === "refuse" ? { reason: "Files stay in the workspace." } : {}),
        };
      }),
  });

const layerOf = (
  sinkUrl: string,
  dataDir: string,
  asked: Array<DecisionQuestion>,
  answer: { decision: "allow" | "refuse" },
) =>
  ConversationAppToolsLive.pipe(
    Layer.provideMerge(Conversations.layer),
    Layer.provideMerge(AppToolRegistry.layer),
    Layer.provideMerge(hookOf(asked, answer)),
    Layer.provideMerge(ThreadRuntimes.layerOnLocalHost),
    Layer.provideMerge(UsageLimitReadings.layer),
    Layer.provideMerge(EventSink.layer),
    Layer.provideMerge(EventHub.layer),
    Layer.provideMerge(ThreadStore.layerSqlite(":memory:")),
    Layer.provideMerge(makeFakeAgentAdapter({ reply: "echo" })),
    Layer.provideMerge(TurnHooks.layerNoop),
    Layer.provideMerge(CheckoutService.layerNoGit),
    Layer.provideMerge(
      ServerConfig.layer({
        ...TEST_CONFIG,
        dataDir,
        eventSink: { url: sinkUrl, token: "sink-token" },
      }),
    ),
    Layer.orDie,
  );

const eventually = <A, E, R>(label: string, check: Effect.Effect<A | undefined | false, E, R>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 1000; i++) {
      const value = yield* check;
      if (value !== undefined && value !== false) return value;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const C = { id: "chat:C2/9", label: "Chat · #design" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

const deskWith = (answer: { decision: "allow" | "refuse" }) =>
  Effect.gen(function* () {
    const sink = yield* receiver;
    const root = mkdtempSync(join(tmpdir(), "gram-reply-files-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(root, { recursive: true, force: true })),
    );
    const work = join(root, "work");
    const dataDir = join(root, "data");
    rmSync(work, { recursive: true, force: true });
    yield* Effect.promise(() => import("node:fs/promises").then((fs) => fs.mkdir(work)));
    writeFileSync(join(work, "chart.png"), PNG);
    writeFileSync(join(work, "notes.md"), "# Notes\n");
    writeFileSync(join(work, ".env"), "TOKEN=not-a-real-one\n");
    writeFileSync(join(root, "elsewhere.txt"), "not the thread's\n");
    symlinkSync(join(root, "elsewhere.txt"), join(work, "link.txt"));
    const asked: Array<DecisionQuestion> = [];
    return { sink, root, work, dataDir, asked, layer: layerOf(sink.url, dataDir, asked, answer) };
  });

const openDesk = (work: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    yield* store.updateSettings(
      (settings) => applySettingsPatch(settings, { experimental: { embedding: true } }),
      [["experimental", "embedding"]],
    );
    const runtimes = yield* ThreadRuntimes;
    const conversations = yield* Conversations;
    const fake = yield* FakeAgentControl;
    const desk = yield* runtimes.create({
      projectRoot: work,
      checkout: { kind: "main", path: work },
    });
    yield* conversations.arrive(desk.id, C);
    yield* runtimes.send(desk.id, { text: "Send me the chart.", conversation: C });
    const session = yield* fake.latest(desk.id);
    yield* eventually(
      "the message",
      Effect.sync(() => session.sent.length === 1),
    );
    // As a session calls it: through the gate and the decision hook's guard.
    const registry = yield* AppToolRegistry;
    const reply = (input: unknown) =>
      registry
        .forSession(desk.id)
        .find((tool) => tool.descriptor.name === "reply")!
        .run(input);
    return { desk, reply };
  });

describe("a reply's files", () => {
  it.live("are decided on, sent as named by their hashes and kept for the host to read back", () =>
    Effect.gen(function* () {
      const { sink, root, work, dataDir, asked, layer } = yield* deskWith({ decision: "allow" });
      yield* Effect.gen(function* () {
        const { desk, reply } = yield* openDesk(work);
        const sent = (yield* reply({
          conversation: C.id,
          text: "Here it is.",
          files: ["chart.png", "notes.md"],
          key: "k1",
        })) as { sent: boolean; id: string };
        const shown = [
          { name: "chart.png", mediaType: "image/png", size: PNG.length, sha256: sha(PNG) },
          { name: "notes.md", mediaType: "text/markdown", size: 8, sha256: sha("# Notes\n") },
        ];
        // The hook is asked first, with what will go out and never the bytes.
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({
          action: "conversation.reply",
          detail: { conversation: C.id, text: "Here it is.", files: shown },
        });
        const [posted] = yield* eventually(
          "the reply at the host",
          Effect.sync(() => {
            const found = sink.held.filter((event) => event.type === "conversation.reply");
            return found.length === 1 && found;
          }),
        );
        expect(posted).toMatchObject({
          threadId: desk.id,
          data: { id: sent.id, conversation: C.id, text: "Here it is.", files: shown },
        });
        const first = yield* readKeptReplyFile(dataDir, sent.id, 0);
        expect(first?.bytes.equals(PNG)).toBe(true);
        expect(first?.sha256).toBe(sha(PNG));
        expect(yield* readKeptReplyFile(dataDir, sent.id, 2)).toBeUndefined();
        expect(yield* readKeptReplyFile(dataDir, "../escape", 0)).toBeUndefined();

        // A text reply is asked about too: no reply reaches a host's people unasked.
        yield* reply({ conversation: C.id, text: "Anything else?", key: "k2" });
        expect(asked[1]).toMatchObject({
          action: "conversation.reply",
          detail: { conversation: C.id, text: "Anything else?" },
        });
        expect(asked[1]!.detail).not.toHaveProperty("files");

        // A file that may hold credentials is never read, so nothing is asked or sent.
        const secret = yield* reply({
          conversation: C.id,
          text: "Config",
          files: [".env"],
          key: "k3",
        }).pipe(Effect.flip);
        expect(String(secret)).toContain("credentials");
        expect(asked).toHaveLength(2);

        // Nothing past the thread's folder is read: not by an absolute path, `..` or a link.
        for (const path of [join(root, "elsewhere.txt"), "../elsewhere.txt", "link.txt"]) {
          const outside = yield* reply({
            conversation: C.id,
            text: "Look",
            files: [path],
            key: "k4",
          }).pipe(Effect.flip);
          expect(String(outside)).toContain("isn't in the thread's folder");
        }
        expect(asked).toHaveLength(2);

        // A used key names one reply for ever: other bytes under it are refused, and the first
        // reply's files read back as they were.
        writeFileSync(join(work, "chart.png"), Buffer.from("changed"));
        const reused = yield* reply({
          conversation: C.id,
          text: "Here it is.",
          files: ["chart.png", "notes.md"],
          key: "k1",
        }).pipe(Effect.flip);
        expect(String(reused)).toContain("already named another reply");
        expect((yield* readKeptReplyFile(dataDir, sent.id, 0))?.bytes.equals(PNG)).toBe(true);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.live("go nowhere when the hook refuses the reply", () =>
    Effect.gen(function* () {
      const { sink, work, asked, layer } = yield* deskWith({ decision: "refuse" });
      yield* Effect.gen(function* () {
        const { reply } = yield* openDesk(work);
        const refused = yield* reply({
          conversation: C.id,
          text: "Here it is.",
          files: ["chart.png"],
          key: "k1",
        }).pipe(Effect.flip);
        expect(String(refused)).toContain("Files stay in the workspace.");
        expect(asked).toHaveLength(1);
        yield* Effect.sleep("50 millis");
        expect(sink.held.filter((event) => event.type === "conversation.reply")).toEqual([]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );
});
