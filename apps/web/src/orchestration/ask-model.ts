import {
  approvalSubject,
  type Checkout,
  type MemoryQuestion,
  type PendingRequest,
  type QuestionChoice,
  type RequestAnswer,
  type RequestId,
  type ThreadId,
  type WorkerQuestion,
  type WorkspaceId,
} from "@gram/contracts";

import {
  appToolSummary,
  approvalDetails,
  limitPauseAsk,
  approvalExtras,
  mustReadDetails,
  type ApprovalDetailField,
  type ApprovalDetails,
} from "@/thread/request-model";

import type { InboxEntry, InboxGroup } from "./inbox-model";

// The ask stack: a workspace's open requests, the orchestrator's open questions and the workers'
// questions forwarded to the user as one list of asks, each answerable in a key. Built from the
// inbox's groups, so equal approvals stay one ask. No React.

/** What choosing an option does. */
export type AskAction =
  /** Every member of the group, through `answerGroup`. */
  | { readonly kind: "group"; readonly decision: "allow" | "deny" }
  /** The one request's own answer. */
  | { readonly kind: "answer"; readonly answer: RequestAnswer }
  /** An orchestrator's open question, answered with these words. */
  | { readonly kind: "memory"; readonly answer: string }
  /** A worker's question forwarded to the user, answered with these words, straight to the worker. */
  | { readonly kind: "worker"; readonly answer: string }
  /** Answered where it can be read in full: the asking thread. */
  | { readonly kind: "open"; readonly threadId: ThreadId }
  /** Answered on the board's questions, where several choices can be picked. */
  | { readonly kind: "board"; readonly workspaceId: WorkspaceId };

export interface AskOption {
  readonly label: string;
  /** What the undo line says once it is chosen. */
  readonly done: string;
  readonly action: AskAction;
  /** What choosing it means, as the asker put it. */
  readonly description?: string | undefined;
  /** The asker's own pick. */
  readonly recommended?: boolean | undefined;
}

/** Past this, a label no longer sits in a row of buttons. */
export const ROW_LABEL_MAX = 20;

/**
 * How options read best: a row of buttons for a few short ones, or a list, one a line with its
 * description under it, for many, long or described ones, so none is ever cut off.
 */
export const choiceLayout = (options: readonly AskOption[]): "row" | "list" =>
  options.length > 3 ||
  options.some((option) => option.description !== undefined || option.label.length > ROW_LABEL_MAX)
    ? "list"
    : "row";

const describe = (description: string | undefined): string | undefined =>
  description === undefined || description.trim() === "" ? undefined : description.trim();

/** An orchestrator's open question, as the stack answers it. */
export interface MemoryAsk {
  readonly workspaceId: WorkspaceId;
  readonly question: MemoryQuestion;
}

/** A worker's question forwarded to the user (`ask_question`), as the stack answers it. */
export interface WorkerQuestionAsk {
  readonly workspaceId: WorkspaceId;
  readonly question: WorkerQuestion;
}

export interface AskMember {
  readonly title: string;
  readonly project?: string | undefined;
  readonly checkout?: Pick<Checkout, "path" | "branch"> | undefined;
}

/** A question's pictures, as the stack shows them above its choices. */
export interface AskVisuals {
  /** The thread that asked, whose folders they are in and whose Preview opens them. */
  readonly threadId: ThreadId;
  readonly options: readonly QuestionChoice[];
  readonly recommended?: string | undefined;
  readonly mock?: string | undefined;
}

/** A question's pictures when it has any: an option's screenshot or mock page, or the mock. */
const visualsOf = (
  threadId: ThreadId | undefined,
  options: readonly QuestionChoice[],
  recommended: string | undefined,
  mock: string | undefined,
): AskVisuals | undefined =>
  threadId === undefined ||
  (mock === undefined &&
    !options.some((option) => option.image !== undefined || option.preview !== undefined))
    ? undefined
    : { threadId, options, recommended, mock };

