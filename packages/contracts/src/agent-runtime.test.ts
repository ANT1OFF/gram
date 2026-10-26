import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  AgentRuntimes,
  CliUpdateRefused,
  CliUpdateState,
  RuntimeInstallRefused,
  RuntimeInstallState,
} from "./agent-runtime.ts";
import { GramRpcs } from "./rpc.ts";
import {
  SpeechInstallState,
  SpeechModelManifest,
  SpeechRefused,
  SpeechStatus,
  SpeechVerifiedModel,
  speechModelBytes,
} from "./speech.ts";
import { expectRoundTrip } from "./test-utils.ts";

const SHA = "38aaf6dc".padEnd(64, "0");

describe("agent runtime", () => {
  it("round-trips a listing with every optional part present and absent", () => {
    const value = Schema.decodeUnknownSync(AgentRuntimes)({
      checkedAt: 1,
      releasesCheckedAt: 2,
      releasesChecking: true,
      releasesUnavailable: {
        problem: "sign-in",
        message: "npm registry sign-in expired: run npm login",
      },
      agents: [
        {
          agent: "codex",
          resolved: {
            source: "path",
            path: "/opt/homebrew/bin/codex",
            version: "0.159.2",
            shadowed: [{ path: "/usr/local/bin/codex" }],
          },
          baseline: {
            cliVersion: "0.159.2",
            binding: "codex-protocol",
            bindingVersion: "0.159.2",
          },
          verdict: "supported",
          newer: {
            version: "0.160.0",
            channel: "stable",
            publishedAt: 10,
            eligibleAt: 86_400_010,
            eligible: false,
            verdict: "unknown",
          },
          installSteps: [
            {
              installer: "brew",
              command: "brew upgrade codex",
              exact: false,
              run: ["brew", "upgrade", "codex"],
            },
          ],
          managed: { candidate: { version: "0.159.3", channel: "stable" } },
        },
        {
          agent: "claude",
          baseline: {
            cliVersion: "1.18.29",
            binding: "claude-agent-sdk",
            bindingVersion: "1.18.29",
          },
          verdict: "unknown",
          reason: "Not installed.",
          installSteps: [
            {
              installer: "npm",
              command: "npm i -g @anthropic-ai/claude-code@1.18.29",
              exact: true,
              version: "1.18.29",
            },
          ],
        },
      ],
    });
    expectRoundTrip(AgentRuntimes, value);
    expect("resolved" in value.agents[1]!).toBe(false);
  });

  it("rejects a version that isn't semver and an unknown source", () => {
    const agent = {
      agent: "claude",
      baseline: { cliVersion: "2.1.284", binding: "claude-agent-sdk", bindingVersion: "0.3.284" },
      verdict: "supported",
      installSteps: [],
    };
    const decode = Schema.decodeUnknownSync(AgentRuntimes);
    expect(() => decode({ checkedAt: 1, agents: [agent] })).not.toThrow();
    for (const resolved of [
      { source: "path", path: "/bin/claude", version: "2.1" },
      { source: "brew", path: "/bin/claude" },
    ])
      expect(() => decode({ checkedAt: 1, agents: [{ ...agent, resolved }] })).toThrow();
  });

  it("round-trips every install state and the refusal", () => {
    const install = { version: "0.159.2", sha256: SHA, path: "/s/codex", installedAt: 1 };
    for (const state of [
      { state: "idle" },
      { state: "idle", active: install, previous: { ...install, version: "0.159.1" } },
      {
        state: "downloading",
        version: "0.160.0",
        receivedBytes: 1,
        totalBytes: 9,
        active: install,
      },
      { state: "verifying", version: "0.160.0" },
      { state: "testing", version: "0.160.0" },
      { state: "ready", version: "0.160.0", activeSessions: 2, active: install },
      { state: "failed", version: "0.160.0", message: "digest mismatch", active: install },
      { state: "rolledBack", from: "0.160.0", message: "app-server exited (1)", active: install },
    ])
      expectRoundTrip(RuntimeInstallState, Schema.decodeUnknownSync(RuntimeInstallState)(state));
    expectRoundTrip(
      RuntimeInstallRefused,
      new RuntimeInstallRefused({ agent: "codex", reason: "not-eligible", message: "wait" }),
    );
  });

  it("round-trips every state of an update to the user's own CLI, and its refusal", () => {
    const run = { command: "claude update", output: "Upgrading…\n" };
    for (const state of [
      { state: "idle" },
      { state: "running", ...run, startedAt: 1, runningThreads: 0 },
      { state: "succeeded", ...run, from: "1.18.29", version: "1.19.0", runningThreads: 2 },
      { state: "succeeded", ...run, runningThreads: 0 },
      { state: "failed", ...run, problem: "sign-in", message: "npm registry sign-in expired" },
    ])
      expectRoundTrip(CliUpdateState, Schema.decodeUnknownSync(CliUpdateState)(state));
    expect(() =>
      Schema.decodeUnknownSync(CliUpdateState)({ state: "failed", ...run, problem: "sudo" }),
    ).toThrow();
    expectRoundTrip(
      CliUpdateRefused,
      new CliUpdateRefused({ agent: "codex", reason: "busy", message: "already running" }),
    );
  });

  it("serves the install RPCs, with the install-state ones a stream and a refusal", () => {
    for (const tag of [
      "agentRuntime.list",
      "agentRuntime.installState",
      "agentRuntime.watchInstall",
      "agentRuntime.install",
      "agentRuntime.cancel",
      "agentRuntime.rollback",
      "agentRuntime.useSource",
      "agentRuntime.update",
      "agentRuntime.watchUpdate",
      "agentRuntime.cancelUpdate",
    ])
      expect(GramRpcs.requests.has(tag), tag).toBe(true);
    const install = GramRpcs.requests.get("agentRuntime.install")!;
    expect(() =>
      Schema.decodeUnknownSync(install.payloadSchema)({ agent: "codex", version: "latest" }),
    ).toThrow();
  });
});

