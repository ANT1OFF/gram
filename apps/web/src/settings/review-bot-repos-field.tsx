import { listsRepo } from "@gram/contracts";
import { X } from "lucide-react";
import { useId, useState } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { parseRepo, withBotRepo } from "@/reviews/review-request-filters";
import { useBotRepoSuggestions } from "@/reviews/review-requests";

import { inputCls, WhyDisabled } from "./fields";

/**
 * The repositories "Wait for review bot" holds for, edited in place: each change saves at once.
 * Suggestions are repositories where a configured bot has reviewed something, not yet listed.
 */
export function ReviewBotReposField({
  repos,
  onChange,
}: {
  repos: readonly string[];
  onChange: (repos: string[]) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const suggestions = useBotRepoSuggestions().filter((repo) => !listsRepo(repos, repo));

  const add = () => {
    const repo = parseRepo(draft);
    if (repo === undefined) {
      setError("Type a repository as owner/name, or paste its GitHub URL.");
      return;
    }
    setError(undefined);
    setDraft("");
    onChange(withBotRepo(repos, repo));
  };

  return (
    <div className="flex flex-col gap-2" data-testid="review-bot-repos">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Repositories with a review bot
      </label>
      {repos.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {repos.map((repo) => (
            <li
              key={repo}
              className="flex h-6 items-center gap-0.5 rounded-md border border-border pr-0.5 pl-2 font-mono text-xs"
            >
              {repo}
              <Hint
                label={`Remove ${repo}`}
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${repo}`}
                    onClick={() => onChange(repos.filter((known) => known !== repo))}
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
          placeholder="owner/name"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-invalid={error !== undefined}
          onChange={(event) => {
            setError(undefined);
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add();
          }}
        />
        <WhyDisabled reason={draft.trim() === "" ? "Type a repository first." : undefined}>
          <Button variant="outline" disabled={draft.trim() === ""} onClick={add}>
            Add
          </Button>
        </WhyDisabled>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {suggestions.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1"
          data-testid="review-bot-repo-suggestions"
        >
          <span className="text-xs text-muted-foreground">A bot has reviewed in</span>
          {suggestions.map((repo) => (
            <Button
              key={repo}
              size="xs"
              variant="outline"
              aria-label={`Add ${repo}`}
              className="font-mono"
              onClick={() => onChange(withBotRepo(repos, repo))}
            >
              + {repo}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
