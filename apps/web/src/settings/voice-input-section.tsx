import {
  keepMicrophoneReadyOf,
  SPEECH_ACCURATE_MODELS,
  SPEECH_MODEL_FOR_STOP,
  speechModelBytes,
  speechModeOf,
  speechPerformanceOf,
  VOICE_UNSUPPORTED_NOTE,
  voiceInputOn,
  voiceSupported,
  type MicrophoneAccess,
  type SpeechMode,
  type SpeechModelId,
  type SpeechPerformance,
  type SpeechStatus,
} from "@gram/contracts";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { Navigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { useApi } from "@/api/context";
import { isMac } from "@/keyboard/registry";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { errorMessage } from "@/api/errors";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { microphone } from "@/dictation/capture";
import { inOrder, useLifecyclePending } from "@/dictation/lifecycle";
import { speechBridge, stopSpeechProcess } from "@/dictation/use-dictation";
import { cn } from "@/lib/utils";
import { useServerSettings } from "@/settings-sync/store";
import { DialogShell } from "@/thread/dialog-shell";

import { OptionGroup, SettingRow, Toggle } from "./fields";
import { SETTINGS_CARD } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";
import {
  accurateFits,
  combinedProgress,
  FAILURE_TITLES,
  formatSize,
  installedBytes,
  LOCAL_HINTS_HELP,
  MODE_HELP,
  MODE_OPTIONS,
  progressOf,
  removeModels,
  STOP_HELP,
  STOP_LABELS,
  STOPS,
  stopOf,
} from "./voice-input-model";

const MODELS: readonly SpeechModelId[] = [
  ...STOPS.map((stop) => SPEECH_MODEL_FOR_STOP[stop]),
  ...SPEECH_ACCURATE_MODELS,
];

/** The statuses of what `accurate` mode adds, once every one of them is known. */
const accurateStatuses = (
  statuses: Readonly<Record<string, SpeechStatus | undefined>>,
): readonly SpeechStatus[] | undefined => {
  const known = SPEECH_ACCURATE_MODELS.flatMap((id) => statuses[id] ?? []);
  return known.length === SPEECH_ACCURATE_MODELS.length ? known : undefined;
};

/** Every pinned variant's status, kept current through each one's watch. */
function useSpeechStatuses(): Readonly<Record<string, SpeechStatus | undefined>> {
  const api = useApi();
  const [statuses, setStatuses] = useState<Record<string, SpeechStatus>>({});
  useEffect(() => {
    const abort = new AbortController();
    const follow = async (model: SpeechModelId, feed: AsyncIterable<SpeechStatus>) => {
      for await (const status of feed) setStatuses((current) => ({ ...current, [model]: status }));
    };
    for (const model of MODELS)
      follow(model, api.watchSpeechInstall(model, abort.signal)).catch((error: unknown) => {
        if (!abort.signal.aborted) console.error("voice input: watch", error);
      });
    return () => abort.abort();
  }, [api]);
  return statuses;
}

/** The system's microphone permission, asked again whenever the window comes back. */
function useMicrophoneAccess(): MicrophoneAccess | undefined {
  const [access, setAccess] = useState<MicrophoneAccess>();
  useEffect(() => {
    const bridge = speechBridge();
    if (bridge === undefined) return;
    const read = () =>
      void bridge.microphoneAccess().then(setAccess, (error: unknown) => {
        console.error("voice input", error);
      });
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, []);
  return access;
}

/**
 * The voice input switch, which is the whole lifecycle: on shows the model's size and licence, then
 * downloads it; off deletes every variant from disk and stops the speech process. Settings →
 * Diagnostics holds one while the feature is experimental, since Voice input's own page is listed
 * only once it is on.
 */
export function VoiceInputSwitch({ label, description }: { label: string; description: string }) {
  const api = useApi();
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const statuses = useSpeechStatuses();
  const [asking, setAsking] = useState<"on" | "off">();
  const [error, setError] = useState<string>();
  const pending = useLifecyclePending();
  const desktop = speechBridge() !== undefined;
  const supported = voiceSupported(window.gram?.platform);

  const on = settings !== undefined && voiceInputOn(settings);
  const stop = settings === undefined ? "balanced" : speechPerformanceOf(settings);
  const model = SPEECH_MODEL_FOR_STOP[stop];
  const current = statuses[model];
  const all = MODELS.map((id) => statuses[id]);

  /** Runs a switch change after any still under way, with the switch held until it's done. */
  const change = (step: () => Promise<void>) => {
    setAsking(undefined);
    setError(undefined);
    inOrder(step).catch((cause: unknown) => setError(errorMessage(cause)));
  };
  const accurate = accurateStatuses(statuses);
  const turnOn = (mode: SpeechMode) =>
    change(async () => {
      await save({ experimental: { voiceInput: true }, voice: { mode } });
      if (mode === "accurate")
        for (const id of SPEECH_ACCURATE_MODELS) await api.installSpeechModel(id);
      await api.installSpeechModel(model);
    });
  // The switch reads on until everything is gone, so turning it on again can't race the deletion.
  const turnOff = () =>
    change(async () => {
      await stopSpeechProcess();
      await removeModels(api, MODELS);
      await save({ experimental: { voiceInput: false } });
    });

  return (
    <>
      <Toggle
        label={label}
        description={supported ? description : `${description} ${VOICE_UNSUPPORTED_NOTE}`}
        keywords={[
          "dictation",
          "speech",
          "microphone",
          "mic",
          "transcribe",
          "voice",
          "experimental",
        ]}
        checked={on}
        disabled={pending || (!desktop && !on)}
        disabledReason={
          pending
            ? on
              ? "Turning voice input off…"
              : "Turning voice input on…"
            : supported
              ? "Voice input needs the Gram app; a browser has no speech process."
              : VOICE_UNSUPPORTED_NOTE
        }
        error={error}
        onChange={(next) => setAsking(next ? "on" : "off")}
      />
      {asking === "on" && current !== undefined && (
        <DownloadNotice
          status={current}
          accurate={accurateFits(current) ? accurate : undefined}
          onCancel={() => setAsking(undefined)}
          onDownload={turnOn}
        />
      )}
      {asking === "off" && (
        <DialogShell
          testId="voice-input-off"
          title="Turn off voice input?"
          description={
            installedBytes(all) > 0
              ? `This deletes the speech model from this computer, freeing ${formatSize(installedBytes(all))}. Turning it on again downloads it again.`
              : "This also stops any download under way."
          }
          onClose={() => setAsking(undefined)}
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAsking(undefined)}>
              Keep it on
            </Button>
            <Button variant="destructive" onClick={turnOff}>
              Turn off and delete
            </Button>
          </div>
        </DialogShell>
      )}
    </>
  );
}

/** Settings → Voice input: the switch, the model's download, the microphone and the slider. */
export function VoiceInputSection() {
  const api = useApi();
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const statuses = useSpeechStatuses();
  const [error, setError] = useState<string>();
  const pending = useLifecyclePending();
  const on = settings !== undefined && voiceInputOn(settings);
  /** On at some point while the page was open, so turning it off here doesn't navigate away. */
  const [seenOn, setSeenOn] = useState(false);
  if (on && !seenOn) setSeenOn(true);
  const dictateKeys = useShortcutHint("composer.dictate");

  if (!settings) return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  // Experimental until 0.9: off, the page opens Diagnostics, unless it was turned off right here.
  if (!on && !seenOn) return <Navigate to="/settings/diagnostics" replace />;
  const stop = speechPerformanceOf(settings);
  const mode = speechModeOf(settings);
  const current = statuses[SPEECH_MODEL_FOR_STOP[stop]];
  const accurate = accurateStatuses(statuses);
  const fail = (cause: unknown) => setError(errorMessage(cause));
  const download = (id: SpeechModelId) => {
    setError(undefined);
    inOrder(async () => {
      // Queued behind turning off, a download has nothing left to download for.
      const latest = useServerSettings.getState().settings;
      if (latest !== undefined && voiceInputOn(latest)) await api.installSpeechModel(id);
    }).catch(fail);
  };

  return (
    <div className="flex flex-col gap-5 text-sm" data-testid="voice-input-settings">
      <div className={SETTINGS_CARD}>
        <VoiceInputSwitch
          label="Voice input"
          description={`Dictate into the composer with its mic button${dictateKeys === "" ? "" : ` or ${dictateKeys}: tap it to start and stop, or hold it while you talk`}. Experimental.`}
        />
        {on && (
          <SettingRow
            label="Vocabulary hints"
            description={LOCAL_HINTS_HELP}
            keywords={["hints", "vocabulary", "prompt", "names"]}
          />
        )}
        {on && current !== undefined && (
          <ModelRow
            status={current}
            fallback={fallbackStop(stop, statuses)}
            onDownload={download}
            disabled={pending}
          />
        )}
        {on && (
          <ModeRow
            mode={mode}
            disabled={pending}
            onChange={(next) => {
              setError(undefined);
              save({ voice: { mode: next } }).catch(fail);
            }}
          />
        )}
        {on && mode === "accurate" && accurate !== undefined && (
          <AccurateModelsRow
            statuses={accurate}
            disabled={pending}
            onDownload={() => {
              for (const id of SPEECH_ACCURATE_MODELS) download(id);
            }}
          />
        )}
        {on && <MicrophoneRow held={keepMicrophoneReadyOf(settings)} />}
        {on && (
          <Toggle
            label="Keep microphone ready"
            description="Catches the half second before you press. Audio stays in memory on this computer."
            // In the open, not in the hover: it's what turning this on consents to.
            detail={
              <p className="text-xs text-muted-foreground">
                The microphone stays open for 2 minutes after you focus a composer or dictate, so{" "}
                {isMac() ? "the macOS" : "your system's"} microphone indicator stays lit.
              </p>
            }
            keywords={["microphone", "instant", "pre-roll", "indicator"]}
            checked={keepMicrophoneReadyOf(settings)}
            onChange={(next) => {
              setError(undefined);
              // Now, not when a composer next renders: there may be none behind Settings.
              if (!next) microphone.keepReady(false);
              save({ voice: { keepMicrophoneReady: next } }).catch(fail);
            }}
          />
        )}
        {error !== undefined && <p className="text-xs text-destructive">{error}</p>}
      </div>
      {on && (
        <div className={SETTINGS_CARD}>
          <PerformanceSlider
            stop={stop}
            disabled={pending}
            needsDownload={
              current !== undefined && current.installed === undefined
                ? speechModelBytes(current.model)
                : undefined
            }
            onChange={(next) => {
              setError(undefined);
              save({ voice: { performance: next } }).catch(fail);
            }}
          />
          {error !== undefined && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** An installed variant dictation uses while the slider's own downloads, if there is one. */
const fallbackStop = (
  stop: SpeechPerformance,
  statuses: Readonly<Record<string, SpeechStatus | undefined>>,
): SpeechPerformance | undefined => {
  if (statuses[SPEECH_MODEL_FOR_STOP[stop]]?.installed !== undefined) return undefined;
  return STOPS.find((other) => statuses[SPEECH_MODEL_FOR_STOP[other]]?.installed !== undefined);
};

/** One model on a consent screen: its name and size, and the licence that comes with it. */
function ConsentModel({ status }: { status: SpeechStatus }) {
  const { model } = status;
  return (
    <div className="flex flex-col gap-1">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Model</dt>
        <dd>{model.name}</dd>
        <dt className="text-muted-foreground">Download</dt>
        <dd>{formatSize(speechModelBytes(model))}</dd>
        <dt className="text-muted-foreground">Licence</dt>
        <dd>
          <a
            href={model.license.url}
            target="_blank"
            rel="noreferrer"
            className="text-link hover:underline"
          >
            {model.license.name}
          </a>
        </dd>
      </dl>
      <p className="text-xs text-muted-foreground">{model.license.attribution}.</p>
    </div>
  );
}

const totalSize = (statuses: readonly SpeechStatus[]) =>
  statuses.reduce((sum, status) => sum + speechModelBytes(status.model), 0);

const totalMemory = (statuses: readonly SpeechStatus[]) =>
  statuses.reduce((sum, status) => sum + status.model.memoryBytes, 0);

/**
 * What a download fetches, under what licences, before anything is fetched: every model named,
 * each with its own licence and notice.
 */
function DownloadNotice({
  status,
  accurate,
  onCancel,
  onDownload,
}: {
  /** The streaming model. */
  status: SpeechStatus;
  /** What `accurate` adds; absent where it doesn't fit, and then only `status` is offered. */
  accurate: readonly SpeechStatus[] | undefined;
  onCancel: () => void;
  onDownload: (mode: SpeechMode) => void;
}) {
  const everything = [status, ...(accurate ?? [])];
  const size = totalSize(everything);
  return (
    <DialogShell
      testId="voice-input-notice"
      title={accurate === undefined ? "Download the speech model?" : "Download the speech models?"}
      description="These recognise speech on this computer: audio and text never leave it."
      onClose={onCancel}
    >
      <div className="flex flex-col gap-3">
        {everything.map((each) => (
          <ConsentModel key={each.model.id} status={each} />
        ))}
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">In all: </span>
        {formatSize(size)}
        {status.freeBytes === undefined ? "" : ` (${formatSize(status.freeBytes)} free)`}, about{" "}
        {formatSize(totalMemory(everything))} of memory while dictating.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Not now
        </Button>
        {accurate !== undefined && (
          <Button variant="outline" onClick={() => onDownload("live")}>
            Live only, {formatSize(speechModelBytes(status.model))}
          </Button>
        )}
        <Button onClick={() => onDownload(accurate === undefined ? "live" : "accurate")}>
          Download {formatSize(size)}
        </Button>
      </div>
    </DialogShell>
  );
}

/** Accurate or Live, with what the choice does. */
function ModeRow({
  mode,
  disabled,
  onChange,
}: {
  mode: SpeechMode;
  disabled: boolean;
  onChange: (mode: SpeechMode) => void;
}) {
  return (
    <SettingRow
      label="Transcription"
      description={MODE_HELP[mode]}
      keywords={["accuracy", "accurate", "live", "punctuation", "parakeet"]}
    >
      <OptionGroup
        label="Transcription"
        options={MODE_OPTIONS}
        value={mode}
        disabled={disabled}
        onChange={onChange}
      />
    </SettingRow>
  );
}

/** What Accurate adds: consent, then its download, as one row. */
function AccurateModelsRow({
  statuses,
  disabled,
  onDownload,
}: {
  statuses: readonly SpeechStatus[];
  disabled: boolean;
  onDownload: () => void;
}) {
  const api = useApi();
  const [asking, setAsking] = useState(false);
  const progress = combinedProgress(statuses);
  const label = "Accurate models";
  const names = statuses.map((status) => status.model.name).join(" and ");
  const memory = `About ${formatSize(totalMemory(statuses))} more memory while dictating.`;
  const fallback = "Dictation stays Live until then.";
  switch (progress.kind) {
    case "ready":
      return (
        <SettingRow
          label={label}
          description={`${names}: ${formatSize(progress.sizeBytes)} on disk. ${statuses.map((status) => `${status.model.license.attribution}.`).join(" ")}`}
        >
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="voice-accurate-ready"
          >
            <CircleCheck aria-hidden className="size-3.5 text-success" />
            Ready
          </span>
        </SettingRow>
      );
    case "downloading":
    case "verifying":
      return (
        <SettingRow
          label={label}
          description={
            progress.kind === "verifying"
              ? "Checking every file against its pinned digest…"
              : `Downloading ${formatSize(progress.receivedBytes)} of ${formatSize(progress.totalBytes)}. ${fallback}`
          }
          detail={
            <ProgressBar
              value={progress.kind === "verifying" ? undefined : progress.receivedBytes}
              max={progress.kind === "verifying" ? undefined : progress.totalBytes}
            />
          }
        >
          {progress.kind === "downloading" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                for (const status of statuses) void api.cancelSpeechInstall(status.model.id);
              }}
            >
              Pause
            </Button>
          )}
        </SettingRow>
      );
    case "paused":
      return (
        <SettingRow
          label={label}
          description={`Paused at ${formatSize(progress.receivedBytes)} of ${formatSize(progress.totalBytes)}. ${fallback}`}
          detail={<ProgressBar value={progress.receivedBytes} max={progress.totalBytes} />}
        >
          <Button size="sm" variant="outline" disabled={disabled} onClick={onDownload}>
            Resume
          </Button>
        </SettingRow>
      );
    case "absent":
      return (
        <SettingRow label={label} description={`${names} aren't downloaded. ${memory} ${fallback}`}>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            data-testid="voice-accurate-download"
            onClick={() => setAsking(true)}
          >
            Download {formatSize(progress.totalBytes)}
          </Button>
          {asking && (
            <AccurateNotice
              statuses={statuses}
              onCancel={() => setAsking(false)}
              onDownload={() => {
                setAsking(false);
                onDownload();
              }}
            />
          )}
        </SettingRow>
      );
    case "failed":
      return (
        <SettingRow
          label={label}
          detail={
            <Alert variant="destructive" data-testid="voice-accurate-failed">
              <TriangleAlert aria-hidden />
              <AlertTitle>{FAILURE_TITLES[progress.reason]}</AlertTitle>
              <AlertDescription>{progress.message}</AlertDescription>
            </Alert>
          }
        >
          <Button size="sm" variant="outline" disabled={disabled} onClick={onDownload}>
            {progress.resumable ? "Resume" : "Try again"}
          </Button>
        </SettingRow>
      );
  }
}

/** The consent for adding Accurate to a voice input that is already on. */
function AccurateNotice({
  statuses,
  onCancel,
  onDownload,
}: {
  statuses: readonly SpeechStatus[];
  onCancel: () => void;
  onDownload: () => void;
}) {
  const size = totalSize(statuses);
  const free = statuses[0]?.freeBytes;
  return (
    <DialogShell
      testId="voice-accurate-notice"
      title="Download the Accurate models?"
      description="These recognise speech on this computer: audio and text never leave it."
      onClose={onCancel}
    >
      <div className="flex flex-col gap-3">
        {statuses.map((status) => (
          <ConsentModel key={status.model.id} status={status} />
        ))}
      </div>
      <p className="text-sm">
        <span className="text-muted-foreground">In all: </span>
        {formatSize(size)}
        {free === undefined ? "" : ` (${formatSize(free)} free)`}, about{" "}
        {formatSize(totalMemory(statuses))} more memory while dictating.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Not now
        </Button>
        <Button onClick={onDownload}>Download {formatSize(size)}</Button>
      </div>
    </DialogShell>
  );
}

/** The slider's model: ready, on its way, paused, or why it stopped. */
function ModelRow({
  status,
  fallback,
  onDownload,
  disabled,
}: {
  status: SpeechStatus;
  fallback: SpeechPerformance | undefined;
  onDownload: (id: SpeechModelId) => void;
  /** While the switch is changing what's installed. */
  disabled: boolean;
}) {
  const api = useApi();
  const progress = progressOf(status);
  const id = status.model.id;
  const label = "Speech model";
  const variant = STOP_LABELS[stopOf(id)];
  const using =
    fallback === undefined ? "" : ` Dictation uses the ${STOP_LABELS[fallback]} model until then.`;
  switch (progress.kind) {
    case "ready":
      return (
        <SettingRow
          label={label}
          description={`${status.model.name}, ${variant}: ${formatSize(progress.sizeBytes)} on disk. ${status.model.license.attribution}.`}
        >
          <span
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="voice-model-ready"
          >
            <CircleCheck aria-hidden className="size-3.5 text-success" />
            Ready
          </span>
        </SettingRow>
      );
    case "downloading":
    case "verifying":
      return (
        <SettingRow
          label={label}
          description={
            progress.kind === "verifying"
              ? "Checking every file against its pinned digest…"
              : `Downloading ${formatSize(progress.receivedBytes)} of ${formatSize(progress.totalBytes)}.${using}`
          }
          detail={
            <ProgressBar
              value={progress.kind === "verifying" ? undefined : progress.receivedBytes}
              max={progress.kind === "verifying" ? undefined : progress.totalBytes}
            />
          }
        >
          {progress.kind === "downloading" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void api.cancelSpeechInstall(id)}
            >
              Pause
            </Button>
          )}
        </SettingRow>
      );
    case "paused":
      return (
        <SettingRow
          label={label}
          description={`Paused at ${formatSize(progress.receivedBytes)} of ${formatSize(progress.totalBytes)}.${using}`}
          detail={<ProgressBar value={progress.receivedBytes} max={progress.totalBytes} />}
        >
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onDownload(id)}>
            Resume
          </Button>
        </SettingRow>
      );
    case "absent":
      return (
        <SettingRow label={label} description={`The ${variant} model isn't downloaded.${using}`}>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onDownload(id)}>
            Download {formatSize(progress.totalBytes)}
          </Button>
        </SettingRow>
      );
    case "failed":
      return (
        <SettingRow
          label={label}
          detail={
            <Alert variant="destructive" data-testid="voice-model-failed">
              <TriangleAlert aria-hidden />
              <AlertTitle>{FAILURE_TITLES[progress.reason]}</AlertTitle>
              <AlertDescription>{progress.message}</AlertDescription>
            </Alert>
          }
        >
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onDownload(id)}>
            {progress.resumable ? "Resume" : "Try again"}
          </Button>
        </SettingRow>
      );
  }
}

