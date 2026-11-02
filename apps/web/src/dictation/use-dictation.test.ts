import { SPEECH_MODEL_FOR_STOP, type SpeechPerformance } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";

import { inOrder } from "./lifecycle";
import { rememberedTarget } from "./use-dictation";

const api = (installed: () => readonly SpeechPerformance[]) => {
  const speechStatus = vi.fn(async (model: string) => ({
    installed: installed().some((stop) => SPEECH_MODEL_FOR_STOP[stop] === model) ? {} : undefined,
  }));
  return { speechStatus } as unknown as Parameters<typeof rememberedTarget>[0] & {
    speechStatus: typeof speechStatus;
  };
};

describe("the remembered target", () => {
  it("asks once for the slider's model, and again for another stop", async () => {
    const lookups = api(() => ["balanced", "efficient"]);
    const target = rememberedTarget(lookups);
    const first = await target.check("balanced");
    expect(first).toMatchObject({ ok: true, target: { performance: "balanced" } });
    expect(await target.check("balanced")).toEqual(first);
    expect(lookups.speechStatus).toHaveBeenCalledOnce();
    await target.check("efficient");
    expect(lookups.speechStatus).toHaveBeenCalledTimes(2);
  });

  it("never remembers a fallback or a no, so the slider's model is used once it lands", async () => {
    let installed: readonly SpeechPerformance[] = [];
    const target = rememberedTarget(api(() => installed));
    expect(await target.check("balanced")).toMatchObject({ ok: false, code: "model-missing" });
    installed = ["efficient"];
    expect(await target.check("balanced")).toMatchObject({ target: { performance: "efficient" } });
    installed = ["balanced"];
    expect(await target.check("balanced")).toMatchObject({ target: { performance: "balanced" } });
  });

  it("asks again after Settings changes what's installed, or the speech process says it's gone", async () => {
    let installed: readonly SpeechPerformance[] = ["balanced"];
    const target = rememberedTarget(api(() => installed));
    await target.check("balanced");
    installed = [];
    await inOrder(async () => {});
    expect(await target.check("balanced")).toMatchObject({ ok: false });

    installed = ["balanced"];
    await target.check("balanced");
    installed = [];
    target.forget();
    expect(await target.check("balanced")).toMatchObject({ ok: false });
  });
});
