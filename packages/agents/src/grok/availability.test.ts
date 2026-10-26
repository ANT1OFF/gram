import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import type * as ChildProcess from "../child-process.ts";
import { spawnServe } from "../child-process.ts";
import { ThreadId, type ModelRef } from "@gram/contracts";
import type { OpenSessionOptions } from "../host.ts";
import { GrokHost, GrokHostLive, makeGrokHost } from "./index.ts";

vi.mock("../child-process.ts", async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawnServe: vi.fn(() => {
    throw new Error("Public Grok must never spawn");
  }),
}));

const reason = "cannot enforce subscription-only inference routing";
const peer = fileURLToPath(new URL("../../fixtures/grok/cli.cjs", import.meta.url));
const threadId = ThreadId.make("synthetic-public-grok");
const model: ModelRef = { agent: "grok", model: "synthetic-grok" };
const attempts: [string, Partial<OpenSessionOptions>][] = [
  ["default selection", {}],
  ["discovered first-party-looking model", { model }],
  ["discovered external model", { model: { agent: "grok", model: "synthetic-external" } }],
  ["saved conversation", { resumeId: "11111111-1111-4111-8111-111111111111" }],
  ["native switching and auxiliary sampling session", { model }],
  ["restart", { resumeId: "11111111-1111-4111-8111-111111111111", model }],
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gram-grok-public-"));
  const log = join(root, "protocol.jsonl");
  // Deliberate obsolete injection fields: no runtime configuration may enable execution.
  const config = {
    home: join(root, "owned"),
    authPath: join(root, "synthetic-never-open.json"),
    binary: process.execPath,
    args: [peer, "opaque-routing", log],
    env: { HOME: root, PATH: "" },
  };
  return { root, log, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("public Grok provider is unavailable without authoritative subscription routing", () => {
  it.each(attempts)("refuses %s before discovery, auth, spawn or inference", async (_, extra) => {
    const f = fixture();
    try {
      const error = await Effect.runPromise(
        Effect.scoped(makeGrokHost(f.config).open({ threadId, cwd: f.root, ...extra })).pipe(
          Effect.flip,
        ),
      );
      expect(error.message).toContain(reason);
      expect(spawnServe).not.toHaveBeenCalled();
      expect(existsSync(f.log)).toBe(false);
      expect(existsSync(f.config.home)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("public layer refuses discovery without reading config or delegating login", async () => {
    const f = fixture();
    try {
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const host = yield* GrokHost;
          return yield* host.listModels().pipe(Effect.flip);
        }).pipe(Effect.provide(GrokHostLive(f.config))),
      );
      expect(error.message).toContain(reason);
      expect(spawnServe).not.toHaveBeenCalled();
      expect(existsSync(f.log)).toBe(false);
      expect(existsSync(f.config.home)).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});
