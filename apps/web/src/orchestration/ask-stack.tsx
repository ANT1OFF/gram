import {
  helperOn,
  type MemoryQuestion,
  type ThreadId,
  type WorkerQuestion,
  type WorkspaceId,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, ListChecks, MessageCircleQuestion, ShieldQuestion } from "lucide-react";
import * as m from "motion/react-m";
import { useMemo, useRef } from "react";

import { useApi } from "@/api/context";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatKeys } from "@/keyboard/registry";
import { useMotionLevel, usePresetTransition } from "@/motion";
import { useServerSettings } from "@/settings-sync/store";
import { useLayoutStore } from "@/stores/layout";
import { OptionGallery } from "@/thread/mock-visuals";

import { AskChoices, MoreText, plainHint, SendAnswer } from "./ask-choices";
import {
  answerRule,
  replyChips,
  type Ask,
  type AskMember,
  choiceLayout,
  type AskOption,
} from "./ask-model";
import { useAskStackStore } from "./ask-stack-store";
import { useDerivedAsks } from "./needs-you-store";

export interface WorkspaceAsks {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly orchestratorThreadId: ThreadId | undefined;
  /** What the stack shows: held, sending and just-sent answers taken out. */
  readonly asks: readonly Ask[];
}

/**
 * Every workspace's asks, read live from its threads and its open questions, as the board reads
 * its own. The sidebar's count, every orchestrator's stack and Quiet read this one list, which
 * `useDerivedAsks` derives once for the window. Asks put away for Later are left out unless
 * `withLater`, which Needs you passes to list them apart.
 */
export function useWorkspaceAsks({
  withLater = false,
}: { withLater?: boolean } = {}): readonly WorkspaceAsks[] {
  return useDerivedAsks((s) => (withLater ? s.withLater : s.asks));
}

/** A workspace's open questions its asks still hold, its own and its workers' forwarded ones. */
export interface AskedQuestions {
  readonly questions: readonly MemoryQuestion[];
  readonly workerQuestions: readonly WorkerQuestion[];
}

const NO_QUESTIONS: AskedQuestions = { questions: [], workerQuestions: [] };

/** The open questions of `asks`: what is answered, held or set aside is already gone from them. */
export const askedQuestions = (asks: readonly Ask[]): AskedQuestions => ({
  questions: asks.flatMap((ask) => (ask.memory === undefined ? [] : [ask.memory.question])),
  workerQuestions: asks.flatMap((ask) => (ask.worker === undefined ? [] : [ask.worker.question])),
});

/**
 * `workspaceId`'s open questions as its stack still asks them: the Board's band, the orchestrator's
 * banner and the workspace's status count these, so an answered or snoozed one leaves them all.
 */
export function useAskedQuestions(workspaceId: WorkspaceId | undefined): AskedQuestions {
  const asks = useDerivedAsks((s) => s.asks.find((w) => w.workspaceId === workspaceId)?.asks);
  return useMemo(() => (asks === undefined ? NO_QUESTIONS : askedQuestions(asks)), [asks]);
}

/** What the sidebar's count says: every workspace's asks, and the one to open first. */
export const askTotals = (
  all: readonly WorkspaceAsks[],
): { readonly count: number; readonly first: WorkspaceAsks | undefined } => ({
  count: all.reduce((sum, w) => sum + w.asks.length, 0),
  first: all.find((w) => w.asks.length > 0),
});

const ICON = { approval: ShieldQuestion, question: MessageCircleQuestion, plan: ListChecks };

/** Opens a thread in the grid and goes there, as a sidebar row would. */
export function useOpenThread() {
  const navigate = useNavigate();
  return (threadId: ThreadId) => {
    useLayoutStore.getState().openThread(threadId);
    void navigate({ to: "/t/$threadId", params: { threadId } });
  };
}

