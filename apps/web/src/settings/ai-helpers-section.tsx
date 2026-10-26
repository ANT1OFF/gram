import {
  DEFAULT_HELPER,
  DEFAULT_HELPER_FALLBACK,
  gatewayEfforts,
  helperChoice,
  helperSource,
  helperLocalContextAllowed,
  helperDailyBudgetUsd,
  gatewayModelUsable,
  helperFallbackChoice,
  helperContextAllowed,
  SUGGEST_COUNTS_DAYS,
  suggestKeepRate,
  type GatewayProfile,
  type HelperKind,
  type HelperStatus,
  type ReasoningVariant,
  type SettingsPatch,
  type SuggestCounts,
  UNLISTED_GATEWAY_EFFORTS,
} from "@gram/contracts";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { Fragment, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import type { Api } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModelCombobox } from "@/composer/model-picker";
import { MODEL_SEARCH_THRESHOLD } from "@/composer/models";
import { EFFORT_OPTIONS } from "@/composer/options";
import { cn } from "@/lib/utils";
import { useServerSettings } from "@/settings-sync/store";

import { HelperHarnessPicker, LocalHelperSettings } from "./local-helper-settings";
import { AI_HELPERS_DEFAULTS, resetFor } from "./defaults";
import { inputCls, LONG_COPY, SettingRow, Toggle } from "./fields";
import { SettingsGroup } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";

type HelpersKey = keyof NonNullable<SettingsPatch["helpers"]>;

/** Where today's usage is cached; the page refetches it while open. */
const HELPER_STATUS_KEY = ["helper-status"] as const;

const KIND_LABELS: Readonly<Record<HelperKind, string>> = {
  title: "Titles",
  plan: "Plans",
  recap: "Recaps",
  suggest: "Suggestions",
  wait: "Waiting on you",
  notice: "Notification titles",
  stuck: "Why stuck",
};

const FEATURES: ReadonlyArray<{
  readonly kind: HelperKind;
  readonly label: string;
  readonly description: string;
}> = [
  {
    kind: "title",
    label: "Thread titles",
    description: "Names threads from their opening exchange.",
  },
  {
    kind: "plan",
    label: "Thread plans",
    description: "Keeps a short plan from conversation and pull request context.",
  },
  {
    kind: "recap",
    label: "Where you left off",
    description: "A short recap when you return to an idle thread.",
  },
  {
    kind: "suggest",
    label: "Suggested replies",
    description: "Drafts a possible next reply in the composer.",
  },
  {
    kind: "wait",
    label: "Waiting on you",
    description: "Suggests follow-up tasks for you to review and keep.",
  },
  {
    kind: "notice",
    label: "Notification titles",
    description: "Titles an ask's notification. The exact command stays under it.",
  },
  {
    kind: "stuck",
    label: "Why is it stuck?",
    description: "One sentence on a worker that hasn't moved in a while.",
  },
];

/** Dollars as the page shows them: cents, or "under $0.01" for the fractions a day of Luna costs. */
export const formatUsd = (usd: number): string =>
  usd > 0 && usd < 0.005 ? "under $0.01" : `$${usd.toFixed(2)}`;

