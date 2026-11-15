import { CircleCheck, Play } from "lucide-react";
import { useId, useState } from "react";

import { isComing, type OnDemandPhase, startOnDemand } from "@/api/on-demand";
import { Button } from "@/components/ui/button";
import { useMachineFacts, useMachineNoun, useMachineReachesTheirs } from "@/embed/store";
import { Spinner } from "@/motion";

import { changedFor, pickedFor, shortOf, useOnDemandPicks } from "./on-demand-picks";
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
  const { picks: kept, keep, clear } = useOnDemandPicks();
  const titleId = useId();
  if (!needsMachine(status)) return null;
  const choices = status?.choices;
  const picks = choices === undefined ? {} : pickedFor(choices.choices, kept);
  // Only what differs from a default is sent: one left alone follows the deployment's default.
  const changed = choices === undefined ? {} : changedFor(choices.choices, kept);
  const keeps = choices?.keeps === true;

  const progress = status?.progress;
  const coming = isComing(status);
  const failed = progress?.phase === "failed";
  const offered = [...new Set([...repositories, ...picked])];

  const start = async () => {
    setSending(true);
    setError(undefined);
    try {
      await startOnDemand(reachesTheirs ? [] : picked, changed, { keep: keeps && keep });
      clear();
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
        <p className="text-meta text-muted-foreground" data-testid="on-demand-choices">
          {`As Runs on says: ${choices.choices.map((choice) => shortOf(choice, picks[choice.id] ?? choice.default)).join(" · ")}.`}
          {choices.note !== undefined && ` ${choices.note}`}
        </p>
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
