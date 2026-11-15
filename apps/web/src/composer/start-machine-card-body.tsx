import { CircleCheck, Lock, Play } from "lucide-react";
import { useId, useState } from "react";

import { isComing, type OnDemandChoice, type OnDemandPhase, startOnDemand } from "@/api/on-demand";
import { Button } from "@/components/ui/button";
import { useMachineFacts, useMachineNoun, useMachineReachesTheirs } from "@/embed/store";
import { Spinner } from "@/motion";

import { needsMachine, useOnDemandMachine } from "./start-machine-card";

// Where the server's deployment starts machines on demand, a person with none of their own sees
// this under the composer in place of "no machine has joined": one action that starts theirs, the
// repositories it may use, and its start, step by step. Their draft stays as it is.

const STEPS: ReadonlyArray<{
  readonly phase: OnDemandPhase;
  readonly label: (noun: string) => string;
}> = [
  { phase: "booting", label: () => "Booting" },
  { phase: "joining", label: () => "Joining this workspace" },
];
const ORDER: Record<OnDemandPhase, number> = {
  starting: 0,
  booting: 1,
  joining: 2,
  ready: 3,
  stopping: 0,
  stopped: 0,
  failed: 0,
};

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/**
 * The choices this person changed from the provider's default, kept in this browser for the next
 * start. Only those are sent: a choice they left alone follows the provider's default, which may
 * change after this start. The key is new so that defaults kept as picks before are dropped.
 */
const PICKED_KEY = "gram:on-demand-picks";
const remembered = (): Record<string, string> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PICKED_KEY) ?? "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  } catch {
    return {};
  }
};
const remember = (picked: Readonly<Record<string, string>>) => {
  try {
    localStorage.setItem(PICKED_KEY, JSON.stringify(picked));
  } catch {
    // Not kept: the next start offers the defaults again.
  }
};

/** The remembered picks that can still be picked and differ from their choice's default. */
export const changedFor = (
  choices: ReadonlyArray<OnDemandChoice>,
  kept: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    choices.flatMap((choice) => {
      const wanted = kept[choice.id];
      const usable = choice.options.some((option) => option.id === wanted && option.available);
      return usable && wanted !== undefined && wanted !== choice.default
        ? [[choice.id, wanted]]
        : [];
    }),
  );

/** Each choice's pick: the one remembered where it can still be picked, else its default. */
export const pickedFor = (
  choices: ReadonlyArray<OnDemandChoice>,
  kept: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    choices.map((choice) => {
      const wanted = kept[choice.id];
      const usable = choice.options.some((option) => option.id === wanted && option.available);
      return [choice.id, usable && wanted !== undefined ? wanted : choice.default];
    }),
  );