const plural = (count: number, noun: string) =>
  `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;

/** Today's use in one line: "312 calls · $0.07 of $2.00 · 3 failures". */
export const usageLine = (status: HelperStatus): string =>
  [
    plural(status.calls, "call"),
    `${formatUsd(status.costUsd)} of ${formatUsd(status.dailyBudgetUsd)}`,
    ...(status.failures > 0 ? [plural(status.failures, "failure")] : []),
  ].join(" · ");

/** Why helpers are paused, in the words of the banner the page shows. */
export const pauseLine = (status: HelperStatus): string | undefined => {
  if (status.paused === undefined) return undefined;
  return status.paused.reason === "budget"
    ? "Helpers paused until midnight UTC: daily budget reached."
    : "Helpers paused until midnight UTC: the gateway disabled your key at its spending limit. Check your provider's account or contact its operator.";
};

/**
 * How often suggested replies were used: "Last 7 days: used in 9 of 34 turns that offered them
 * (26%)", a turn counted once, a whole acceptance and a word-by-word one alike. The product's own
 * bar for keeping them on by default is left out: nothing here changes because of it.
 */
export const suggestRateLine = (counts: SuggestCounts): string => {
  const rate = suggestKeepRate(counts);
  if (rate === undefined) return `None shown in the last ${SUGGEST_COUNTS_DAYS} days.`;
  return `Last ${SUGGEST_COUNTS_DAYS} days: used in ${counts.taken} of ${counts.shown.toLocaleString("en-US")} turns that offered them (${Math.round(rate * 100)}%).`;
};

/** What "used" counts, for the line's tooltip: it is not a send rate, nor a measure of quality. */
const SUGGEST_RATE_TITLE =
  "Used means at least one word of a suggestion went into the composer, sent or not.";

/** Today's calls per kind, cheapest models folded in. */
const usageByKind = (status: HelperStatus) =>
  (["title", "plan", "recap", "suggest", "wait", "notice", "stuck"] as const).flatMap((kind) => {
    const lines = status.lines.filter((line) => line.kind === kind);
    if (lines.length === 0) return [];
    const calls = lines.reduce((sum, line) => sum + line.calls, 0);
    const cost = lines.reduce((sum, line) => sum + line.costUsd, 0);
    return [
      { kind, label: KIND_LABELS[kind], text: `${plural(calls, "call")} · ${formatUsd(cost)}` },
    ];
  });

/** The host a gateway address names, or the address itself when it isn't a URL. */
const hostOf = (baseURL: string): string => {
  try {
    return new URL(baseURL).host;
  } catch {
    // Shown as typed: it is what the user entered.
    return baseURL;
  }
};

/**
 * Profile saves one after another, each applied to the profile as stored when its turn comes:
 * `profiles.upsert` replaces the whole profile, so two pickers each saving their own copy would
 * undo each other's change.
 */
let profileSaves: Promise<unknown> = Promise.resolve();

/** Settings → AI helpers: the helper model's switches, models, budget and today's use. */
export function AiHelpersSection() {
  const api = useApi();
  const settings = useServerSettings((s) => s.settings);
  const save = useSaveSettings();
  const apiQueryClient = useQueryClient();
  const [failed, setFailed] = useState<{ key: HelpersKey; message: string }>();
  const { data: profiles } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });
  const { data: status } = useQuery({
    queryKey: HELPER_STATUS_KEY,
    queryFn: () => api.helperStatus(),
    refetchInterval: 60_000,
  });

  if (!settings) return <p className="text-sm text-muted-foreground">Loading settings…</p>;

  const apply = (key: HelpersKey, patch: NonNullable<SettingsPatch["helpers"]>) => {
    setFailed(undefined);
    save({ helpers: patch }).catch((e: unknown) => setFailed({ key, message: errorMessage(e) }));
  };
  const errorOf = (key: HelpersKey) => (failed?.key === key ? failed.message : undefined);
  const resetOf = (key: HelpersKey) =>
    resetFor(settings, (patch) => apply(key, patch.helpers ?? {}))(
      AI_HELPERS_DEFAULTS[key as keyof typeof AI_HELPERS_DEFAULTS],
    );

  const on = settings.helpers?.enabled !== false;
  const source = helperSource(settings);
  const profile = profiles?.find((p) => p.default === true);
  const pause = status === undefined ? undefined : pauseLine(status);

  return (
    <div className="flex flex-col gap-6" data-testid="ai-helper-settings">
      <SettingsGroup label="Helper model">
        <Toggle
          label="Use the helper model"
          description="Titles, plans, recaps and reply suggestions through your chosen harness."
          keywords={["ai", "helper", "llm", "off switch", "privacy"]}
          checked={on}
          onReset={resetOf("enabled")}
          error={errorOf("enabled")}
          onChange={(enabled) => apply("enabled", { enabled })}
        />
        {source === "gateway" && (
          <SettingRow label="Harness" error={errorOf("source")}>
            <HelperHarnessPicker
              source={source}
              onChange={(nextSource) => apply("source", { source: nextSource })}
            />
          </SettingRow>
        )}
        {errorOf("source") && (
          <p role="alert" className="text-xs text-destructive">
            {errorOf("source")}
          </p>
        )}
        {source !== "gateway" ? (
          <LocalHelperSettings
            settings={settings}
            status={status}
            onSave={(patch) => apply("source", patch)}
            onRetry={() =>
              api
                .helperStatus()
                .then((value) => apiQueryClient.setQueryData(HELPER_STATUS_KEY, value))
            }
          />
        ) : profile === undefined ? (
          <SettingRow
            label="Model"
            description="Helpers run on your default gateway, and there isn't one yet."
          >
            <Button
              size="sm"
              variant="outline"
              render={<Link to="/settings/gateways" />}
              nativeButton={false}
            >
              Set up a gateway
            </Button>
          </SettingRow>
        ) : (
          <>
            <HelperContextPicker profile={profile} />
            <SettingRow
              label="Model"
              description={`A small, quick model on ${profile.name}; each job is a few thousand tokens.`}
              learnMore={
                <p>
                  Automatic follows what the gateway lists; a model picked by name stays until you
                  change it.
                </p>
              }
            >
              <HelperModelPicker profile={profile} slot="primary" />
            </SettingRow>
            <SettingRow
              label="Fallback"
              description="Tried when the model times out, is rate-limited or answers badly. Best from another vendor."
            >
              <HelperModelPicker profile={profile} slot="fallback" />
            </SettingRow>
          </>
        )}
      </SettingsGroup>

      <SettingsGroup
        label="Features"
        description="Each feature needs its own switch and context permission for the selected destination."
      >
        {FEATURES.map((feature) => {
          const reason = !on
            ? "Turn on Use the helper model first."
            : (
                  source === "gateway"
                    ? profile === undefined || !helperContextAllowed(profile, feature.kind)
                    : !(
                        source === "automatic"
                          ? (["claude", "codex"] as const)
                          : ([source] as const)
                      ).some((provider) =>
                        helperLocalContextAllowed(settings, provider, feature.kind),
                      )
                )
              ? "Allow this helper's context above first."
              : undefined;
          return (
            <Toggle
              key={feature.kind}
              label={feature.label}
              description={feature.description}
              checked={settings.helpers?.[feature.kind] !== false}
              disabled={reason !== undefined}
              disabledReason={reason}
              onReset={resetOf(feature.kind)}
              error={errorOf(feature.kind)}
              onChange={(value) => apply(feature.kind, { [feature.kind]: value })}
              {...(feature.kind === "suggest" && status?.suggestions !== undefined
                ? {
                    detail: (
                      <p
                        data-testid="suggest-rate"
                        title={SUGGEST_RATE_TITLE}
                        className="text-xs text-muted-foreground tabular-nums"
                      >
                        {suggestRateLine(status.suggestions)}
                      </p>
                    ),
                  }
                : {})}
            />
          );
        })}
      </SettingsGroup>

      <SettingsGroup label={source === "gateway" ? "Gateway estimates" : "Usage"}>
        {source === "gateway" && (
          <BudgetField
            // A value saved elsewhere resets the draft.
            key={helperDailyBudgetUsd(settings)}
            value={helperDailyBudgetUsd(settings)}
            onSave={(dailyBudgetUsd) => apply("dailyBudgetUsd", { dailyBudgetUsd })}
            onReset={resetOf("dailyBudgetUsd")}
            saveError={errorOf("dailyBudgetUsd")}
          />
        )}
        <SettingRow
          label="Today"
          description={
            status === undefined
              ? "Loading today's use…"
              : `${source === "gateway" ? usageLine(status) : plural(status.calls, "call") + (status.failures > 0 ? ` · ${plural(status.failures, "failure")}` : "")}, since midnight UTC.`
          }
          detail={
            <div className="flex flex-col gap-1.5" data-testid="helper-usage">
              {source === "gateway" && pause !== undefined && (
                <p role="status" className="flex items-start gap-1.5 text-xs text-warning">
                  <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                  {pause}
                </p>
              )}
              {status !== undefined && (
                <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {usageByKind(status).map((line) => (
                    <li key={line.kind} className="flex gap-2">
                      <span className="w-24 shrink-0">{line.label}</span>
                      <span className="tabular-nums">
                        {source === "gateway" ? line.text : line.text.split(" · ")[0]}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          }
        />
      </SettingsGroup>
    </div>
  );
}

/** The daily budget in dollars, saved on blur or Enter. */
function BudgetField({
  value,
  onSave,
  onReset,
  saveError,
}: {
  value: number;
  onSave: (usd: number) => void;
  onReset: (() => void) | undefined;
  saveError: string | undefined;
}) {
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState<string>();
  const commit = () => {
    const usd = Number(draft.trim());
    if (draft.trim() === "" || !Number.isFinite(usd) || usd <= 0) {
      setInvalid("The gateway estimate limit must be more than $0.");
      return;
    }
    setInvalid(undefined);
    if (usd !== value) onSave(usd);
  };
  return (
    <SettingRow
      label="Gateway estimate limit"
      description="A daily cap on estimated gateway spend. Local subscription usage doesn't count."
      learnMore={
        <p>
          Estimates may differ from your provider&rsquo;s bill; set a spending limit with your
          provider. Past 80% only titles and what you&apos;re waiting on still run; at 100%
          everything stops until midnight UTC.
        </p>
      }
      keywords={["cost", "spend", "dollars", "limit"]}
      htmlFor="settings-helper-budget"
      onReset={onReset}
      error={invalid ?? saveError}
    >
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="text-muted-foreground">
          $
        </span>
        <input
          id="settings-helper-budget"
          className={cn(inputCls, "w-20 tabular-nums")}
          value={draft}
          inputMode="decimal"
          aria-invalid={invalid !== undefined}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      </span>
    </SettingRow>
  );
}

/** Stands for "no choice" in a select, whose values can't be empty. */
const NO_CHOICE = "\u0000default";
/** The fallback turned off, which is stored as `null`. */
const NO_FALLBACK = "\u0000none";

/** Why an effort is marked as not listed, under the picker while one is picked. */
const UNLISTED_EFFORT_NOTE =
  "The gateway lists no efforts for this model, so it may ignore the one picked or refuse it.";

/**
 * The efforts the helper's model takes over chat completions, as the composer and the roster read
 * them: none for a model without an effort setting, and the efforts a gateway at worst ignores,
 * each marked as not listed, for one nothing says about. `picked` stays offered while it is the
 * stored choice, so the picker never shows an effort it doesn't hold.
 */
export function helperEfforts(
  profile: GatewayProfile,
  model: string,
  picked: ReasoningVariant | undefined,
): {
  readonly options: ReadonlyArray<{ value: ReasoningVariant; label: string }>;
  unlisted: boolean;
} {
  const entry = profile.models.find((m) => m.id === model);
  const listed = entry === undefined ? undefined : gatewayEfforts(entry, "chat");
  const unlisted = listed === undefined;
  const values = listed ?? UNLISTED_GATEWAY_EFFORTS;
  const label = (value: ReasoningVariant) =>
    `${EFFORT_OPTIONS.find((o) => o.value === value)?.label ?? value}${unlisted ? " (not listed)" : ""}`;
  const options = values.map((value) => ({ value, label: label(value) }));
  if (picked !== undefined && !values.includes(picked)) {
    options.push({ value: picked, label: `${label(picked)} (not offered)` });
  }
  return { options, unlisted };
}

/** The profile's own primary pick, without its fallback. */
const helperModelOf = (profile: GatewayProfile) => ({
  ...(profile.helperModel === undefined ? {} : { helperModel: profile.helperModel }),
  ...(profile.helperEffort === undefined ? {} : { helperEffort: profile.helperEffort }),
});

/** A picked model as the profile stores it, for either slot. */
type SlotPick = { readonly model: string; readonly effort?: ReasoningVariant } | undefined | null;

/** `profile` with `slot` set to `pick`: absent for the default, `null` for no fallback. */
export const withPick = (profile: GatewayProfile, slot: "primary" | "fallback", pick: SlotPick) => {
  if (slot === "primary") {
    const { helperModel: _model, helperEffort: _effort, ...rest } = profile;
    return pick == null
      ? rest
      : {
          ...rest,
          helperModel: pick.model,
          ...(pick.effort === undefined ? {} : { helperEffort: pick.effort }),
        };
  }
  const { helperFallback: _fallback, ...rest } = profile;
  return pick === undefined ? rest : { ...rest, helperFallback: pick };
};

const HELPER_PICK_KEY = ["helper-pick"] as const;

type ContextScope = "off" | "opening" | "conversation";

/** Consent uses the same save queue as model picks, so whole-profile updates cannot race. */
export const saveHelperContext = (
  api: Pick<Api, "listProfiles" | "upsertProfile">,
  profile: GatewayProfile,
  scope: ContextScope,
): Promise<GatewayProfile> => {
  const next = profileSaves.then(async () => {
    const current = (await api.listProfiles()).find((p) => p.id === profile.id);
    if (current === undefined || current.baseURL !== profile.baseURL) {
      throw new Error("The gateway changed. Review its address before allowing context.");
    }
    const { helperContext: _consent, ...withoutConsent } = current;
    return api.upsertProfile({
      ...withoutConsent,
      ...(scope === "off" ? {} : { helperContext: { baseURL: profile.baseURL, scope } }),
    });
  });
  profileSaves = next.catch(() => undefined);
  return next;
};

function HelperContextPicker({ profile }: { profile: GatewayProfile }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Exclude<ContextScope, "off">>();
  const save = useMutation({
    mutationKey: HELPER_PICK_KEY,
    mutationFn: (scope: ContextScope) => saveHelperContext(api, profile, scope),
    onSuccess: async () => {
      setPending(undefined);
      await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
  const busy = useIsMutating({ mutationKey: HELPER_PICK_KEY }) > 0;
  const scope = helperContextAllowed(profile, "title") ? profile.helperContext!.scope : "off";
  return (
    <SettingRow
      label="Context permission"
      description={`What helpers may send to ${profile.name} (${hostOf(profile.baseURL)}), this address only.`}
      error={save.isError ? errorMessage(save.error) : undefined}
      detail={
        pending !== undefined ? (
          <div
            role="group"
            aria-label="Allow helper context"
            className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm"
          >
            <p {...{ [LONG_COPY]: "consent" }}>
              {pending === "opening"
                ? "Titles send your first message and the beginning of the agent's first answer."
                : "Helpers send conversation excerpts, plan and pull request context, and summaries of tool calls."}{" "}
              This can include private code and text from agents that do not use this gateway. The
              recipient is {profile.name} at {profile.baseURL}. Review its privacy and pricing
              policies before allowing this.
            </p>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => save.mutate(pending)}>
                Allow context
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setPending(undefined)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      <select
        aria-label="Helper context permission"
        className={inputCls}
        value={scope}
        disabled={busy}
        onChange={(event) => {
          const next = event.target.value as ContextScope;
          if (next === "off") {
            setPending(undefined);
            save.mutate(next);
          } else setPending(next);
        }}
      >
        <option value="off">No context (off)</option>
        <option value="opening">Opening messages for titles</option>
        <option value="conversation">Conversation context for all helpers</option>
      </select>
    </SettingRow>
  );
}

/** Saves `pick` into `slot` of `profile` as stored when the save's turn comes, after any before it. */
export const saveHelperPick = (
  api: Pick<Api, "listProfiles" | "upsertProfile">,
  profile: GatewayProfile,
  slot: "primary" | "fallback",
  pick: SlotPick,
): Promise<GatewayProfile> => {
  const next = profileSaves.then(async () => {
    const current = (await api.listProfiles()).find((p) => p.id === profile.id) ?? profile;
    return api.upsertProfile(withPick(current, slot, pick));
  });
  profileSaves = next.catch(() => undefined);
  return next;
};

/**
 * Which of the default gateway's models a helper slot runs on. An effort is offered with a picked
 * model only: the default carries its own, a kind's effort, and only models that take one should
 * be given one.
 */
function HelperModelPicker({
  profile,
  slot,
}: {
  profile: GatewayProfile;
  slot: "primary" | "fallback";
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationKey: HELPER_PICK_KEY,
    mutationFn: (pick: SlotPick) => saveHelperPick(api, profile, slot, pick),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["profiles"] }),
  });

  // Either slot's save holds both pickers until the saved profile is back, so nothing is picked
  // against a profile about to change.
  const saving = useIsMutating({ mutationKey: HELPER_PICK_KEY }) > 0;
  const picked =
    slot === "primary"
      ? profile.helperModel === undefined
        ? undefined
        : { model: profile.helperModel, effort: profile.helperEffort }
      : profile.helperFallback;
  const byDefault =
    slot === "primary"
      ? helperChoice({ models: profile.models })
      : helperFallbackChoice({ models: profile.models, ...helperModelOf(profile) });
  const nameOf = (id: string) => profile.models.find((m) => m.id === id)?.name ?? id;
  // A policy rather than a model, so it never reads as a second copy of the model it picks today.
  // Automatic falls back to one model only: absent until the gateway lists it, and none while it is
  // the model itself.
  const fallbackListed = profile.models.some(
    (m) => m.id === DEFAULT_HELPER_FALLBACK.model && gatewayModelUsable(m),
  );
  const defaultLabel =
    byDefault === undefined
      ? slot === "fallback"
        ? fallbackListed
          ? `Automatic — none, as ${nameOf(DEFAULT_HELPER_FALLBACK.model)} is the model`
          : `Automatic — none until ${DEFAULT_HELPER_FALLBACK.model} is listed`
        : "Automatic — no model listed yet"
      : byDefault.model === DEFAULT_HELPER.model ||
          byDefault.model === DEFAULT_HELPER_FALLBACK.model
        ? `Automatic — currently ${nameOf(byDefault.model)}, recommended`
        : `Automatic — currently ${nameOf(byDefault.model)}`;
  // Embeddings, OCR, speech and the like can't answer a helper's prompt either.
  const offered = profile.models.filter(gatewayModelUsable);
  const items = [
    { value: NO_CHOICE, label: defaultLabel },
    // Off is its own choice: automatic would start using a fallback the gateway lists later.
    ...(slot === "fallback" ? [{ value: NO_FALLBACK, label: "No fallback" }] : []),
    ...offered.map((model) => ({ value: model.id, label: model.name })),
    // A model picked earlier that discovery no longer lists is still the choice until changed.
    ...(picked != null && !offered.some((model) => model.id === picked.model)
      ? [{ value: picked.model, label: `No longer listed: ${picked.model}` }]
      : []),
  ];
  const policies = slot === "fallback" ? 2 : 1;
  const value = picked === null ? NO_FALLBACK : (picked?.model ?? NO_CHOICE);
  const effortChoice =
    picked == null ? undefined : helperEfforts(profile, picked.model, picked.effort);
  const efforts = [
    { value: NO_CHOICE, label: "Model's own effort" },
    ...(effortChoice?.options ?? []),
  ];
  const slotName = slot === "primary" ? "Helper model" : "Helper fallback";
  const [searchOpen, setSearchOpen] = useState(false);
  const pick = (next: string) =>
    save.mutate(next === NO_CHOICE ? undefined : next === NO_FALLBACK ? null : { model: next });
  // A gateway's alias can be longer than the row is wide: the picker ends it in an ellipsis, and
  // this says it whole.
  const shownLabel = items.find((item) => item.value === value)?.label;
  return (
    <div className="flex max-w-full min-w-0 flex-col items-end gap-1">
      <div className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">
        {items.length > MODEL_SEARCH_THRESHOLD ? (
          <ModelCombobox
            label={`${slotName} for ${profile.name}`}
            value={value}
            options={items}
            onChange={pick}
            open={searchOpen && !saving}
            onOpenChange={setSearchOpen}
            icon={undefined}
            title={shownLabel ?? slotName}
            description={undefined}
            labelled
            field
          />
        ) : (
          <Select
            disabled={saving}
            value={value}
            items={items}
            onValueChange={(next) => {
              if (next !== null) pick(next);
            }}
          >
            <SelectTrigger aria-label={`${slotName} for ${profile.name}`} title={shownLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((item, index) => (
                <Fragment key={item.value}>
                  {/* The policies first, then the models a pick pins by name. */}
                  {index === policies && index < items.length && <SelectSeparator />}
                  <SelectItem value={item.value}>{item.label}</SelectItem>
                </Fragment>
              ))}
            </SelectContent>
          </Select>
        )}
        {picked != null && efforts.length > 1 && (
          <Select
            disabled={saving}
            value={picked.effort ?? NO_CHOICE}
            items={efforts}
            onValueChange={(next) => {
              if (next === null) return;
              save.mutate({
                model: picked.model,
                ...(next === NO_CHOICE ? {} : { effort: next as ReasoningVariant }),
              });
            }}
          >
            <SelectTrigger aria-label={`${slotName} effort for ${profile.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {efforts.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {effortChoice?.unlisted === true && picked?.effort !== undefined && (
        <p
          data-testid="helper-effort-unlisted"
          className="text-right text-xs text-muted-foreground"
        >
          {UNLISTED_EFFORT_NOTE}
        </p>
      )}
      {save.error && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(save.error)}
        </p>
      )}
    </div>
  );
}