export interface Ask {
  /** Its holds' ids, joined: an ask that loses or gains a member is another ask. */
  readonly key: string;
  /** What an answer holds back and hides: its requests' ids, or the question's. */
  readonly ids: readonly string[];
  readonly group?: InboxGroup | undefined;
  readonly memory?: MemoryAsk | undefined;
  readonly worker?: WorkerQuestionAsk | undefined;
  readonly icon: "approval" | "question" | "plan";
  /** Words before `command`, or the whole title when there is none. */
  readonly lead: string;
  /** The exact command, path or URL, shown whole; never paraphrased. */
  readonly command?: string | undefined;
  /** The input's other arguments, which the same Allow covers. */
  readonly extras: readonly ApprovalDetailField[];
  readonly description?: string | undefined;
  /** Each option's screenshot and "Open mock", and "Open mocks", for a question with pictures. */
  readonly visuals?: AskVisuals | undefined;
  /** The whole input, behind Details, when there is more to it than `command` and `extras`. */
  readonly details?: ApprovalDetails | undefined;
  /** Who asks and where an allowed command runs, behind Details. */
  readonly members: readonly AskMember[];
  /** "× 3" after the command for a group. */
  readonly count: number;
  /** The feature, then who asks. */
  readonly context: string;
  /** In key order: Enter takes the first, 1 and 2 pick by number. */
  readonly options: readonly AskOption[];
  /** Answered in words: the stack shows a reply field instead of options. */
  readonly freeForm?:
    | {
        readonly question: string;
        /** The pending request whose replies the helper may draft; none for a memory question. */
        readonly request?: { readonly threadId: ThreadId; readonly requestId: RequestId };
      }
    | undefined;
}

/**
 * Each worker an ask in the stack waits on, with that ask's key (the first, when several do): the
 * threads of a group's requests and the worker of a forwarded question. What the Board's chips,
 * the sidebar's rows and lines and their tones read as asking.
 */
export const askKeysByThread = (asks: readonly Ask[]): ReadonlyMap<ThreadId, string> => {
  const keys = new Map<ThreadId, string>();
  for (const ask of asks) {
    const threads =
      ask.worker !== undefined
        ? [ask.worker.question.threadId]
        : (ask.group?.entries.map((entry) => entry.threadId) ?? []);
    for (const threadId of threads) if (!keys.has(threadId)) keys.set(threadId, ask.key);
  }
  return keys;
};

const whoOf = (entries: readonly InboxEntry[]): string => {
  const titles = [...new Set(entries.map((entry) => entry.title))];
  return titles.length <= 2 ? titles.join(", ") : `${titles[0]} and ${titles.length - 1} more`;
};

/** Its feature, or the orchestrator, and who asks; a solo thread's only who asks. */
const contextOf = (group: InboxGroup): string => {
  const [first] = group.entries;
  const where = first.feature ?? (first.orchestrator === true ? "orchestrator" : undefined);
  return [...(where === undefined ? [] : [where]), whoOf(group.entries)].join(" · ");
};

/** The hold id of an orchestrator's open question. */
export const memoryId = (workspaceId: WorkspaceId, question: MemoryQuestion): string =>
  `memory:${workspaceId}:${question.id ?? question.text}`;

/** The hold id of a worker's question. */
export const workerQuestionId = (workspaceId: WorkspaceId, question: WorkerQuestion): string =>
  `worker-question:${workspaceId}:${question.id}`;

/**
 * Whether the stack answers `request` in place. What needs reading in full (an issue report, a
 * plan, several questions or choices) is answered in its thread instead: a worker's opens there,
 * and an orchestrator's stays in its own request cards.
 */
export const answersInPlace = (request: PendingRequest): boolean => {
  if (request.kind === "approval") return !mustReadDetails(request);
  if (request.kind === "plan") return false;
  const [question, ...more] = request.questions;
  return question !== undefined && more.length === 0 && !question.multiSelect;
};

