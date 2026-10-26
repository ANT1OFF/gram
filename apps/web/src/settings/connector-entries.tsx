import { connectorEntryProblem } from "@gram/contracts";
import { X } from "lucide-react";
import { useId, useState } from "react";

import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";

import { inputCls, WhyDisabled } from "./fields";

/** A connector the user can pick instead of typing it: what an entry says, and what it is. */
export interface ConnectorSuggestion {
  /** The entry it adds: a server's name, or a claude.ai connector's address. */
  readonly entry: string;
  /** What the picker shows beside it, such as the name a connector's address belongs to. */
  readonly label?: string | undefined;
}

/**
 * A list of connector entries edited in place: each change saves the whole list at once. An entry
 * is a server's name, or a URL pattern for a claude.ai connector, which Claude Code matches by
 * address rather than by the name it shows. `suggestions` fill the input's picker; anything else
 * can be typed.
 */
export function ConnectorEntries({
  id,
  entries,
  onChange,
  suggestions = [],
  disabled = false,
  testId,
}: {
  /** The input's id, for the label of the field around it. */
  id: string;
  entries: readonly string[];
  /** Saves the whole list; settles once the server has it. */
  onChange: (entries: string[]) => Promise<unknown>;
  suggestions?: readonly ConnectorSuggestion[];
  disabled?: boolean;
  testId?: string;
}) {
  const listId = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  // Each edit replaces the whole list, so none starts from a list whose save hasn't landed yet.
  const [saving, setSaving] = useState(false);
  const entry = draft.trim();
  const busy = saving || disabled;
  const offered = suggestions.filter((suggestion) => !entries.includes(suggestion.entry));

  /** Saves `next`; `added` is the draft it adds, cleared once saved unless it was typed over. */
  const save = (next: string[], added?: string) => {
    setError(undefined);
    setSaving(true);
    onChange(next)
      .then(() => {
        if (added !== undefined) setDraft((current) => (current.trim() === added ? "" : current));
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setSaving(false));
  };

  const add = () => {
    const problem = connectorEntryProblem(entry);
    if (problem !== undefined) {
      setError(problem);
      return;
    }
    if (entries.includes(entry)) setDraft("");
    else save([...entries, entry], entry);
  };

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      {entries.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {entries.map((known) => (
            <li
              key={known}
              className="flex h-6 items-center gap-0.5 rounded-md border border-border pr-0.5 pl-2 font-mono text-xs"
            >
              {known}
              <Hint
                label={`Remove ${known}`}
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${known}`}
                    disabled={busy}
                    onClick={() => save(entries.filter((each) => each !== known))}
                  />
                }
              >
                <X />
              </Hint>
            </li>
          ))}
        </ul>
      )}
      <div className="flex max-w-md gap-1.5">
        <input
          id={id}
          className={`${inputCls} font-mono`}
          value={draft}
          placeholder="name or https://…"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          list={offered.length === 0 ? undefined : listId}
          aria-invalid={error !== undefined}
          onChange={(event) => {
            setError(undefined);
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || entry === "" || busy) return;
            event.preventDefault();
            add();
          }}
        />
        {offered.length > 0 && (
          <datalist id={listId}>
            {offered.map((suggestion) => (
              <option key={suggestion.entry} value={suggestion.entry}>
                {suggestion.label}
              </option>
            ))}
          </datalist>
        )}
        <WhyDisabled
          reason={
            entry === "" ? "Type a connector first." : saving ? "Saving the list…" : undefined
          }
        >
          <Button variant="outline" disabled={entry === "" || busy} onClick={add}>
            Add
          </Button>
        </WhyDisabled>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