/** A thin determinate bar, or an indeterminate one without `value`. */
function ProgressBar({ value, max }: { value: number | undefined; max: number | undefined }) {
  const ratio = value === undefined || max === undefined || max === 0 ? undefined : value / max;
  return (
    <div
      role="progressbar"
      aria-label="Speech model download"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(ratio === undefined ? {} : { "aria-valuenow": Math.round(ratio * 100) })}
      className="h-1 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          "h-full rounded-full bg-primary/70",
          ratio === undefined && "w-1/3 opacity-60",
        )}
        style={ratio === undefined ? undefined : { width: `${ratio * 100}%` }}
      />
    </div>
  );
}

/**
 * Whether the system lets Gram use the microphone, with the way to change it. `held` is "Keep
 * microphone ready", which makes "only while you dictate" untrue.
 */
function MicrophoneRow({ held }: { held: boolean }) {
  const access = useMicrophoneAccess();
  if (access === undefined || access === "unknown") return null;
  const denied = access === "denied" || access === "restricted";
  return (
    <SettingRow
      label="Microphone"
      description={
        access === "granted"
          ? held
            ? "Allowed. Gram keeps it open while it's ready, and uses what it hears only when you dictate."
            : "Allowed. Gram listens only while you dictate."
          : access === "not-determined"
            ? "Asked the first time you dictate."
            : access === "restricted"
              ? "Your organisation's settings don't allow it."
              : "Not allowed. Turn it on for Gram in System Settings → Privacy & Security → Microphone."
      }
    >
      {denied && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void speechBridge()?.openMicrophoneSettings()}
        >
          Open System Settings
        </Button>
      )}
    </SettingRow>
  );
}

