import { describe, expect, it } from "@effect/vitest";
import type { AgentHost } from "@gram/agents";
import { AgentUnavailable, HostCodexStatus, HostStatus } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { hostStatusOf } from "./claude-sign-in.ts";
import { codexStatusOf } from "./codex-on-host.ts";

const MODELS = [
  {
    id: "gpt-synthetic",
    displayName: "GPT Synthetic",
    description: "Not carried",
    supportsEffort: true,
    efforts: ["low", "high"] as const,
    speeds: ["standard", "fast"] as const,
    inputModalities: ["text", "image"] as const,
    isDefault: true,
  },
];

const refused = (reason: AgentUnavailable["reason"]) =>
  Effect.fail(
    new AgentUnavailable({ agent: "codex", ...(reason ? { reason } : {}), message: "no" }),
  );

/** A machine's Codex as its own answers make it: its sign-in check, its listing, its gate. */
const codex = (answers: {
  readonly chatgpt?: AgentUnavailable["reason"] | "ok";
  readonly models?: AgentUnavailable["reason"] | "ok";
  readonly gate?: boolean;
  readonly autoReview?: boolean;
}): Effect.Effect<AgentHost, AgentUnavailable> =>
  Effect.succeed({
    kind: "codex",
    capabilities: {} as AgentHost["capabilities"],
    open: () => Effect.die("not opened"),
    checkWorkspaceSwitch:
      answers.chatgpt === "ok" ? Effect.void : refused(answers.chatgpt ?? "not-logged-in"),
    listModels: () => (answers.models === "ok" ? Effect.succeed(MODELS) : refused(answers.models)),
    nativeGateReady: Effect.succeed(answers.gate ?? false),
    autoReviewReady: Effect.succeed(answers.autoReview ?? false),
  });

const installed = () => Promise.resolve({ code: 0, stdout: "codex-cli 0.170.0\n" });
const absent = () => Promise.resolve({ code: 1, stdout: "" });

describe("a joined machine's Codex status", () => {
  it.effect("a ChatGPT login is signed in, with what it lists and whether it holds the gate", () =>
    Effect.gen(function* () {
      const status = yield* codexStatusOf(
        codex({ chatgpt: "ok", models: "ok", gate: true, autoReview: true }),
        installed,
      );
      expect(status).toEqual({
        found: true,
        version: "0.170.0",
        signIn: "signedIn",
        models: [
          {
            id: "gpt-synthetic",
            displayName: "GPT Synthetic",
            supportsEffort: true,
            efforts: ["low", "high"],
            isDefault: true,
            speeds: ["standard", "fast"],
            inputModalities: ["text", "image"],
          },
        ],
        gateReady: true,
        autoReview: true,
      });
      expect(Schema.decodeUnknownSync(HostCodexStatus)(status)).toEqual(status);
    }),
  );

  it.effect(
    "an API key, or a provider the host was started with, runs without a ChatGPT login",
    () =>
      Effect.gen(function* () {
        const status = yield* codexStatusOf(
          codex({ chatgpt: "api-key-auth", models: "ok" }),
          installed,
        );
        expect(status).toMatchObject({ signIn: "apiKey", gateReady: false, autoReview: false });
        expect(status.models).toHaveLength(1);
      }),
  );

  it.effect("one that needs a login says so, and lists nothing", () =>
    Effect.gen(function* () {
      const status = yield* codexStatusOf(
        codex({ chatgpt: "not-logged-in", models: "not-logged-in" }),
        installed,
      );
      expect(status).toMatchObject({ found: true, signIn: "notSignedIn" });
      expect(status).not.toHaveProperty("models");
    }),
  );

  it.effect("one that isn't there is not found, and nothing else is guessed", () =>
    Effect.gen(function* () {
      const status = yield* codexStatusOf(
        codex({ chatgpt: "startup-failed", models: "startup-failed" }),
        absent,
      );
      expect(status).toEqual({
        found: false,
        signIn: "unknown",
        gateReady: false,
        autoReview: false,
      });
      // A host with no Codex at all says the same.
      const none = yield* codexStatusOf(refused("startup-failed"), absent);
      expect(none).toEqual(status);
    }),
  );

  it.effect("one that answered is installed, whatever the login shell's PATH says", () =>
    Effect.gen(function* () {
      const status = yield* codexStatusOf(codex({ chatgpt: "ok", models: "ok" }), absent);
      expect(status).toMatchObject({ found: true, signIn: "signedIn" });
    }),
  );

  it.effect("rides in the machine's status, which a control plane before it reads as it was", () =>
    Effect.gen(function* () {
      const status = yield* hostStatusOf(
        Effect.succeed("signedIn"),
        installed,
        Effect.succeed(undefined),
        codexStatusOf(codex({ chatgpt: "ok", models: "ok" }), installed),
      );
      expect(Schema.decodeUnknownSync(HostStatus)(status).codex).toMatchObject({
        signIn: "signedIn",
      });
      // A released control plane's schema has no `codex`, and reads the rest unchanged.
      const { codex: _, ...released } = HostStatus.fields;
      const older = Schema.decodeUnknownSync(Schema.Struct(released))(status);
      expect(older).not.toHaveProperty("codex");
      expect(older.claudeSignIn).toBe("signedIn");
    }),
  );
});
