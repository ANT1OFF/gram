import {
  keepMicrophoneReadyOf,
  openSpeechSession,
  SPEECH_MODEL_FOR_STOP,
  speechPerformanceOf,
  voiceInputOn,
  type DesktopSpeech,
  type SpeechPerformance,
} from "@gram/contracts";
import { useEffect, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { useServerSettings } from "@/settings-sync/store";

import { microphone } from "./capture";
import { lifecycleMark, lifecyclePending, lifecycleUnchanged } from "./lifecycle";
import type { Api } from "@/api/types";

import {
  createDictation,
  type Dictation,
  type DictationState,
  type DictationTarget,
  type Preflight,
} from "./session";

/** The desktop shell's speech process, or the mock API's stand-in; absent in a plain browser. */
export const speechBridge = (): DesktopSpeech | undefined =>
  window.gram?.speech ?? window.gramMock?.speechBridge;

/**
 * Stops the speech process now rather than at its idle timeout, ending any session, for when voice
 * input is turned off. An older shell without `shutdown` lets its idle timeout do it.
 */
export const stopSpeechProcess = async (): Promise<void> => {
  microphone.keepReady(false);
  await speechBridge()?.shutdown?.();
};

export interface DictationControls {
  /** Voice input is turned on and this window can reach a speech process. */
  readonly available: boolean;
  readonly state: DictationState;
  /** Words heard and not yet in the draft. */
  readonly partial: string;
  /** Listening, or about to, or finishing: the composer shows the partial and Escape cancels. */
  readonly active: boolean;
  /** How loud the microphone is now, from 0 to 1; read by the listening bars on each clock step. */
  level(): number;
  toggle(): void;
  /** Gets everything ready ahead of a start, the model above all; for the field's focus. */
  prewarm(): void;
  stop(): void;
  cancel(): void;
}

const STOPS = Object.keys(SPEECH_MODEL_FOR_STOP) as SpeechPerformance[];

const STOPPED = {
  ok: false,
  code: "stopped",
  message: "Voice input is being changed in Settings.",
} as const;

/**
 * The slider's stop if its model is installed; otherwise an installed variant at its own stop, so
 * dictation keeps working while a new stop's model downloads.
 */
export const installedTarget = async (
  api: Pick<Api, "speechStatus">,
  performance: SpeechPerformance,
): Promise<Preflight> => {
  for (const stop of [performance, ...STOPS.filter((other) => other !== performance)]) {
    const modelId = SPEECH_MODEL_FOR_STOP[stop];
    if ((await api.speechStatus(modelId)).installed !== undefined)
      return { ok: true, target: { modelId, performance: stop } };
  }
  return {
    ok: false,
    code: "model-missing",
    message: "The speech model isn't downloaded yet (Settings → Voice input).",
  };
};

/**
 * `installedTarget` that remembers a yes, so a press doesn't wait on the lookups. Only for the
 * slider's own model, and only until Settings changes what's installed: a fallback has to give way
 * as soon as the slider's model lands. `forget` is for when the speech process says it's gone.
 */
export const rememberedTarget = (api: Pick<Api, "speechStatus">) => {
  let known:
    | { readonly mark: number; readonly stop: SpeechPerformance; ready: Preflight }
    | undefined;
  return {
    check: async (performance: SpeechPerformance): Promise<Preflight> => {
      const mark = lifecycleMark();
      if (known?.mark === mark && known.stop === performance) return known.ready;
      const ready = await installedTarget(api, performance);
      if (ready.ok && ready.target?.performance === performance && lifecycleUnchanged(mark))
        known = { mark, stop: performance, ready };
      return ready;
    },
    forget: () => {
      known = undefined;
    },
  };
};

/**
 * Local dictation into one composer: `onCommit` puts each finished utterance into the draft.
 */
export function useDictation(onCommit: (text: string) => void): DictationControls {
  const api = useApi();
  const settings = useServerSettings((s) => s.settings);
  const on = settings !== undefined && voiceInputOn(settings);
  const performance = settings === undefined ? undefined : speechPerformanceOf(settings);
  const keepReady = settings !== undefined && on && keepMicrophoneReadyOf(settings);
  const bridge = on ? speechBridge() : undefined;
  const [state, setState] = useState<DictationState>({ phase: "idle" });
  const [partial, setPartial] = useState("");
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });

  useEffect(() => microphone.keepReady(keepReady), [keepReady]);

  const target = useRef(rememberedTarget(api));
  const dictation = useRef<Dictation | undefined>(undefined);
  useEffect(() => {
    if (bridge === undefined) return;
    target.current = rememberedTarget(api);
    /** Once the system says yes it stays yes for a press; `getUserMedia` reports a later no. */
    let allowed = false;
    const created = createDictation(
      {
        preflight: (wanted) => target.current.check(wanted.performance ?? "balanced"),
        // A start begun before Settings queued a change goes no further than its lookups.
        open: (request) =>
          lifecyclePending()
            ? Promise.resolve(STOPPED)
            : openSpeechSession(bridge, request, window),
        requestMicrophone: async () => {
          if (allowed) return "granted";
          if (lifecyclePending()) return "unknown";
          const access = await bridge.requestMicrophoneAccess();
          allowed = access === "granted";
          return access;
        },
        startCapture: microphone.start,
        newSessionId: () => crypto.randomUUID(),
      },
      {
        onState: (next) => {
          if (next.phase === "error" && next.code === "model-missing") target.current.forget();
          setState(next);
        },
        onPartial: setPartial,
        onCommit: (text) => commit.current(text),
      },
    );
    dictation.current = created;
    return () => {
      created.cancel();
      dictation.current = undefined;
    };
  }, [api, bridge]);

  const active =
    state.phase === "starting" || state.phase === "listening" || state.phase === "stopping";
  return {
    available: bridge !== undefined,
    state,
    partial,
    active,
    toggle: () => {
      if (active) return dictation.current?.stop();
      // Settings is installing or deleting models; a session now could outlive a turn-off.
      if (lifecyclePending()) return;
      if (performance === undefined) return;
      const wanted: DictationTarget = { modelId: SPEECH_MODEL_FOR_STOP[performance], performance };
      void dictation.current?.start(wanted);
    },
    prewarm: () => {
      // Not while Settings changes what's installed: a prewarm after its `shutdown` would start
      // the speech process again.
      if (bridge === undefined || performance === undefined || active || lifecyclePending()) return;
      const mark = lifecycleMark();
      microphone.warm();
      void target.current
        .check(performance)
        .then((ready) =>
          ready.ok && ready.target !== undefined && lifecycleUnchanged(mark)
            ? bridge.prewarm(ready.target.modelId, ready.target.performance)
            : undefined,
        )
        .catch((error: unknown) => console.warn("dictation", error));
      // Never the first ask for the microphone: that belongs to a press.
      if (keepReady)
        void bridge
          .microphoneAccess()
          .then((access) => {
            if (access === "granted" && lifecycleUnchanged(mark)) microphone.ready();
          })
          .catch((error: unknown) => console.warn("dictation", error));
    },
    level: () => dictation.current?.level() ?? 0,
    stop: () => dictation.current?.stop(),
    cancel: () => dictation.current?.cancel(),
  };
}
