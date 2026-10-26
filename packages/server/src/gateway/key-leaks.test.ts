import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import { type GatewayProfile, type ProfileId, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { readAppLogsTool } from "../app-tools/diagnostics-tools.ts";
import { bindAppTools } from "../app-tools/registry.ts";
import { formatLogLine } from "../diagnostics/report.ts";
import { localDay } from "../logging/daily-file.ts";
import { createLogger } from "../logging/logger.ts";
import { renderClosedThread, ThreadArchive } from "../orchestration/archive.ts";
import { DreamFiles } from "../orchestration/dream-files.ts";
import { OrchestrationMemory } from "../orchestration/memory.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeGateway } from "../rpc/handlers/gateway.ts";
import { AgentHosts } from "../runtime/agent-hosts.ts";
import { threadError, UNKNOWN_FAILURE } from "../runtime/thread-error.ts";
import { makeMemoryVault } from "./key-vault.ts";

const SENTINEL = "sk-sentinel-7f3a9c2e41d8b6";
const KEYCHAIN_SENTINEL = "QmFzZTY0S2V5Y2hhaW5TZW50aW5lbA==";

/** Every file under `dir`, as text. */
const filesUnder = (dir: string): Array<{ name: string; text: string }> =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { name: path, text: readFileSync(path).toString("latin1") };
    });

