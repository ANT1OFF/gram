import { FsError, SpeechRefused, type SpeechModels, type SpeechStatus } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { MOCK_SPEECH_MANIFEST } from "../mock-speech";
import { speechModelsBridge } from "./bridge";

const MODEL = MOCK_SPEECH_MANIFEST.id;
const status = (state: "idle" | "verifying"): SpeechStatus => ({
  model: MOCK_SPEECH_MANIFEST,
  install: { state },
});

/** A shell's model store that answers each call with `answer` and replays `watched` to a watch. */
const shell = (
  answer: Awaited<ReturnType<SpeechModels["status"]>>,
  watched: Array<Awaited<ReturnType<SpeechModels["status"]>>> = [],
) => {
  const unwatched: string[] = [];
  const models: SpeechModels = {
    status: async () => answer,
    install: async () => answer,
    cancel: async () => answer,
    remove: async () => answer,
    watch: (model, callback) => {
      queueMicrotask(() => watched.forEach(callback));
      return () => void unwatched.push(model);
    },
  };
  return { models, unwatched };
};

describe("the model store over the shell", () => {
  it("resolves with the status, and throws the tagged error the answer names", async () => {
    expect(
      await speechModelsBridge(
        () => shell({ ok: true, status: status("idle") }).models,
      ).speechStatus(MODEL),
    ).toEqual(status("idle"));
    const refused = speechModelsBridge(
      () =>
        shell({
          ok: false,
          error: { _tag: "SpeechRefused", model: MODEL, reason: "busy", message: "downloading" },
        }).models,
    );
    await expect(refused.installSpeechModel(MODEL)).rejects.toBeInstanceOf(SpeechRefused);
    await expect(refused.installSpeechModel(MODEL)).rejects.toMatchObject({ reason: "busy" });
    const full = speechModelsBridge(
      () => shell({ ok: false, error: { _tag: "FsError", path: "/d", message: "ENOSPC" } }).models,
    );
    await expect(full.removeSpeechModel(MODEL)).rejects.toBeInstanceOf(FsError);
  });

  it("refuses every call without a shell, as unavailable", async () => {
    const none = speechModelsBridge(() => undefined);
    await expect(none.speechStatus(MODEL)).rejects.toMatchObject({
      _tag: "SpeechRefused",
      reason: "unavailable",
    });
    const feed = none.watchSpeechInstall(MODEL, new AbortController().signal);
    await expect(feed[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("yields each watched status until aborted, then unwatches", async () => {
    const { models, unwatched } = shell({ ok: true, status: status("idle") }, [
      { ok: true, status: status("verifying") },
    ]);
    const abort = new AbortController();
    const seen: SpeechStatus[] = [];
    for await (const next of speechModelsBridge(() => models).watchSpeechInstall(
      MODEL,
      abort.signal,
    )) {
      seen.push(next);
      abort.abort();
    }
    expect(seen).toEqual([status("verifying")]);
    expect(unwatched).toEqual([MODEL]);
  });
});
