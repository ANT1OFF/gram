import { SPEECH_MODEL_FOR_STOP, type SpeechStatus } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { MOCK_SPEECH_MODELS } from "@/api/mock-speech";
import {
  inOrder,
  lifecycleMark,
  lifecyclePending,
  lifecycleUnchanged,
} from "@/dictation/lifecycle";
import { installedTarget } from "@/dictation/use-dictation";
import { speechModelsBridge } from "@/api/speech/bridge";

import {
  formatSize,
  installedBytes,
  progressOf,
  removeModels,
  STOP_HELP,
  stopOf,
} from "./voice-input-model";

const status = (index: number, patch: Partial<SpeechStatus> = {}): SpeechStatus => ({
  model: MOCK_SPEECH_MODELS[index]!,
  install: { state: "idle" },
  ...patch,
});
const installed = (index: number) =>
  status(index, {
    installed: { id: MOCK_SPEECH_MODELS[index]!.id, sizeBytes: 661_919_416, installedAt: 1 },
  });

const api = (ready: readonly number[]) => ({
  speechStatus: async (id: string) => {
    const index = MOCK_SPEECH_MODELS.findIndex((model) => model.id === id);
    return ready.includes(index) ? installed(index) : status(index);
  },
});

describe("voice input settings", () => {
  it("sizes as Finder does, and every stop's help states its cost but no accuracy gain", () => {
    expect(formatSize(661_919_416)).toBe("662 MB");
    expect(formatSize(1_300_000_000)).toBe("1.3 GB");
    expect(formatSize(8_952)).toBe("9 KB");
    for (const help of Object.values(STOP_HELP)) {
      expect(help).toMatch(/core/);
      expect(help).not.toMatch(/accura/i);
    }
  });

  it("names each install state for its row, resumable or not", () => {
    expect(progressOf(installed(0))).toEqual({ kind: "ready", sizeBytes: 661_919_416 });
    expect(progressOf(status(0))).toEqual({ kind: "absent", totalBytes: 661_919_416 });
    expect(progressOf(status(0, { install: { state: "idle", resumableBytes: 5 } }))).toEqual({
      kind: "paused",
      receivedBytes: 5,
      totalBytes: 661_919_416,
    });
    expect(
      progressOf(status(0, { install: { state: "failed", reason: "proxy", message: "407" } })),
    ).toEqual({ kind: "failed", reason: "proxy", message: "407", resumable: false });
  });

  it("knows each variant's stop, and what turning off frees", () => {
    expect(stopOf(SPEECH_MODEL_FOR_STOP.efficient)).toBe("efficient");
    expect(installedBytes([installed(0), installed(2), undefined])).toBe(2 * 661_919_416);
  });

  it("dictates at the slider's stop, or an installed one while that downloads", async () => {
    expect(await installedTarget(api([0, 2]), "efficient")).toEqual({
      ok: true,
      target: { modelId: SPEECH_MODEL_FOR_STOP.efficient, performance: "efficient" },
    });
    expect(await installedTarget(api([0]), "responsive")).toEqual({
      ok: true,
      target: { modelId: SPEECH_MODEL_FOR_STOP.balanced, performance: "balanced" },
    });
    expect(await installedTarget(api([]), "balanced")).toMatchObject({
      ok: false,
      code: "model-missing",
    });
  });

  it("marks a turn-off queued after a lookup began, so the lookup can't reach the speech process", async () => {
    const mark = lifecycleMark();
    expect(lifecycleUnchanged(mark)).toBe(true);
    const { promise, resolve } = Promise.withResolvers<void>();
    const off = inOrder(() => promise);
    expect(lifecyclePending()).toBe(true);
    expect(lifecycleUnchanged(mark)).toBe(false);
    resolve();
    await off;
    expect(lifecyclePending()).toBe(false);
    // Done, but it happened since: the lookup's answer is stale.
    expect(lifecycleUnchanged(mark)).toBe(false);
    expect(lifecycleUnchanged(lifecycleMark())).toBe(true);
  });

  it("turns off in a browser, where no shell keeps models, but not past another failure", async () => {
    const ids = MOCK_SPEECH_MODELS.map((model) => model.id);
    await expect(
      removeModels(
        speechModelsBridge(() => undefined),
        ids,
      ),
    ).resolves.toBeUndefined();
    const failing = {
      cancelSpeechInstall: async () => {
        throw new Error("disk");
      },
      removeSpeechModel: async () => undefined,
    };
    await expect(removeModels(failing, ids)).rejects.toThrow("disk");
  });
});