/** Responsive · Balanced · Efficient, with what the chosen stop costs in plain words. */
function PerformanceSlider({
  stop,
  disabled,
  needsDownload,
  onChange,
}: {
  stop: SpeechPerformance;
  disabled: boolean;
  /** Bytes the chosen stop's model still needs, while it isn't installed. */
  needsDownload: number | undefined;
  onChange: (stop: SpeechPerformance) => void;
}) {
  const id = useId();
  const helpId = useId();
  const index = STOPS.indexOf(stop);
  return (
    <SettingRow
      label="Responsiveness"
      htmlFor={id}
      description="How soon text appears while you speak, against how much CPU the recogniser uses."
      keywords={["performance", "speed", "cpu", "battery", "latency", "responsive", "efficient"]}
      detail={
        <div className="flex flex-col gap-1.5">
          <input
            id={id}
            type="range"
            min={0}
            max={STOPS.length - 1}
            step={1}
            value={index}
            aria-valuetext={STOP_LABELS[stop]}
            aria-describedby={helpId}
            data-testid="voice-performance"
            disabled={disabled}
            className="w-full accent-primary"
            onChange={(event) => onChange(STOPS[Number(event.target.value)] ?? "balanced")}
          />
          <div aria-hidden className="grid grid-cols-3 text-xs text-muted-foreground">
            {STOPS.map((each, i) => (
              <span
                key={each}
                className={cn(
                  i === 0 ? "text-left" : i === STOPS.length - 1 ? "text-right" : "text-center",
                  each === stop && "font-medium text-foreground",
                )}
              >
                {STOP_LABELS[each]}
              </span>
            ))}
          </div>
          <p
            id={helpId}
            className="text-xs text-muted-foreground"
            data-testid="voice-performance-help"
          >
            {STOP_HELP[stop]}
            {needsDownload === undefined
              ? ""
              : ` Needs a ${formatSize(needsDownload)} download.`}{" "}
            Accuracy is the same at every setting.
          </p>
        </div>
      }
    />
  );
}
