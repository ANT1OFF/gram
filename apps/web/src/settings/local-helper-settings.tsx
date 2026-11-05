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
import { useId, useState } from "react";
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
import { AI_HELPERS_DEFAULTS, resetFor } from "./defaults";
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
      field
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

/**
 * The local helper's rows in the Helper model card: what it runs on, its model and effort, the
 * context each provider may read, and the other local CLI it falls back to. Consent to share
 * context is a row per provider, and neither row reads the other's.
 */
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
  // Automatic edits the preferred harness first; the other one is the fallback below.
  const provider = source === "codex" ? "codex" : "claude";
  const other = provider === "claude" ? "codex" : "claude";
  const refreshInfoId = useId();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string>();
  const resetOf = (key: keyof typeof AI_HELPERS_DEFAULTS) =>
    resetFor(settings, (patch) => onSave(patch.helpers ?? {}))(AI_HELPERS_DEFAULTS[key]);
  return (
    <>
      <SettingRow
        label="Runs on"
        description="Where helper jobs run: a local CLI or your gateway."
        keywords={["harness", "source", "local", "subscription"]}
        onReset={resetOf("source")}
      >
        <HelperHarnessPicker
          source={source}
          onChange={(nextSource) => onSave({ source: nextSource })}
        />
      </SettingRow>
      <LocalProviderRows
        provider={provider}
        settings={settings}
        discovered={status?.providers?.find((row) => row.provider === provider)}
        onSave={onSave}
        resetOf={resetOf}
        main
      />
      <SettingRow
        label="Availability"
        description="Models come from your installed CLI and its login."
        keywords={["refresh", "status"]}
        detail={
          // The last attempt, or why a refresh failed; nothing to add before either.
          retryError !== undefined || status?.lastOutcome !== undefined ? (
            <p role="status" className="text-meta text-muted-foreground">
              {retryError ?? `Last attempt: ${status?.lastOutcome}`}
            </p>
          ) : undefined
        }
      >
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
      </SettingRow>
      <SettingRow
        label="Fallback"
        description={`Try ${agentLabel(other)} when ${agentLabel(provider)} fails. Never a gateway.`}
        keywords={["local fallback", "backup", "second"]}
        learnMore={<p>Sign-in and tool restriction failures stop here instead of falling back.</p>}
        onReset={resetOf("localFallback")}
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
      <LocalProviderRows
        provider={other}
        settings={settings}
        discovered={status?.providers?.find((row) => row.provider === other)}
        onSave={onSave}
        resetOf={resetOf}
        main={false}
      />
      <p {...{ [LONG_COPY]: "privacy notice" }} className="text-meta text-muted-foreground">
        Claude is tool-free; Codex uses guided generation with residual native tools and CLI host
        context. Helpers use Standard speed and redact keys from supplied context. Provider data
        policies and subscription limits apply. Gateway helpers require a separate explicit choice
        and permission.
      </p>
    </>
  );
}

/**
 * One provider's rows: its model, its effort, and the context it may read. The main one is what
 * helpers run on; the other is the fallback, named so.
 */
function LocalProviderRows({
  provider,
  settings,
  discovered,
  onSave,
  resetOf,
  main,
}: {
  provider: "claude" | "codex";
  settings: Settings;
  discovered: HelperProviderStatus | undefined;
  onSave: (patch: NonNullable<SettingsPatch["helpers"]>) => void;
  resetOf: (key: keyof typeof AI_HELPERS_DEFAULTS) => (() => void) | undefined;
  main: boolean;
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
  const agent = agentLabel(provider);
  return (
    <>
      <SettingRow
        label={main ? "Model" : `${agent} fallback model`}
        description={
          main ? "The small model helper jobs run on." : "Used only while Fallback is Automatic."
        }
        keywords={[name, "helper model"]}
        onReset={resetOf(modelKey)}
        detail={
          <div className="flex flex-col gap-2" data-testid={`${provider}-helper-pick`}>
            <div className="flex items-center gap-1.5 text-meta text-muted-foreground">
              <span
                className={cn(
                  (unavailable ||
                    discovered?.state === "restriction" ||
                    discovered?.state === "auth") &&
                    "text-warning",
                )}
              >
                {unavailable
                  ? "Saved model or effort unavailable. Choose a listed option or refresh."
                  : discovered?.state === "ready"
                    ? `${agent} · ${provider === "claude" ? "Tool-free" : "Guided"} · Standard speed`
                    : (discovered?.detail ?? "Checking the installed CLI…")}
              </span>
              <Tooltip>
                <TooltipTrigger
                  aria-label={`${name} helper information`}
                  aria-describedby={informationId}
                  className="shrink-0 rounded-2xs p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              <p className="text-meta leading-relaxed text-muted-foreground">
                Guided generation uses your Codex subscription with no environment. Residual native
                tools and CLI host instructions/skills may still participate.
              </p>
            )}
            {provider === "codex" && discovered?.state === "restriction" && main && (
              <Button
                size="sm"
                variant="outline"
                className="w-fit"
                onClick={() => onSave({ source: "claude" })}
              >
                Use {agentLabel("claude")}
              </Button>
            )}
          </div>
        }
      >
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
      </SettingRow>
      <SettingRow
        label={main ? "Effort" : `${agent} fallback effort`}
        description={main ? "How hard the helper model thinks." : "The fallback model's effort."}
        keywords={[name, "reasoning"]}
        onReset={resetOf(effortKey)}
      >
        <Picker
          field
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
      </SettingRow>
      <SettingRow
        label={`Context for ${agent}`}
        keywords={[name, "context", "privacy", "consent", "context shared"]}
        description="Permission applies only to this provider. Opening message enables titles; conversation enables all features."
        onReset={resetOf(scopeKey)}
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
    </>
  );
}