/** One choice as a row of options; those this person may not pick are shown, locked, with why. */
function ChoiceRow({
  choice,
  value,
  onChange,
}: {
  readonly choice: OnDemandChoice;
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-meta text-muted-foreground">
        {choice.label}
        {choice.description !== undefined && ` · ${choice.description}`}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-1.5"
      >
        {choice.options.map((option) => {
          const picked = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={picked}
              disabled={!option.available}
              title={option.note}
              onClick={() => onChange(option.id)}
              className={[
                "flex flex-col items-start gap-0.5 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                picked
                  ? "border-primary bg-primary/5"
                  : "border-edge-group hover:border-edge-strong",
                option.available ? "" : "cursor-not-allowed opacity-60",
              ].join(" ")}
            >
              <span className="flex items-center gap-1 text-body">
                {!option.available && <Lock className="size-3" aria-hidden />}
                {option.label}
              </span>
              {(option.available ? option.detail : (option.note ?? option.detail)) !==
                undefined && (
                <span className="text-meta text-muted-foreground">
                  {option.available ? option.detail : (option.note ?? option.detail)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function StartMachineCardBody({
  repositories = [],
}: {
  /** Repositories to offer, checked: the ones this work is likely to need. */
  readonly repositories?: ReadonlyArray<string>;
}) {
  const noun = useMachineNoun();
  const facts = useMachineFacts();
  // Where it reaches all of theirs there is nothing to choose: Start starts it.
  const reachesTheirs = useMachineReachesTheirs();
  const { status, refresh } = useOnDemandMachine();
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState<ReadonlyArray<string>>(repositories);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [kept, setKept] = useState<Readonly<Record<string, string>>>(remembered);
  const titleId = useId();
  if (!needsMachine(status)) return null;
  const choices = status?.choices;
  const picks = choices === undefined ? {} : pickedFor(choices.choices, kept);
  const changed = choices === undefined ? {} : changedFor(choices.choices, kept);

  const progress = status?.progress;
  const coming = isComing(status);
  const failed = progress?.phase === "failed";
  const offered = [...new Set([...repositories, ...picked])];

  const start = async () => {
    setSending(true);
    setError(undefined);
    try {
      remember(changed);
      await startOnDemand(reachesTheirs ? [] : picked, changed);
      setChoosing(false);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  if (coming) {
    const at = ORDER[progress?.phase ?? "starting"];
    return (
      <section
        aria-labelledby={titleId}
        aria-live="polite"
        className="flex flex-col gap-3 rounded-lg border border-edge-group bg-surface-1 p-4"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 id={titleId} className="text-body-strong">
            Starting your {noun}
          </h3>
          <span className="text-meta text-muted-foreground">Usually under a minute</span>
        </div>
        <ol className="flex flex-col gap-2 text-meta" aria-label="Start progress">
          {STEPS.map((step) => {
            const done = at > ORDER[step.phase];
            return (
              <li key={step.phase} className="flex items-center gap-2">
                {done ? (
                  <CircleCheck className="size-4 text-success" aria-hidden />
                ) : at === ORDER[step.phase] ? (
                  <Spinner className="size-4" />
                ) : (
                  <span className="size-4" aria-hidden />
                )}
                <span className={done ? "" : "text-muted-foreground"}>{step.label(noun)}</span>
              </li>
            );
          })}
        </ol>
        {progress?.message !== undefined && (
          <p className="text-meta text-muted-foreground">{progress.message}</p>
        )}
        <p className="text-meta text-muted-foreground">
          You can leave this page. Your draft is kept, and work starts once it has joined.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-lg border border-edge-group bg-surface-1 p-4"
    >
      <h3 id={titleId} className="text-body-strong">
        {failed ? `Your ${noun} didn't start` : `Start a ${noun} to run this`}
      </h3>
      <p className="text-meta text-muted-foreground">
        {failed
          ? (progress?.message ?? "Nothing was left running, and your draft is kept.")
          : `Work runs on a ${noun} of your own. Only your threads run on it, and nothing runs here until it is up.`}
      </p>
      {facts.length > 0 && !failed && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted-foreground">
          {facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      )}
      {choices !== undefined && !failed && (
        <div className="flex flex-col gap-3" data-testid="on-demand-choices">
          {choices.choices.map((choice) => (
            <ChoiceRow
              key={choice.id}
              choice={choice}
              value={picks[choice.id] ?? choice.default}
              onChange={(id) => setKept({ ...kept, [choice.id]: id })}
            />
          ))}
          {choices.note !== undefined && (
            <p className="text-meta text-muted-foreground">{choices.note}</p>
          )}
        </div>
      )}
      {choosing && (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-meta text-muted-foreground">
            Repositories it may use, as you. Choose again later to add one.
          </legend>
          {offered.length > 0 && (
            <ul className="flex flex-col rounded-md border border-edge-group">
              {offered.map((repository) => (
                <li key={repository} className="border-b border-edge-group last:border-b-0">
                  <label className="flex items-center gap-2 px-3 py-2 text-body">
                    <input
                      type="checkbox"
                      checked={picked.includes(repository)}
                      onChange={(event) =>
                        setPicked((current) =>
                          event.target.checked
                            ? [...current, repository]
                            : current.filter((each) => each !== repository),
                        )
                      }
                    />
                    {repository}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const value = typed.trim();
              if (!REPOSITORY.test(value)) {
                setError("Name a repository as owner/name.");
                return;
              }
              setPicked((current) => [...new Set([...current, value])]);
              setTyped("");
              setError(undefined);
            }}
          >
            <label className="sr-only" htmlFor={`${titleId}-repository`}>
              Another repository
            </label>
            <input
              id={`${titleId}-repository`}
              className="h-8 min-w-0 flex-1 rounded-md border border-edge-group bg-transparent px-2 text-body"
              placeholder="owner/name"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
            <Button type="submit" size="sm" variant="ghost">
              Add
            </Button>
          </form>
        </fieldset>
      )}
      {error !== undefined && (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        {choosing ? (
          <>
            <Button type="button" size="sm" onClick={() => void start()} disabled={sending}>
              <Play className="size-3.5" aria-hidden />
              Start
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setChoosing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            disabled={sending}
            onClick={() => (reachesTheirs ? void start() : setChoosing(true))}
          >
            <Play className="size-3.5" aria-hidden />
            {failed ? "Try again" : `Start a ${noun}`}
          </Button>
        )}
      </div>
    </section>
  );
}