describe("gateway key storage", () => {
  it.effect(
    "keeps a saved key out of the database, the log file, the diagnostics log lines and read_app_logs",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-key-leaks-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const authorizations: Array<string> = [];
        const profile: GatewayProfile = {
          id: "litellm" as ProfileId,
          name: "LiteLLM",
          baseURL: "https://organization.example.invalid/v1",
          keyRef: "",
          models: [],
        };
        const { logger, file } = createLogger({ dir: join(dir, "logs"), name: "server" });

        yield* Effect.gen(function* () {
          const store = yield* ThreadStore;
          const { handlers, credentials } = makeGateway({
            store,
            hosts: AgentHosts.fromHosts([
              { kind: "codex", listModels: () => Effect.succeed([]) } as unknown as AgentHost,
            ]),
            vault: makeMemoryVault(),
            fetcher: async (_url, init) => {
              authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
              return { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-5" }] }) };
            },
            home: dir,
          });
          yield* handlers["profiles.upsert"]({ profile });
          const result = yield* handlers["profiles.setKey"]({
            profileId: profile.id,
            key: Redacted.make(SENTINEL),
          });
          const resolved = yield* credentials(profile.id, "codex");
          expect(Redacted.value(resolved.key)).toBe(SENTINEL);
          // What the server logs around a key: the profile, the redacted credentials, a key field.
          logger.info(
            { profileId: profile.id, result, credentials: resolved },
            "gateway key saved",
          );
          logger.warn({ apiKey: SENTINEL, authorization: `Bearer ${SENTINEL}` }, "gateway call");
          logger.warn(
            { keychainPassword: KEYCHAIN_SENTINEL, vault: { keychainPassword: KEYCHAIN_SENTINEL } },
            "key store failure",
          );
          // Calls and gateway dictation hold the key in the shell's speech process now, whose
          // own test holds them to the same (packages/shell/src/speech-process/remote.test.ts).
          // A turn's error is the agent's text, which can echo the request's headers; the thread
          // keeps it as its `lastError`, in the database.
          const { project } = yield* store.registerProject({ root: dir, name: "leaks" });
          yield* store.insertThread({
            id: "t-failed" as never,
            projectId: project.id,
            title: "failed",
            userNamed: false,
            model: { agent: "codex", model: "gpt-6-sol", profileId: profile.id },
            mode: "default",
            checkout: { kind: "main", path: dir },
            lastError: threadError(
              UNKNOWN_FAILURE,
              `unexpected status 400 Bad Request: {"headers":{"authorization":"Bearer ${SENTINEL}"}}`,
              { model: "gpt-6-sol", gateway: true },
              1,
            ),
            labels: [],
            pinned: false,
            parked: false,
            unread: false,
            createdAt: 1,
            lastActivityAt: 1,
          });
        }).pipe(Effect.provide(ThreadStore.layerSqlite(join(dir, "gram.db"))));
        file.close();

        // An orchestrator's memory sits in the data dir too, and what it records comes from
        // worker reports and transcripts: a key an agent copied into a note must not land on disk,
        // nor survive in the history a rewrite keeps.
        const memoryRoot = join(dir, "orchestration");
        yield* Effect.gen(function* () {
          const memory = yield* OrchestrationMemory;
          const note = (suffix: string) =>
            `2026-09-24: the gateway key is ${SENTINEL}, from the runner worker. ${suffix}\n`;
          yield* memory.write("workspace-1", "repos/gateway.md", note("First."));
          const rewrite = yield* memory.write("workspace-1", "repos/gateway.md", note("Second."));
          expect(rewrite.before).not.toContain(SENTINEL);
          expect(rewrite.after).not.toContain(SENTINEL);
          expect(yield* memory.read("workspace-1", "repos/gateway.md")).toContain("Second.");
        }).pipe(Effect.provide(OrchestrationMemory.layerAt(memoryRoot)));
        expect(filesUnder(memoryRoot).some((f) => f.name.endsWith("gateway.md"))).toBe(true);
        expect(filesUnder(memoryRoot).some((f) => f.name.includes(".history"))).toBe(true);

        // A dream's folder and the transcript archive sit beside memory and hold whole
        // conversations, where a pasted key is likeliest: every way in scrubs, the manifest's
        // baseline and a transcript's tool output included.
        yield* Effect.gen(function* () {
          const dreams = yield* DreamFiles;
          const archive = yield* ThreadArchive;
          const leaky = `export LLM_API_KEY=${SENTINEL}\n`;
          yield* dreams.prepare({
            workspaceId: "workspace-1",
            dreamId: "dream-key-leaks",
            memoryVersion: "0001",
            memory: [{ path: "MEMORY.md", content: `# Index\n\n${leaky}` }],
            sessions: [{ name: "gateway setup", text: `# Gateway setup\n\n${leaky}` }],
            instructions: `Ignore the key ${SENTINEL}.`,
            seeds: [{ name: "reference_gateway.md", text: leaky }],
          });
          const transcript = renderClosedThread(
            { id: "t-leaky" as never, title: `key ${SENTINEL}` },
            [
              {
                seq: 1,
                message: {
                  id: "m1",
                  role: "user",
                  parts: [{ type: "text", text: `the key is ${SENTINEL}` }],
                },
              },
              {
                seq: 2,
                message: {
                  id: "m2",
                  role: "assistant",
                  parts: [
                    {
                      type: "dynamic-tool",
                      toolName: "Bash",
                      toolCallId: "c1",
                      state: "output-available",
                      input: { command: `curl -H "Authorization: Bearer ${SENTINEL}"` },
                      output: leaky,
                    },
                  ],
                },
              },
            ],
          );
          yield* archive.write("workspace-1", "t-leaky", transcript ?? "");
          // Straight to the door as well, as a caller that rendered nothing would.
          yield* archive.write("workspace-1", "t-raw", leaky);
        }).pipe(
          Effect.provide(DreamFiles.layerAt(memoryRoot)),
          Effect.provide(ThreadArchive.layerAt(memoryRoot)),
        );
        for (const part of ["dreams", "dream-manifests", "archive"]) {
          expect(filesUnder(join(memoryRoot, "workspace-1", part)).length).toBeGreaterThan(0);
        }

        // The key was used for discovery, so the sweep below can't pass for want of a key.
        expect(authorizations).toEqual([`Bearer ${SENTINEL}`]);
        const files = filesUnder(dir);
        expect(files.some((f) => f.name.endsWith("gram.db"))).toBe(true);
        expect(files.some((f) => f.name.includes("server-"))).toBe(true);
        expect(files.filter((f) => f.text.includes(SENTINEL)).map((f) => f.name)).toEqual([]);
        expect(files.filter((f) => f.text.includes(KEYCHAIN_SENTINEL)).map((f) => f.name)).toEqual(
          [],
        );

        const logLines = files
          .filter((f) => f.name.endsWith(".log"))
          .flatMap((f) => f.text.split("\n").filter((line) => line !== ""));
        expect(logLines.length).toBeGreaterThan(0);
        for (const line of logLines) expect(formatLogLine(line)).not.toContain(SENTINEL);
        expect(formatLogLine(`LLM_API_KEY=${SENTINEL} codex exec`)).not.toContain(SENTINEL);

        // read_app_logs puts the log in front of a model: the logger's own file, and a line that
        // reached the file unredacted, which the tool must still scrub on the way out.
        const planted = join(dir, "planted-logs");
        mkdirSync(planted);
        writeFileSync(
          join(planted, `server-${localDay(new Date())}.log`),
          [
            JSON.stringify({
              level: 50,
              time: new Date().toISOString(),
              threadId: "t-failed",
              apiKey: SENTINEL,
              msg: "turn failed",
            }),
            JSON.stringify({
              level: 40,
              time: new Date().toISOString(),
              threadId: "t-failed",
              msg: `spawn failed: LLM_API_KEY=${SENTINEL} codex exec`,
            }),
            `Authorization: Bearer ${SENTINEL}`,
            "",
          ].join("\n"),
        );
        for (const logDir of [join(dir, "logs"), planted]) {
          const [readLogs] = bindAppTools([readAppLogsTool(logDir)], "t-failed" as ThreadId);
          for (const scope of ["thread", "app"] as const) {
            const read = (yield* readLogs!.run({ scope })) as { lines: ReadonlyArray<string> };
            if (logDir === planted)
              expect(read.lines.length).toBeGreaterThan(scope === "app" ? 2 : 1);
            expect(JSON.stringify(read)).not.toContain(SENTINEL);
          }
        }
      }).pipe(Effect.scoped),
  );
});
