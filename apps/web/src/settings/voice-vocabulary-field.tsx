import type { VocabularyEntry } from "@gram/contracts";
import { X } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { inputCls, WhyDisabled } from "./fields";
import { withVocabularyEntry } from "./voice-vocabulary-model";

/** The user's dictation words, edited in place: each change saves at once. */
export function VoiceVocabularyField({
  entries,
  onChange,
  disabled = false,
}: {
  entries: readonly VocabularyEntry[];
  onChange: (entries: VocabularyEntry[]) => void;
  disabled?: boolean;
}) {
  const termId = useId();
  const heardId = useId();
  const [term, setTerm] = useState("");
  const [heard, setHeard] = useState("");
  const [error, setError] = useState<string>();

  const add = () => {
    const edit = withVocabularyEntry(entries, term, heard);
    if (!edit.ok) {
      setError(edit.message);
      return;
    }
    setError(undefined);
    setTerm("");
    setHeard("");
    onChange(edit.entries);
  };
  const onEnter = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    add();
  };

  return (
    <div className="flex flex-col gap-2" data-testid="voice-vocabulary-list">
      {entries.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {entries.map((entry) => (
            <li key={entry.term} className="flex min-h-8 items-center gap-2 py-1 pr-1 pl-2.5">
              <span className="font-mono text-xs">{entry.term}</span>
              {entry.soundsLike !== undefined && entry.soundsLike.length > 0 && (
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  heard as {entry.soundsLike.map((spelling) => `“${spelling}”`).join(", ")}
                </span>
              )}
              <Hint
                label={`Remove ${entry.term}`}
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="ms-auto"
                    aria-label={`Remove ${entry.term}`}
                    disabled={disabled}
                    onClick={() => onChange(entries.filter((known) => known.term !== entry.term))}
                  />
                }
              >
                <X />
              </Hint>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor={termId} className="sr-only">
          Word
        </label>
        <input
          id={termId}
          className={cn(inputCls, "w-44 font-mono")}
          value={term}
          placeholder="Word, as written"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          aria-invalid={error !== undefined}
          onChange={(event) => {
            setError(undefined);
            setTerm(event.target.value);
          }}
          onKeyDown={onEnter}
        />
        <label htmlFor={heardId} className="sr-only">
          Sounds like
        </label>
        <input
          id={heardId}
          className={cn(inputCls, "w-64 max-w-full")}
          value={heard}
          placeholder="Sounds like, comma-separated"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          onChange={(event) => {
            setError(undefined);
            setHeard(event.target.value);
          }}
          onKeyDown={onEnter}
        />
        <WhyDisabled reason={term.trim() === "" ? "Type a word first." : undefined}>
          <Button variant="outline" disabled={disabled || term.trim() === ""} onClick={add}>
            Add
          </Button>
        </WhyDisabled>
      </div>
      {error !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
