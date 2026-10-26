import { describe, expect, it } from "@effect/vitest";
import { type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WrapUpInput } from "../app-tools/wrap-up-tool.ts";
import { AppToolRegistry } from "../app-tools/registry.ts";
import { hasGit } from "../git/test-repo.ts";
import { makeWorld, openOrchestrator, withServer } from "./test-harness.ts";

// Bound schemas are the source listed by both MCP transports and used before approval.
describe.skipIf(!hasGit)("orchestration tool ergonomics", () => {
  it.effect("lists and decodes canonical arguments and their aliases for every affected tool", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const registry = yield* AppToolRegistry;
          const all = ["plain", "orchestrator", "worker"].flatMap((audience) =>
            registry.forThread(
              "caller" as ThreadId,
              audience as "plain" | "orchestrator" | "worker",
            ),
          );
          const cases = [
            ["send_message", { threadId: "target" }, "text", ["message", "content"]],
            ["message_orchestrator", {}, "text", ["message", "content"]],
            ["broadcast_message", {}, "text", ["message", "content"]],
            ["memory_read", {}, "path", ["file"]],
            ["memory_delete", {}, "path", ["file"]],
            ["memory_write", { content: "body" }, "path", ["file"]],
            ["memory_write", { file: "notes.md" }, "content", ["text", "message"]],
            ["memory_append", { file: "notes.md" }, "text", ["content", "message"]],
            ["memory_edit", { old: "before", new: "after" }, "path", ["file"]],
            [
              "wait_on_user",
              { kind: "action", title: "Review" },
              "body",
              ["content", "text", "message"],
            ],
            ["set_thread_effort", { threadId: "target" }, "variant", ["effort"]],
          ] as const;
          for (const [name, base, field, aliases] of cases) {
            const tool = all.find((candidate) => candidate.descriptor.name === name)!;
            const decode = Schema.decodeUnknownSync(tool.input);
            const value = name === "set_thread_effort" ? "high" : "notes.md";
            const expected = decode({ ...base, [field]: value });
            const properties = Schema.toJsonSchemaDocument(tool.input).schema.properties;
            for (const key of [field, ...aliases]) {
              expect(properties, `${name}.${key} is discoverable`).toHaveProperty(key);
              expect(decode({ ...base, [key]: value }), `${name}.${key}`).toEqual(expected);
            }
            expect(() => decode({ ...base, [field]: value, [aliases[0]!]: "different" })).toThrow();
          }
        }),
      );
    }),
  );

  it.effect(
    "publishes question, stage and wait limits and reports field, limit and actual length",
    () =>
      Effect.gen(function* () {
        const world = yield* makeWorld;
        yield* withServer(
          world,
          Effect.gen(function* () {
            const registry = yield* AppToolRegistry;
            const tools = ["plain", "orchestrator", "worker"].flatMap((audience) =>
              registry.forThread(
                "caller" as ThreadId,
                audience as "plain" | "orchestrator" | "worker",
              ),
            );
            const get = (name: string) => tools.find((tool) => tool.descriptor.name === name)!;
            const props = (name: string) =>
              Schema.toJsonSchemaDocument(get(name).input).schema.properties;
            for (const name of ["ask_user", "ask_question"]) {
              expect(props(name)).toMatchObject({
                question: { maxLength: 300 },
                context: { maxLength: 1000 },
                options: {
                  maxItems: 4,
                  items: {
                    properties: { label: { maxLength: 60 }, description: { maxLength: 200 } },
                  },
                },
              });
              const error = yield* get(name)
                .run({
                  question: "Choose?",
                  options: [{ label: "A", description: "x".repeat(201) }, { label: "B" }],
                })
                .pipe(Effect.flip);
              expect(error.message).toBe(
                "Invalid input: options[0].description: limit 200 characters; actual length 201",
              );
              const tooMany = yield* get(name)
                .run({
                  question: "Choose?",
                  options: Array.from({ length: 5 }, (_, i) => ({ label: String(i) })),
                })
                .pipe(Effect.flip);
              expect(tooMany.message).toBe(
                "Invalid input: options: limit 4 items; actual length 5",
              );
            }
            expect(props("set_stage")).toMatchObject({
              stage: { maxLength: 40 },
              plan: { maxItems: 8, items: { maxLength: 40 } },
              note: { maxLength: 1000 },
            });
            expect(Schema.toJsonSchemaDocument(WrapUpInput).schema.properties).toMatchObject({
              recap: { maxLength: 300 },
              ask: { maxLength: 100 },
              actions: { maxItems: 2, items: { properties: { label: { maxLength: 24 } } } },
            });
            expect(props("wait_on_user")).toMatchObject({
              body: { maxLength: 500 },
              content: { maxLength: 500 },
            });
            for (const field of ["body", "content"]) {
              const error = yield* get("wait_on_user")
                .run({ kind: "action", title: "Review", [field]: "x".repeat(501) })
                .pipe(Effect.flip);
              expect(error.message).toBe(
                `Invalid input: ${field}: limit 500 characters; actual length 501`,
              );
            }
          }),
        );
      }),
  );

  it.effect("keeps memory results stable while mixing file/content and path/text calls", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      yield* withServer(
        world,
        Effect.gen(function* () {
          const { session } = yield* openOrchestrator(world);
          expect(
            yield* session.callTool("memory_write", { file: "notes.md", content: "first" }),
          ).toEqual({ path: "notes.md", bytes: 5 });
          yield* session.callTool("memory_append", { file: "notes.md", content: "second" });
          yield* session.callTool("memory_append", { path: "notes.md", text: "third" });
          const before = yield* session.callTool("memory_read", { file: "notes.md" });
          expect(before).toMatchObject({
            path: "notes.md",
            content: expect.stringContaining("second"),
          });
          expect(yield* session.callTool("memory_read", { path: "notes.md" })).toEqual(before);
          const refused = yield* session
            .callTool("memory_write", { file: "other.md", path: "notes.md", content: "wrong" })
            .pipe(Effect.flip);
          expect(refused.message).toContain("conflicting aliases");
          expect(yield* session.callTool("memory_read", { file: "notes.md" })).toEqual(before);
          expect(yield* session.callTool("memory_delete", { file: "notes.md" })).toEqual({
            path: "notes.md",
            deleted: true,
          });
        }),
      );
    }),
  );
});
