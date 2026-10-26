import {
  helperSource,
  helperLocalFallback,
  localHelperModel,
  localHelperEffort,
  localHelperEffortSupported,
  type Settings,
  type SettingsPatch,
  type HelperSource,
  type HelperStatus,
  type HelperProviderStatus,
  type ReasoningVariant,
} from "@gram/contracts";
import { spin } from "@/motion";
import { Brain, Info, RefreshCw } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Picker } from "@/composer/picker";
import { ModelCombobox } from "@/composer/model-picker";
import { EFFORT_OPTIONS } from "@/composer/options";
import { cn } from "@/lib/utils";
import { LONG_COPY, SettingRow } from "./fields";

const HARNESS_OPTIONS = [
  { value: "automatic" as const, label: "Automatic (local subscriptions)" },
  { value: "claude" as const, label: `${agentLabel("claude")} (local)` },
  { value: "codex" as const, label: `${agentLabel("codex")} (local)` },
  { value: "gateway" as const, label: "Gateway (optional)" },
];

export function HelperHarnessPicker({
  source,
  onChange,
}: {
  source: HelperSource;
  onChange: (source: HelperSource) => void;
}) {
  return (
    <Picker
      label="Helper source"
      shortcutId="helper.harness"
      keys=""
      focused={false}
      value={source}
      options={HARNESS_OPTIONS}
      onChange={onChange}
      icon={
        source === "claude" || source === "codex" ? (
          <AgentIcon agent={source} className="size-3.5" />
        ) : undefined
      }
    />
  );
}

/** One compact harness/model/effort row, with the independent second destination in Advanced. */
export function LocalHelperSettings({
  settings,
  status,
  onSave,
  onRetry,
}: {
  settings: Settings;
  status: HelperStatus | undefined;
  onSave: (patch: NonNullable<SettingsPatch["helpers"]>) => void;
  onRetry: () => Promise<unknown>;
}) {
  const source = helperSource(settings);
  const fallback = helperLocalFallback(settings);
  // Automatic edits the preferred harness here; Advanced retains the independent fallback.
  const provider = source === "codex" ? "codex" : "claude";
  const other = provider === "claude" ? "codex" : "claude";
  const refreshInfoId = useId();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string>();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <LocalProviderPicker
        provider={provider}
        settings={settings}
        discovered={status?.providers?.find((row) => row.provider === provider)}
        onSave={onSave}
        harness={
          <HelperHarnessPicker
            source={source}
            onChange={(nextSource) => onSave({ source: nextSource })}
          />
        }
      />
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span role="status">
          {retryError ??
            (status?.lastOutcome
              ? `Last attempt: ${status.lastOutcome}`
              : "Uses the installed CLI and its existing login.")}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh local helpers"
                aria-describedby={refreshInfoId}
                disabled={retrying}
                onClick={() => {
                  setRetrying(true);
                  setRetryError(undefined);
                  onRetry()
                    .catch((e: unknown) => setRetryError(errorMessage(e)))
                    .finally(() => setRetrying(false));
                }}
              />
            }
          >
            <RefreshCw aria-hidden className="size-3.5" ref={retrying ? spin : undefined} />
          </TooltipTrigger>
          <TooltipContent id={refreshInfoId} role="tooltip">
            Refresh models and availability
          </TooltipContent>
        </Tooltip>
      </div>
      <details className="group text-sm">
        <summary className="cursor-pointer text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Advanced · fallback and context
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          <SettingRow
            label="Local fallback"
            description="Only the other authorized local harness. Authentication and tool restriction failures stop here."
          >
            <Select
              value={fallback}
              onValueChange={(value) => {
                if (value) onSave({ localFallback: value as "automatic" | "none" });
              }}
            >
              <SelectTrigger aria-label="Local helper fallback" className="w-56 max-w-full">
                <SelectValue>
                  {fallback === "automatic" ? "Automatic (local only)" : "None"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="automatic">Automatic (local only)</SelectItem>
                <SelectItem value="none">None</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <LocalProviderPicker
            provider={other}
            settings={settings}
            discovered={status?.providers?.find((row) => row.provider === other)}
            onSave={onSave}
          />
          <p {...{ [LONG_COPY]: "privacy notice" }} className="text-xs text-muted-foreground">
            Claude is tool-free; Codex uses guided generation with residual native tools and CLI
            host context. Helpers use Standard speed and redact keys from supplied context. Provider
            data policies and subscription limits apply. Gateway helpers require a separate explicit
            choice and permission.
          </p>
        </div>
      </details>
    </div>
  );
}