describe("speech models", () => {
  const manifest = {
    id: "nemotron-speech-en-0.6b-560ms-int8",
    name: "Nemotron Speech Streaming EN 0.6B",
    languages: ["en"],
    license: {
      id: "nvidia-open-model-license",
      name: "NVIDIA Open Model License",
      url: "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/",
      attribution: "Licensed by NVIDIA Corporation under the NVIDIA Open Model License",
    },
    source: {
      repo: "nvidia/nemotron-speech-streaming-en-0.6b",
      revision: "ebe59e5a817142986528bbbee5dba8db7b38ed50",
      sha256: SHA,
    },
    repo: "csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25",
    revision: "52056fdc070914a48dcd68b31b44d6a6f5b85902",
    files: [
      { path: "encoder.int8.onnx", size: 652_916_849, sha256: SHA },
      { path: "licenses/NOTICE", size: 0, sha256: SHA },
    ],
    recognizer: {
      kind: "sherpa-onnx-online-transducer",
      encoder: "encoder.int8.onnx",
      decoder: "decoder.int8.onnx",
      joiner: "joiner.int8.onnx",
      tokens: "tokens.txt",
      chunkMs: 560,
    },
    memoryBytes: 1_300_000_000,
    evidence: [{ kind: "export-run", status: "verified", detail: "byte-identical rerun" }],
  };

  it("round-trips a manifest and every status, installed or not", () => {
    const decoded = Schema.decodeUnknownSync(SpeechModelManifest)(manifest);
    expectRoundTrip(SpeechModelManifest, decoded);
    expect(speechModelBytes(decoded)).toBe(652_916_849);
    expectRoundTrip(
      SpeechVerifiedModel,
      Schema.decodeUnknownSync(SpeechVerifiedModel)({ ...manifest, verifiedAt: 5 }),
    );
    for (const install of [
      { state: "idle" },
      { state: "idle", resumableBytes: 4096 },
      { state: "downloading", receivedBytes: 1, totalBytes: 9 },
      { state: "verifying" },
      { state: "failed", reason: "proxy", message: "407 from the proxy", resumableBytes: 9 },
      { state: "failed", reason: "verification", message: "encoder.int8.onnx: sha256 differs" },
    ]) {
      expectRoundTrip(SpeechInstallState, Schema.decodeUnknownSync(SpeechInstallState)(install));
      const status = Schema.decodeUnknownSync(SpeechStatus)({
        model: manifest,
        install,
        installed: { id: manifest.id, sizeBytes: 9, installedAt: 1 },
        freeBytes: 10,
      });
      expectRoundTrip(SpeechStatus, status);
    }
    expectRoundTrip(
      SpeechStatus,
      Schema.decodeUnknownSync(SpeechStatus)({ model: manifest, install: { state: "idle" } }),
    );
    expectRoundTrip(
      SpeechRefused,
      new SpeechRefused({ model: "x", reason: "unknown-model", message: "not pinned" }),
    );
  });

  it("refuses a file path that could escape the store, and a revision that could move", () => {
    const decode = Schema.decodeUnknownSync(SpeechModelManifest);
    for (const path of ["../encoder.onnx", "/etc/passwd", "a/../b", "a\\b", "./x", ""])
      expect(
        () => decode({ ...manifest, files: [{ path, size: 1, sha256: SHA }] }),
        path,
      ).toThrow();
    // A pinned revision is a commit, never a branch or tag that could move.
    for (const revision of ["main", "52056fdc", "v1.0"])
      expect(() => decode({ ...manifest, revision }), revision).toThrow();
    for (const repo of ["csukuangfj2", "a/b/c", "../x/y"])
      expect(() => decode({ ...manifest, repo }), repo).toThrow();
  });

  it("leaves the model store and the gateway engine's sessions to the shell", () => {
    for (const tag of [
      "speech.status",
      "speech.watchInstall",
      "speech.install",
      "speech.cancel",
      "speech.remove",
      "speech.gatewaySession",
      "speech.gatewayAudio",
      "speech.gatewayStop",
    ])
      expect(GramRpcs.requests.has(tag), tag).toBe(false);
  });
});
