import { Popover } from "@base-ui/react/popover";
import { Layers, Lock, RotateCw, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";

import { isComing, keepOnDemandPicks, type OnDemandChoice, startOnDemand } from "@/api/on-demand";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMachineNoun } from "@/embed/store";
import { cn } from "@/lib/utils";

import {
  changedFor,
  differsFromCurrent,
  isOwn,
  pickedFor,
  shortOf,
  useOnDemandPicks,
} from "./on-demand-picks";
import { useOnDemandMachine } from "./start-machine-card";

// The Runs on popover's body, loaded when it first opens so New's first paint stays small.

/** The most options a choice shows side by side; more go in a menu. */
const SIDE_BY_SIDE = 4;

/** One choice: its options side by side (or a menu), and whose value it is. */
function ChoiceField({
  choice,
  value,
  onPick,
  disabled,
}: {
  readonly choice: OnDemandChoice;
  readonly value: string;
  readonly onPick: (option: string) => void;
  readonly disabled: boolean;
}) {
  const labelId = useId();
  const own = isOwn(choice, value);
  return (
    <div className="grid grid-cols-[5.5rem_1fr] items-start gap-x-2.5 gap-y-1 max-sm:grid-cols-1">
      <span
        id={labelId}
        className="pt-1 text-meta text-muted-foreground"
        title={choice.description}
      >
        {choice.label}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        {choice.options.length <= SIDE_BY_SIDE ? (
          <div
            role="radiogroup"
            aria-labelledby={labelId}
            className="flex flex-wrap gap-0.5 rounded-md bg-accent/60 p-0.5"
          >
            {choice.options.map((option) => {
              const picked = option.id === value;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={picked}
                  aria-label={option.label}
                  disabled={disabled || !option.available}
                  title={option.available ? option.label : (option.note ?? option.label)}
                  onClick={() => onPick(option.id)}
                  className={cn(
                    "flex min-w-0 flex-1 flex-col items-start rounded-sm px-2 py-1 text-left text-meta transition-colors max-sm:min-h-11 max-sm:justify-center",
                    picked
                      ? "bg-background text-foreground shadow-raised ring-1 ring-border"
                      : "text-muted-foreground hover:text-foreground",
                    option.available
                      ? ""
                      : "cursor-not-allowed opacity-60 hover:text-muted-foreground",
                  )}
                >
                  <span className="flex items-center gap-1">
                    {!option.available && <Lock aria-hidden className="size-3" />}
                    {option.short ?? option.label}
                  </span>
                  {(option.available ? option.detail : (option.note ?? option.detail)) !==
                    undefined && (
                    <span className="truncate text-caption text-muted-foreground">
                      {option.available ? option.detail : (option.note ?? option.detail)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <Select
            value={value}
            items={choice.options.map((option) => ({ value: option.id, label: option.label }))}
            onValueChange={(next) => {
              if (typeof next === "string") onPick(next);
            }}
            disabled={disabled}
          >
            <SelectTrigger size="sm" aria-labelledby={labelId} className="h-7 text-meta">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choice.options.map((option) => (
                <SelectItem key={option.id} value={option.id} disabled={!option.available}>
                  {option.label}
                  {option.detail !== undefined && (
                    <span className="text-muted-foreground"> · {option.detail}</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {choice.fallback !== undefined && (
          <span className="flex flex-wrap items-center gap-x-1.5 text-caption text-muted-foreground">
            {own ? (
              <>
                <span className="text-primary">Yours</span>
                <span>· default is {shortOf(choice, choice.fallback)} ·</span>
                <button
                  type="button"
                  disabled={disabled}
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => onPick(choice.fallback!)}
                >
                  Use default
                </button>
              </>
            ) : (
              <span>Default</span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/** Every choice, whose each is, and how a change is used: start again, or keep as yours. */
export function RunsOnPanel({ onDone }: { readonly onDone: () => void }) {
  const noun = useMachineNoun();
  const { status, refresh } = useOnDemandMachine();
  const { picks, keep, pick, setKeep, clear } = useOnDemandPicks();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const offered = status?.choices;
  if (offered === undefined) return null;
  const { choices, keeps = false } = offered;
  const values = pickedFor(choices, picks);
  const changed = changedFor(choices, picks);
  const online = status?.machine?.online === true;
  const coming = isComing(status);
  const differs = online ? differsFromCurrent(choices, values) : [];
  const canReset =
    keeps &&
    choices.some((choice) => choice.fallback !== undefined && isOwn(choice, values[choice.id]!));

  const send = async (how: "restart" | "keep") => {
    setSending(true);
    setError(undefined);
    try {
      if (how === "restart")
        await startOnDemand([], changed, { keep: keeps && keep, restart: true });
      else await keepOnDemandPicks(changed);
      clear();
      await refresh();
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Layers aria-hidden className="size-icon-row text-muted-foreground" />
        <Popover.Title className="text-body-strong">Your {noun}</Popover.Title>
        <span className="text-meta text-muted-foreground">
          {coming
            ? "Starting"
            : online
              ? "Running"
              : status?.machine
                ? "Stopped"
                : "Not started yet"}
        </span>
      </div>
      {choices.map((choice) => (
        <ChoiceField
          key={choice.id}
          choice={choice}
          value={values[choice.id]!}
          disabled={sending || coming}
          onPick={(option) => pick(choice.id, option)}
        />
      ))}
      {offered.note !== undefined && (
        <p className="text-meta text-muted-foreground">{offered.note}</p>
      )}
      {error !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2 border-t border-edge pt-2.5">
        {differs.length > 0 ? (
          <>
            <p className="flex items-start gap-1.5 text-meta text-warning">
              <TriangleAlert aria-hidden className="mt-px size-icon-row shrink-0" />
              <span>
                Your {noun} starts again with{" "}
                {differs.map((choice) => shortOf(choice, values[choice.id]!)).join(", ")}. Its disk
                is kept, and threads on it carry on once it is back.
              </span>
            </p>
            {keeps && (
              <label className="flex items-center gap-2 text-meta">
                <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
                Keep as my default
              </label>
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={sending}
                onClick={() => void send("restart")}
              >
                <RotateCw aria-hidden className="size-3.5" />
                Start again with these
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={sending} onClick={clear}>
                Undo
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-meta text-muted-foreground">
              {online || coming
                ? keeps
                  ? "What you change is kept as yours until you reset it."
                  : "Change one to start it again with it."
                : `Used when your ${noun} starts.`}
            </span>
            {keeps &&
              Object.keys(changed).length > 0 &&
              (online || coming ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={sending}
                  onClick={() => void send("keep")}
                >
                  Keep as my default
                </Button>
              ) : (
                <label className="flex items-center gap-2 text-meta">
                  <input
                    type="checkbox"
                    checked={keep}
                    onChange={(e) => setKeep(e.target.checked)}
                  />
                  Keep as my default
                </label>
              ))}
          </div>
        )}
        {canReset && (
          <button
            type="button"
            disabled={sending || coming}
            className="self-end text-meta text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              for (const choice of choices)
                if (choice.fallback !== undefined) pick(choice.id, choice.fallback);
            }}
          >
            Reset all to defaults
          </button>
        )}
      </div>
    </>
  );
}
