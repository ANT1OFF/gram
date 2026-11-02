import {
  dictationCleanupOf,
  dictationSoundVolumeOf,
  keepMicrophoneReadyOf,
  openSpeechSession,
  SPEECH_MODEL_FOR_STOP,
  speechModeOf,
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
import { postprocess, type PostprocessOptions } from "./postprocess";
import { playTone } from "./sounds";
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
  /**
   * Starts dictation for a press that may turn out to be a tap or part of a shortcut, so it makes
   * no sound until `confirm`.
   */
  startProvisionally(): void;
  /** The provisional start is a real one: the start tone plays once listening. */
  confirm(): void;
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
 * The tones of the dictation under way: the start one plays once capture is live and the start is
 * confirmed, and the stop one only after a start one, so a discard makes no sound.
 */
interface Tones {
  /** Not a press that may yet turn out to be a tap or part of a shortcut. */
  confirmed: boolean;
  /** Capturing. */
  live: boolean;
  /** The start tone played. */
  started: boolean;
}

const startTone = (tones: Tones, volume: number) => {
  if (tones.started || !tones.live || !tones.confirmed) return;
  tones.started = true;
  playTone("start", volume);
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
 * Each finished utterance as it goes into the draft: cleaned up as Settings says, after the shell's
 * Accurate pass and never the live partial. `undefined` when nothing is left, such as a lone "um".
 */
export const committedText = (text: string, cleanup: PostprocessOptions): string | undefined => {
  const cleaned = postprocess(text, cleanup);
  return cleaned.trim() === "" && !cleaned.includes("\n") ? undefined : cleaned;
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
  const mode = settings === undefined ? undefined : speechModeOf(settings);
  const bridge = on ? speechBridge() : undefined;
  const [state, setState] = useState<DictationState>({ phase: "idle" });
  const [partial, setPartial] = useState("");
  const soundVolume = settings === undefined ? 0 : dictationSoundVolumeOf(settings);
  const volume = useRef(soundVolume);
  useEffect(() => {
    volume.current = soundVolume;
  }, [soundVolume]);
  const tones = useRef<Tones>({ confirmed: true, live: false, started: false });
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });
  const cleanup = useRef<PostprocessOptions>({ fillers: true, formatting: true, symbols: true });
  useEffect(() => {
    if (settings !== undefined) cleanup.current = dictationCleanupOf(settings);
  }, [settings]);

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
          const t = tones.current;
          if (next.phase === "listening") {
            t.live = true;
            startTone(t, volume.current);
          } else if (next.phase === "stopping") {
            if (t.started) playTone("stop", volume.current);
            t.live = false;
            t.started = false;
          } else if (next.phase !== "starting") {
            t.live = false;
            t.started = false;
          }
          setState(next);
        },
        onPartial: setPartial,
        onCommit: (text) => {
          const cleaned = committedText(text, cleanup.current);
          if (cleaned !== undefined) commit.current(cleaned);
        },
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
  const begin = (confirmed: boolean) => {
    // Settings is installing or deleting models; a session now could outlive a turn-off.
    if (lifecyclePending()) return;
    if (performance === undefined) return;
    tones.current = { confirmed, live: false, started: false };
    const wanted: DictationTarget = {
      modelId: SPEECH_MODEL_FOR_STOP[performance],
      performance,
      mode,
    };
    void dictation.current?.start(wanted);
  };
  return {
    available: bridge !== undefined,
    state,
    partial,
    active,
    toggle: () => {
      if (active) return dictation.current?.stop();
      begin(true);
    },
    startProvisionally: () => {
      if (!active) begin(false);
    },
    confirm: () => {
      tones.current.confirmed = true;
      startTone(tones.current, volume.current);
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
            ? bridge.prewarm(ready.target.modelId, ready.target.performance, mode)
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