function LocalProviderPicker({
  provider,
  settings,
  discovered,
  onSave,
  harness,
}: {
  provider: "claude" | "codex";
  settings: Settings;
  discovered: HelperProviderStatus | undefined;
  onSave: (patch: NonNullable<SettingsPatch["helpers"]>) => void;
  harness?: ReactNode;
}) {
  const informationId = useId();
  const name = `${agentLabel(provider)} / ${provider === "claude" ? "Anthropic" : "OpenAI"}`;
  const modelKey = provider === "claude" ? "claudeModel" : "codexModel";
  const effortKey = provider === "claude" ? "claudeEffort" : "codexEffort";
  const scopeKey = provider === "claude" ? "claudeContext" : "codexContext";
  const saved = settings.helpers?.[modelKey];
  const savedEffort = settings.helpers?.[effortKey];
  const models = discovered?.models ?? [];
  const model = localHelperModel(provider, models, saved);
  const effort = localHelperEffort(model, savedEffort);
  const preferred = localHelperModel(provider, models);
  const target = provider === "claude" ? "Haiku 5.5" : "GPT-6 Luna";
  const options = [
    {
      value: "automatic",
      label: preferred
        ? `Automatic — ${preferred.displayName}`
        : `Automatic — ${target} unavailable`,
    },
    ...models
      .filter((row) => row.id !== "default")
      .map((row) => ({ value: row.id, label: row.displayName, description: row.description })),
  ];
  if (saved !== undefined && !options.some((row) => row.value === saved))
    options.push({ value: saved, label: `${saved}${model ? "" : " (unavailable)"}` });
  const efforts = EFFORT_OPTIONS.filter(
    (row) => model?.supportsEffort && model.efforts?.includes(row.value),
  );
  const effortOptions = [
    {
      value: "automatic",
      label:
        model === undefined
          ? "Effort unavailable"
          : localHelperEffort(model) === "high"
            ? "Automatic — High effort"
            : "CLI default effort",
    },
    ...efforts,
  ];
  if (savedEffort !== undefined && !efforts.some((row) => row.value === savedEffort))
    effortOptions.push({ value: savedEffort, label: `${savedEffort} (unavailable)` });
  const [modelOpen, setModelOpen] = useState(false);
  const unavailable =
    discovered?.state === "ready" &&
    (model === undefined || !localHelperEffortSupported(model, effort));
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={`${provider}-helper-pick`}>
      <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
        {harness && (
          <div className="min-w-0">
            <p className="mb-1 text-xs text-muted-foreground">Harness</p>
            {harness}
          </div>
        )}
        <div className="min-w-0 max-w-full">
          <p className="mb-1 text-xs text-muted-foreground">
            {harness ? "Model" : `${agentLabel(provider)} fallback model`}
          </p>
          <ModelCombobox
            label={`${name} helper model`}
            value={saved ?? "automatic"}
            options={options}
            onChange={(value) => onSave({ [modelKey]: value === "automatic" ? null : value })}
            open={modelOpen}
            onOpenChange={setModelOpen}
            icon={<AgentIcon agent={provider} className="size-3.5" />}
            title={`${name} helper model`}
            description={discovered?.detail}
            labelled
            field
          />
        </div>
        <div className="min-w-0">
          <p className="mb-1 text-xs text-muted-foreground">Effort</p>
          <Picker
            label={`${name} helper effort`}
            shortcutId={`helper.${provider}.effort`}
            keys=""
            focused={false}
            value={savedEffort ?? "automatic"}
            options={effortOptions}
            onChange={(value) =>
              onSave({ [effortKey]: value === "automatic" ? null : (value as ReasoningVariant) })
            }
            icon={<Brain aria-hidden className="size-3.5" />}
          />
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          className={cn(
            (unavailable || discovered?.state === "restriction" || discovered?.state === "auth") &&
              "text-warning",
          )}
        >
          {unavailable
            ? "Saved model or effort unavailable. Choose a listed option or refresh."
            : discovered?.state === "ready"
              ? `${agentLabel(provider)} · ${provider === "claude" ? "Tool-free" : "Guided"} · Standard speed`
              : (discovered?.detail ?? "Checking the installed CLI…")}
        </span>
        <Tooltip>
          <TooltipTrigger
            aria-label={`${name} helper information`}
            aria-describedby={informationId}
            className="shrink-0 rounded p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent id={informationId} role="tooltip">
            {discovered?.detail ??
              "Models come from your installed CLI. Listings do not guarantee account access."}
          </TooltipContent>
        </Tooltip>
      </div>
      {provider === "codex" && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Guided generation uses your Codex subscription with environment tools disabled. Residual
          native tools and CLI host instructions/skills may still participate.
        </p>
      )}
      {provider === "codex" && discovered?.state === "restriction" && harness && (
        <Button
          size="sm"
          variant="outline"
          className="w-fit"
          onClick={() => onSave({ source: "claude" })}
        >
          Use {agentLabel("claude")}
        </Button>
      )}
      <SettingRow
        label="Context shared"
        keywords={[name, "context", "privacy"]}
        description="Permission applies only to this provider. Opening message enables titles; conversation enables all features."
      >
        <Select
          value={settings.helpers?.[scopeKey] ?? "off"}
          onValueChange={(value) => {
            if (value) onSave({ [scopeKey]: value as "off" | "opening" | "conversation" });
          }}
        >
          <SelectTrigger aria-label={`Helper context to ${name}`} className="w-64 max-w-full">
            <SelectValue>
              {
                {
                  off: "No context (off)",
                  opening: "Opening message (titles)",
                  conversation: "Conversation (all helper features)",
                }[settings.helpers?.[scopeKey] ?? "off"]
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">No context (off)</SelectItem>
            <SelectItem value="opening">Opening message (titles)</SelectItem>
            <SelectItem value="conversation">Conversation (all helper features)</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
    </div>
  );
}