/** One ask for one inbox group. */
export const askOf = (group: InboxGroup): Ask => {
  const [first] = group.entries;
  const { request } = first;
  const ids = group.entries.map((entry) => entry.request.id as string);
  const base = {
    key: ids.join(","),
    ids,
    group,
    count: group.entries.length,
    context: contextOf(group),
    extras: [],
    members: group.entries.map(({ title, project, checkout }) => ({ title, project, checkout })),
  };
  const open = (label: string): AskOption => ({
    label,
    done: "Opened",
    action: { kind: "open", threadId: first.threadId },
  });
  if (request.kind === "approval") {
    const pause = limitPauseAsk(request);
    if (pause !== undefined) {
      // Pausing is the safer answer, so it is the one Enter takes.
      return {
        ...base,
        icon: "approval",
        lead: pause.lead,
        description: pause.description,
        options: [
          { label: pause.pause, done: "Paused", action: { kind: "group", decision: "deny" } },
          { label: pause.keep, done: "Kept going", action: { kind: "group", decision: "allow" } },
        ],
      };
    }
    if (!answersInPlace(request)) {
      return {
        ...base,
        icon: "approval",
        lead: `Review ${request.displayName}`,
        options: [open("Open")],
      };
    }
    const n = group.entries.length;
    const options: AskOption[] = [
      {
        label: n > 1 ? `Allow ${n}` : "Allow",
        done: n > 1 ? `Allowed ${n}` : "Allowed",
        action: { kind: "group", decision: "allow" },
      },
      {
        label: "Deny",
        done: n > 1 ? `Denied ${n}` : "Denied",
        action: { kind: "group", decision: "deny" },
      },
    ];
    const summary = appToolSummary(request);
    const extras = approvalExtras(request);
    // More to the input than the line the ask leads with, or a value cut short: Details has it all.
    const more =
      Object.keys(request.input).length > 1 + extras.length ||
      extras.some((field) => field.value.endsWith("…"));
    const details = summary !== undefined || more ? approvalDetails(request) : undefined;
    if (summary !== undefined) {
      return { ...base, icon: "approval", lead: summary, details, options };
    }
    const isCommand = typeof request.input["command"] === "string";
    return {
      ...base,
      icon: "approval",
      lead: isCommand ? "Allow" : `Allow ${request.displayName}`,
      command: approvalSubject(request),
      extras,
      description: request.description,
      details,
      options,
    };
  }
  if (request.kind === "plan") {
    // Never one key for a plan nobody has read, nor for the mode it would start in.
    return { ...base, icon: "plan", lead: "Plan to review", options: [open("Review")] };
  }
  const [question] = request.questions;
  if (question === undefined || !answersInPlace(request)) {
    return {
      ...base,
      icon: "question",
      lead: question?.question ?? "Question",
      options: [open("Open")],
    };
  }
  if (question.options.length === 0) {
    return {
      ...base,
      icon: "question",
      lead: question.question,
      options: [],
      freeForm: {
        question: question.question,
        request: { threadId: first.threadId, requestId: request.id },
      },
    };
  }
  return {
    ...base,
    icon: "question",
    lead: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      done: option.label,
      description: describe(option.description),
      action: {
        kind: "answer",
        answer: { kind: "question", answers: { [question.question]: [option.label] } },
      },
    })),
  };
};

/** One ask for an orchestrator's open question, asked by `orchestratorId`. */
export const memoryAskOf = (
  workspaceId: WorkspaceId,
  question: MemoryQuestion,
  orchestratorId?: ThreadId,
): Ask => {
  const id = memoryId(workspaceId, question);
  const visuals = visualsOf(
    orchestratorId,
    question.options ?? [],
    question.recommended,
    question.mock,
  );
  const base = {
    ...(visuals === undefined ? {} : { visuals }),
    key: id,
    ids: [id],
    memory: { workspaceId, question },
    icon: "question" as const,
    lead: question.text,
    description: question.detail,
    extras: [],
    members: [],
    count: 1,
    context: "orchestrator",
  };
  const options = question.options ?? [];
  if (question.multiSelect === true) {
    return {
      ...base,
      options: [{ label: "Open", done: "Opened", action: { kind: "board", workspaceId } }],
    };
  }
  if (options.length === 0) return { ...base, options: [], freeForm: { question: question.text } };
  // The orchestrator's pick first, so Enter takes what it recommends.
  const ordered = [
    ...options.filter((option) => option.label === question.recommended),
    ...options.filter((option) => option.label !== question.recommended),
  ];
  return {
    ...base,
    options: ordered.map((option) => ({
      label: option.label,
      done: option.label,
      description: describe(option.description),
      recommended: option.label === question.recommended || undefined,
      action: { kind: "memory", answer: option.label },
    })),
  };
};

/** What a worker's question says beside its words: the worker's context, then the orchestrator's line. */
const workerQuestionDescription = (question: WorkerQuestion): string | undefined => {
  const lines = [
    ...(question.context === undefined ? [] : [question.context]),
    ...(question.options === undefined && question.recommended !== undefined
      ? [`Recommends: ${question.recommended}`]
      : []),
    ...(question.note === undefined ? [] : [`Orchestrator: ${question.note}`]),
  ];
  return lines.length === 0 ? undefined : lines.join("\n");
};

