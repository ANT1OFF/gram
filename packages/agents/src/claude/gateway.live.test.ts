import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type AgentEvent, type ProfileId } from "@gram/contracts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { GatewayKeyProvider } from "../gateway.ts";
import { ClaudeHost } from "./session.ts";

/**
 * Runs the real `claude` against a LiteLLM gateway's Anthropic route. Opt in with
 * `GRAM_LIVE_CLAUDE_GATEWAY=1` and supply the gateway yourself: `GRAM_GATEWAY_BASE_URL`,
 * `GRAM_GATEWAY_MODEL` (a Claude model id the gateway serves) and `GRAM_GATEWAY_KEY`. The test never
 * reads another tool's config or key file.
 */
const baseURL = process.env["GRAM_GATEWAY_BASE_URL"];
const model = process.env["GRAM_GATEWAY_MODEL"];
const key = process.env["GRAM_GATEWAY_KEY"];
const live =
  process.env["GRAM_LIVE_CLAUDE_GATEWAY"] === "1" &&
  baseURL !== undefined &&
  model !== undefined &&
  key !== undefined;

describe.skipIf(!live)("live Claude through a gateway (GRAM_LIVE_CLAUDE_GATEWAY=1)", () => {
  it.live(
    "completes a turn through the gateway profile",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(
          join(process.platform === "win32" ? tmpdir() : "/tmp", "gram-live-gw-"),
        );
        // Loaded lazily so skipped runs never load the SDK.
        const { ClaudeHostLive } = yield* Effect.promise(() => import("./live.ts"));
        const profileId = "live-gateway" as ProfileId;
        const provider = Layer.succeed(GatewayKeyProvider)({
          credentials: () =>
            Effect.succeed({
              profile: {
                id: profileId,
                name: "Live gateway",
                baseURL: baseURL ?? "",
                keyRef: "profile:live",
                models: [],
              },
              key: Redacted.make(key ?? ""),
            }),
        });
        const events: Array<AgentEvent> = [];

        yield* Effect.gen(function* () {
          const host = yield* ClaudeHost;
          const session = yield* host.open({
            threadId: ThreadId.make("live-gateway"),
            cwd,
            model: { agent: "claude", model: model ?? "", profileId },
            permissionMode: "default",
          });
          yield* Effect.forkScoped(
            Stream.runForEach(session.events, (e) => Effect.sync(() => events.push(e))),
          );
          yield* session.send({ text: "Reply with just: OK" });
          for (let i = 0; i < 1200 && !events.some((e) => e.type === "turnEnd"); i++) {
            yield* Effect.sleep("100 millis");
          }
          expect(events.find((e) => e.type === "turnEnd")).toEqual({
            type: "turnEnd",
            reason: "completed",
          });
          expect(JSON.stringify(events)).not.toContain(key ?? "never-empty");
        }).pipe(
          Effect.scoped,
          Effect.provide(ClaudeHostLive({ settingSources: [] }).pipe(Layer.provide(provider))),
        );
      }),
    180_000,
  );
});
