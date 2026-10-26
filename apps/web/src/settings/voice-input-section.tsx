import {
  SPEECH_MODEL_FOR_STOP,
  speechModelBytes,
  speechPerformanceOf,
  voiceInputOn,
  type MicrophoneAccess,
  type SpeechModelId,
  type SpeechPerformance,
  type SpeechStatus,
} from "@gram/contracts";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { Navigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { useApi } from "@/api/context";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { errorMessage } from "@/api/errors";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { inOrder, useLifecyclePending } from "@/dictation/lifecycle";
import { speechBridge, stopSpeechProcess } from "@/dictation/use-dictation";
import { cn } from "@/lib/utils";
import { useServerSettings } from "@/settings-sync/store";
import { DialogShell } from "@/thread/dialog-shell";

import { SettingRow, Toggle } from "./fields";
import { SETTINGS_CARD } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";
import {
  FAILURE_TITLES,
  formatSize,
  installedBytes,
  LOCAL_HINTS_HELP,
  progressOf,
  removeModels,
  STOP_HELP,
  STOP_LABELS,
  STOPS,
  stopOf,
} from "./voice-input-model";

const MODELS: readonly SpeechModelId[] = STOPS.map((stop) => SPEECH_MODEL_FOR_STOP[stop]);

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
  const turnOn = () =>
    change(async () => {
      await save({ experimental: { voiceInput: true } });
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
        description={description}
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
            : "Voice input needs the Gram app; a browser has no speech process."
        }
        error={error}
        onChange={(next) => setAsking(next ? "on" : "off")}
      />
      {asking === "on" && current !== undefined && (
        <DownloadNotice
          status={current}
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
  const current = statuses[SPEECH_MODEL_FOR_STOP[stop]];
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
        {on && <MicrophoneRow />}
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

/** What turning voice input on downloads, under what licence, before anything is fetched. */
function DownloadNotice({
  status,
  onCancel,
  onDownload,
}: {
  status: SpeechStatus;
  onCancel: () => void;
  onDownload: () => void;
}) {
  const { model } = status;
  const size = speechModelBytes(model);
  return (
    <DialogShell
      testId="voice-input-notice"
      title="Download the speech model?"
      description="This engine recognises speech on this computer: audio and text never leave it."
      onClose={onCancel}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Model</dt>
        <dd>{model.name}</dd>
        <dt className="text-muted-foreground">Download</dt>
        <dd>
          {formatSize(size)}
          {status.freeBytes === undefined ? "" : ` (${formatSize(status.freeBytes)} free)`}
        </dd>
        <dt className="text-muted-foreground">Memory</dt>
        <dd>About {formatSize(model.memoryBytes)} while dictating</dd>
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

/** Whether the system lets Gram use the microphone, with the way to change it. */
function MicrophoneRow() {
  const access = useMicrophoneAccess();
  if (access === undefined || access === "unknown") return null;
  const denied = access === "denied" || access === "restricted";
  return (
    <SettingRow
      label="Microphone"
      description={
        access === "granted"
          ? "Allowed. Gram listens only while you dictate."
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