/** The reply field of a question answered in words, with the helper's drafts as chips. */
export function ReplyField({
  ask,
  current,
  onSend,
  inputRef,
  hint,
}: {
  ask: Ask;
  current: boolean;
  onSend: (text: string) => void;
  inputRef: (element: HTMLInputElement | null) => void;
  /** The key Send answer takes, when keys reach it: ⏎ in the field. */
  hint?: string | undefined;
}) {
  const api = useApi();
  const id = ask.ids[0] ?? ask.key;
  // Kept outside the ask, so stepping away or undoing doesn't lose what was typed.
  const text = useAskStackStore((s) => s.replies[id] ?? "");
  const setText = (value: string) => useAskStackStore.getState().setReply(id, value);
  const own = useRef<HTMLInputElement | null>(null);
  const helpers = useServerSettings((s) =>
    s.settings !== undefined && helperOn(s.settings, "suggest")
      ? JSON.stringify(s.settings.helpers ?? {})
      : undefined,
  );
  const request = ask.freeForm?.request;
  // Off or not allowed, there is nothing to show: no chips and no placeholder for them. Asked
  // again once the helpers' settings change, as with a consent given since.
  const { data: replies = [] } = useQuery({
    queryKey: [
      "request-replies",
      request?.threadId,
      request?.requestId,
      ask.group?.entries[0].request,
      helpers,
    ],
    queryFn: () => api.requestReplies(request!.threadId, request!.requestId),
    enabled: helpers !== undefined && current && request !== undefined,
    staleTime: (query) => ((query.state.data?.length ?? 0) > 0 ? Infinity : 30_000),
    retry: false,
  });
  const chips = helpers === undefined ? [] : replyChips(replies);
  const submit = () => {
    const reply = text.trim();
    if (reply !== "") onSend(reply);
  };
  return (
    <div className="mt-1.5 grid gap-1.5">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1" aria-label="Suggested replies">
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              data-testid="ask-reply-chip"
              onClick={() => {
                setText(chip);
                own.current?.focus();
              }}
              className="rounded-full border border-border px-2 py-0.5 text-meta text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {chip}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          ref={(element) => {
            own.current = element;
            inputRef(element);
          }}
          data-testid="ask-reply-input"
          aria-label={`Reply: ${ask.lead}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Reply"
          className="h-7 min-w-0 flex-1 rounded-(--radius-md) border border-border bg-transparent px-2 text-reading outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <SendAnswer
          type="submit"
          testId="ask-reply-send"
          disabled={text.trim() === ""}
          hint={current ? hint : undefined}
        />
      </form>
    </div>
  );
}

const DETAIL_TEXT =
  "overflow-x-auto rounded-(--radius-sm) bg-muted/50 p-2 font-mono text-caption break-words whitespace-pre-wrap";

/** Everything an Allow covers that the ask's lines don't: where each member runs, the whole input. */
function AskDetailsBody({ ask, where }: { ask: Ask; where: readonly AskMember[] }) {
  return (
    <div className="mt-1 grid gap-1.5 text-meta">
      {where.length > 0 && (
        <ul className="grid gap-0.5 text-muted-foreground">
          {where.map((member) => (
            <li
              key={`${member.title}\0${member.checkout?.path}`}
              data-testid="ask-member"
              className="min-w-0 break-all"
            >
              <span className="text-foreground">{member.title}</span>
              {member.project !== undefined && ` · ${member.project}`}
              <span className="font-mono">
                {" "}
                · {member.checkout?.path}
                {member.checkout?.branch !== undefined && ` (${member.checkout.branch})`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {ask.details?.kind === "json" && <pre className={DETAIL_TEXT}>{ask.details.text}</pre>}
      {ask.details?.kind === "spawn" && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {ask.details.fields.map((field) => (
              <div key={field.label} className="contents">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="min-w-0 break-words">{field.value}</dd>
              </div>
            ))}
          </dl>
          {ask.details.scope.length > 0 && (
            <p className="font-mono text-caption">{ask.details.scope.join(", ")}</p>
          )}
          <pre className={DETAIL_TEXT}>{ask.details.brief}</pre>
        </>
      )}
      {ask.details?.kind === "issue" && <pre className={DETAIL_TEXT}>{ask.details.body}</pre>}
    </div>
  );
}

/**
 * Where each member runs and the whole input, behind Details; `open` shows them without the fold,
 * as a detail pane does.
 */
export function AskDetails({ ask, open = false }: { ask: Ask; open?: boolean }) {
  const where = ask.members.filter((member) => member.checkout !== undefined);
  if (where.length === 0 && ask.details === undefined) return null;
  if (open) {
    return (
      <div data-testid="ask-details-body">
        <AskDetailsBody ask={ask} where={where} />
      </div>
    );
  }
  return (
    <Collapsible className="mt-1">
      <CollapsibleTrigger
        data-testid="ask-details"
        className="group flex items-center gap-1 text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 transition-transform duration-(--dur-fast) group-data-[panel-open]:rotate-90"
        />
        Details
      </CollapsibleTrigger>
      <CollapsibleContent data-testid="ask-details-body" className="gram-collapse">
        <AskDetailsBody ask={ask} where={where} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Which keys answer now: plain ones, the composer's modifiers, or none while focus types elsewhere. */
type KeyHints = "plain" | "composer" | undefined;

const hintOf = (hints: KeyHints, index: number): string | undefined => {
  if (hints === undefined || index > 8) return undefined;
  return hints === "plain" ? plainHint(index) : formatKeys(`alt+${index + 1}`);
};

/** What sends the picked choice: ⌘⏎, in the open and in an empty composer alike. */
const SEND_KEYS = "mod+enter";

export function AskItem({
  ask,
  current,
  hints,
  arrived,
  problem,
  picked,
  onPick,
  onChoose,
  onReply,
  replyRef,
}: {
  ask: Ask;
  current: boolean;
  hints: KeyHints;
  arrived: boolean;
  problem: string | undefined;
  /** The choice picked and not sent yet. */
  picked: number | undefined;
  onPick: (index: number) => void;
  onChoose: (option: AskOption) => void;
  onReply: (text: string) => void;
  replyRef: (element: HTMLInputElement | null) => void;
}) {
  const level = useMotionLevel();
  const spring = usePresetTransition("gentle");
  const Icon = ICON[ask.icon];
  const rise = arrived && level === "full";
  const pick = answerRule(ask.options) === "pick";
  const sendHint = current && hints !== undefined ? formatKeys(SEND_KEYS) : undefined;
  const pickedOption = picked === undefined ? undefined : ask.options[picked];
  return (
    <m.div
      initial={rise ? { y: 14 } : false}
      animate={{ y: 0 }}
      transition={spring}
      data-testid="ask-item"
      data-ask-key={ask.key}
      data-current={current || undefined}
      // Focusable from a jump (the overview's "asks you"), where the stack's plain keys answer it.
      tabIndex={-1}
      // In a narrow chat (a worker kept beside it), the answers wrap under the question rather than
      // squeeze it to a letter a line.
      className="flex flex-wrap items-start gap-2.5 px-3.5 pt-1 pb-2.5 outline-none"
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-status-needs-mark" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-reading break-words" data-testid="ask-title">
          {ask.lead}
          {ask.command !== undefined && (
            <>
              {" "}
              <code
                data-testid="ask-command"
                title={ask.command}
                className="inline font-mono text-body break-all"
              >
                {ask.command}
              </code>
            </>
          )}
          {ask.count > 1 && <span className="text-muted-foreground"> × {ask.count}</span>}
        </p>
        {ask.extras.length > 0 && (
          <p
            data-testid="ask-extras"
            className="font-mono text-caption break-all text-muted-foreground"
          >
            {ask.extras.map((field, index) => (
              <span key={field.label}>
                {index > 0 && " · "}
                {field.label}: <span className="text-foreground">{field.value}</span>
              </span>
            ))}
          </p>
        )}
        <p className="truncate text-meta text-muted-foreground" data-testid="ask-context">
          {ask.context}
        </p>
        {ask.description !== undefined && ask.description.trim() !== "" && (
          <MoreText
            text={ask.description}
            lines={2}
            testId="ask-description"
            className="text-meta text-muted-foreground"
          />
        )}
        <AskDetails ask={ask} />
        {ask.freeForm !== undefined && (
          <ReplyField
            ask={ask}
            current={current}
            onSend={onReply}
            inputRef={replyRef}
            hint={hints === undefined ? undefined : "⏎"}
          />
        )}
        {problem !== undefined && (
          <p role="alert" data-testid="ask-problem" className="mt-1 text-meta text-destructive">
            {problem}
          </p>
        )}
      </div>
      {/* Each option's screenshot and "Open mock", above the options they show. */}
      {ask.visuals !== undefined && (
        <OptionGallery
          threadId={ask.visuals.threadId}
          options={ask.visuals.options}
          recommended={ask.visuals.recommended}
          mock={ask.visuals.mock}
          className="basis-full pl-6.5"
        />
      )}
      {ask.options.length > 0 && (
        <AskChoices
          options={ask.options}
          hintOf={(index) =>
            !current
              ? undefined
              : // A verb picked by its key is sent by ⌘⏎: its hint says so.
                !pick && index === picked && sendHint !== undefined
                ? sendHint
                : hintOf(hints, index)
          }
          onChoose={onChoose}
          picked={picked}
          onPick={onPick}
          testId="ask-option"
          rest="ghost"
          // Choices go under the question, with Send answer after them; a row of verbs sits to
          // the right of the question while it fits.
          className={
            pick || choiceLayout(ask.options) === "list"
              ? "basis-full pl-6.5"
              : "ml-auto justify-end"
          }
        >
          {pick && (
            <SendAnswer
              testId="ask-send"
              disabled={pickedOption === undefined}
              title={pickedOption === undefined ? "Pick a choice first" : undefined}
              hint={sendHint}
              onSend={() => {
                if (pickedOption !== undefined) onChoose(pickedOption);
              }}
            />
          )}
        </AskChoices>
      )}
    </m.div>
  );
}