/** One ask for a worker's question forwarded to the user: its words exactly, its pick first. */
export const workerAskOf = (workspaceId: WorkspaceId, question: WorkerQuestion): Ask => {
  const id = workerQuestionId(workspaceId, question);
  const visuals = visualsOf(
    question.threadId,
    question.options ?? [],
    question.recommended,
    question.mock,
  );
  const base = {
    ...(visuals === undefined ? {} : { visuals }),
    key: id,
    ids: [id],
    worker: { workspaceId, question },
    icon: "question" as const,
    lead: question.question,
    description: workerQuestionDescription(question),
    extras: [],
    members: [{ title: question.title }],
    count: 1,
    context: [question.feature === "" ? undefined : question.feature, question.title]
      .filter((part) => part !== undefined)
      .join(" · "),
  };
  const options = question.options ?? [];
  if (question.multiSelect === true) {
    return {
      ...base,
      options: [{ label: "Open", done: "Opened", action: { kind: "board", workspaceId } }],
    };
  }
  if (options.length === 0) {
    return { ...base, options: [], freeForm: { question: question.question } };
  }
  const ordered = [
    ...options.filter((option) => option.label === question.recommended),
    ...options.filter((option) => option.label !== question.recommended),
  ];
  return {
    ...base,
    options: ordered.map((option) => ({
      label: option.label,
      done: option.label,
      description: describe(option.description),
      recommended: option.label === question.recommended || undefined,
      action: { kind: "worker", answer: option.label },
    })),
  };
};

/**
 * A workspace's asks: the orchestrator's own requests, its open questions, the workers' questions
 * forwarded to the user, then its workers' requests, in the inbox's order. Requests and questions
 * already answered here (`hidden`) are taken out first, so a group that grows or shrinks meanwhile
 * never brings an answered one back. The orchestrator's
 * requests that need reading in full stay in its own request cards.
 */
export const asksOf = ({
  groups,
  questions = [],
  workerQuestions = [],
  workspaceId,
  orchestratorId,
  hidden = new Set(),
}: {
  readonly groups: readonly InboxGroup[];
  readonly questions?: readonly MemoryQuestion[];
  /** The workers' questions forwarded to the user; others are left out here. */
  readonly workerQuestions?: readonly WorkerQuestion[];
  readonly workspaceId?: WorkspaceId | undefined;
  readonly orchestratorId?: ThreadId | undefined;
  readonly hidden?: ReadonlySet<string>;
}): Ask[] => {
  const left = groups.flatMap((group): InboxGroup[] => {
    const [first, ...rest] = group.entries.filter((entry) => !hidden.has(entry.request.id));
    return first === undefined ? [] : [{ key: group.key, entries: [first, ...rest] }];
  });
  const own = (group: InboxGroup) =>
    group.entries.every((entry) => entry.threadId === orchestratorId);
  const memory =
    workspaceId === undefined
      ? []
      : questions
          .filter((question) => !hidden.has(memoryId(workspaceId, question)))
          .map((question) => memoryAskOf(workspaceId, question, orchestratorId));
  const asked =
    workspaceId === undefined
      ? []
      : workerQuestions
          .filter(
            (question) =>
              question.stage === "forwarded" &&
              !hidden.has(workerQuestionId(workspaceId, question)),
          )
          .map((question) => workerAskOf(workspaceId, question));
  return [
    ...left.filter((group) => own(group) && answersInPlace(group.entries[0].request)).map(askOf),
    ...memory,
    ...asked,
    ...left.filter((group) => !own(group)).map(askOf),
  ];
};

/** The answer a free-form reply sends. */
export const replyAnswer = (question: string, text: string): RequestAnswer => ({
  kind: "question",
  answers: { [question]: [text] },
});

/** A suggested reply is shown only at six words or fewer. */
export const REPLY_CHIP_MAX_WORDS = 6;
export const MAX_REPLY_CHIPS = 3;

export const replyChips = (replies: readonly string[]): string[] =>
  replies
    .map((reply) => reply.trim())
    .filter((reply) => reply !== "" && reply.split(/\s+/).length <= REPLY_CHIP_MAX_WORDS)
    .slice(0, MAX_REPLY_CHIPS);

/** Where the current ask moves to after a step of `by`, wrapping. */
export const stepIndex = (index: number, by: number, length: number): number =>
  length === 0 ? 0 : (((index + by) % length) + length) % length;
