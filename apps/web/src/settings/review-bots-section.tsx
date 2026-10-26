import { DEFAULT_REVIEW_BOTS, reviewBotsOf, type ReviewBot } from "@gram/contracts";
import { useState } from "react";

import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { useServerSettings } from "@/settings-sync/store";

import { Field, inputCls, Toggle, WhyDisabled } from "./fields";
import { validateReviewBots, type ReviewBotDraft } from "./review-bots";
import { useSaveSettings } from "./use-save-settings";

/** The drafts as they'd be saved, for comparing with the stored list. */
const plain = (list: ReadonlyArray<ReviewBotDraft>) =>
  JSON.stringify(list.map(({ key: _key, ...bot }) => bot));

let nextKey = 0;
const toDrafts = (bots: ReadonlyArray<ReviewBot>): ReviewBotDraft[] =>
  bots.map((bot) => ({ ...bot, key: `bot-${nextKey++}` }));

/** Settings → Review bots: which PR reviewers the app follows and how to ask them for a round. */
export function ReviewBotsSection() {
  const settings = useServerSettings((s) => s.settings);
  const [status, setStatus] = useState<string>();
  if (!settings) return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  const saved = reviewBotsOf(settings);
  return (
    <ReviewBotsEditor
      // A save from elsewhere resets the drafts.
      key={JSON.stringify(saved)}
      saved={saved}
      status={status}
      onStatus={setStatus}
    />
  );
}

function ReviewBotsEditor({
  saved,
  status,
  onStatus,
}: {
  saved: ReadonlyArray<ReviewBot>;
  status: string | undefined;
  onStatus: (status: string | undefined) => void;
}) {
  const save = useSaveSettings();
  const [drafts, setDrafts] = useState(() => toDrafts(saved));
  const [rows, setRows] = useState<ReadonlyArray<string | undefined>>([]);
  const [error, setError] = useState<string>();

  const dirty = plain(drafts) !== JSON.stringify(saved);

  const update = (key: string, patch: Partial<ReviewBotDraft>) => {
    onStatus(undefined);
    setDrafts((list) => list.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  };

  const submit = async () => {
    setError(undefined);
    const result = validateReviewBots(drafts);
    setRows(result.rows);
    if (result.bots === undefined) return;
    try {
      await save({ reviewBots: result.bots });
      onStatus("Review bots saved.");
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="review-bots">
      {drafts.length === 0 && (
        <p className="text-muted-foreground">
          No external review bots configured. Human reviews are still tracked. Merge review policies
          are in Workspaces.
        </p>
      )}
      <ul className="flex flex-col gap-3 empty:hidden">
        {drafts.map((draft, i) => (
          <li
            key={draft.key}
            aria-label={`Review bot ${i + 1}`}
            className="flex flex-col gap-3 rounded-md border border-border p-3"
          >
            <Field label="Login pattern" htmlFor={`${draft.key}-login`}>
              <input
                id={`${draft.key}-login`}
                className={inputCls}
                value={draft.loginPattern}
                placeholder="example-code-review[bot]"
                spellCheck={false}
                onChange={(event) => update(draft.key, { loginPattern: event.target.value })}
              />
            </Field>
            <Field
              label="Re-review command"
              description="Posted as a PR comment to ask for another round."
              htmlFor={`${draft.key}-command`}
            >
              <input
                id={`${draft.key}-command`}
                className={inputCls}
                value={draft.rereviewCommand}
                placeholder="/agent review"
                spellCheck={false}
                onChange={(event) => update(draft.key, { rereviewCommand: event.target.value })}
              />
            </Field>
            <Toggle
              label="Can approve"
              description="Approves or requests changes. Off for a bot that only leaves comments."
              checked={draft.canApprove}
              onChange={(canApprove) => update(draft.key, { canApprove })}
            />
            {rows[i] && (
              <p role="alert" className="text-destructive">
                {rows[i]}
              </p>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => {
                onStatus(undefined);
                setRows([]);
                setDrafts((list) => list.filter((item) => item.key !== draft.key));
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            onStatus(undefined);
            setDrafts((list) => [
              ...list,
              ...toDrafts([{ loginPattern: "", rereviewCommand: "", canApprove: false }]),
            ]);
          }}
        >
          Add bot
        </Button>
        <WhyDisabled reason={dirty ? undefined : "Nothing to save: no changes yet."}>
          <Button size="sm" disabled={!dirty} onClick={() => void submit()}>
            Save
          </Button>
        </WhyDisabled>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onStatus(undefined);
            setRows([]);
            setDrafts(toDrafts(DEFAULT_REVIEW_BOTS));
          }}
        >
          Use defaults
        </Button>
      </div>
      {status && (
        <p role="status" className="gram-fade text-muted-foreground">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
