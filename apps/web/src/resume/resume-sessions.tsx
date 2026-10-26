import type { AgentKind, AgentSessionSummary, ModelRef, SessionPreview } from "@gram/contracts";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { GitBranch, History, StepForward, Trash2 } from "lucide-react";
import { useId, useState } from "react";

import { AgentIcon, agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { errorMessage, isNotImplemented } from "@/api/errors";
import type { Api } from "@/api/types";
import { Button } from "@/components/ui/button";
import { useAvailableAgents } from "@/composer/agent-fields";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useServerSettings } from "@/settings-sync/store";
import { useLayoutStore } from "@/stores/layout";
import { flushServerEvents, useThreadsStore } from "@/stores/threads";

const SESSION_LIMIT = 50;

export const sessionsQueryKey = (projectRoot: string) => ["sessions.list", projectRoot] as const;

/** A past session and the agent it belongs to. */
export interface ResumableSession extends AgentSessionSummary {
  readonly agent: AgentKind;
}

export interface ResumableSessions {
  /** Newest first, across agents. */
  readonly sessions: readonly ResumableSession[];
  /** Whether any agent here can list its past sessions. */
  readonly supported: boolean;
  /** Agents whose listing failed while another answered. */
  readonly failures: readonly { readonly agent: AgentKind; readonly message: string }[];
}

/** Every agent's past sessions for `projectRoot`; rejects only when every listing failed. */
async function listResumableSessions(
  api: Api,
  agents: readonly AgentKind[],
  projectRoot: string,
  limit = SESSION_LIMIT,
): Promise<ResumableSessions> {
  const results = await Promise.allSettled(
    agents.map((agent) => api.listSessions(agent, projectRoot, limit)),
  );
  const sessions: ResumableSession[] = [];
  const failures: { agent: AgentKind; message: string }[] = [];
  let supported = false;
  for (const [i, result] of results.entries()) {
    const agent = agents[i]!;
    if (result.status === "rejected") {
      failures.push({ agent, message: errorMessage(result.reason) });
    } else if (result.value.supported) {
      supported = true;
      sessions.push(...result.value.sessions.map((session) => ({ ...session, agent })));
    }
  }
  const first = results[0];
  if (failures.length === results.length && first?.status === "rejected") throw first.reason;
  return {
    sessions: sessions.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, limit),
    supported,
    failures,
  };
}

/** The newest past session of `agent` for `projectRoot`, as `claude --continue` picks it. */
export async function latestSession(
  api: Api,
  agent: AgentKind,
  projectRoot: string,
): Promise<ResumableSession | undefined> {
  const list = await api.listSessions(agent, projectRoot, 1);
  const session = list.supported ? list.sessions[0] : undefined;
  return session === undefined ? undefined : { ...session, agent };
}

/** Past sessions of every available agent for `projectRoot`; idle while it's undefined or empty. */
export function useResumableSessions(projectRoot: string | undefined) {
  const api = useApi();
  const agents = useAvailableAgents();
  return useQuery({
    queryKey: [...sessionsQueryKey(projectRoot ?? ""), agents],
    queryFn: () => listResumableSessions(api, agents, projectRoot ?? ""),
    enabled: projectRoot !== undefined && projectRoot !== "",
    retry: false,
  });
}

/** Resume with an explicitly selected default, otherwise let the local agent choose its model. */
export function resumeModel(agent: AgentKind, defaultModel: ModelRef | undefined): ModelRef {
  return defaultModel?.agent === agent ? defaultModel : { agent, model: "default" };
}

export function useResumeModel() {
  const defaultModel = useServerSettings((s) => s.settings?.agents.defaultModel);
  return (agent: AgentKind) => resumeModel(agent, defaultModel);
}

/** Opens the thread already showing `session`, else resumes it into a new thread. Returns the thread id. */
export async function resumeSession(
  api: Api,
  session: ResumableSession,
  projectRoot: string,
  model: ModelRef | undefined,
): Promise<string> {
  if (session.threadId) return session.threadId;
  if (model === undefined) {
    throw new Error(`Select an available ${agentLabel(session.agent)} model before resuming.`);
  }
  const thread = await api.createThread({
    projectRoot,
    checkout: { kind: "current" },
    model,
    title: session.title.slice(0, 80),
    resumeSessionId: session.agentSessionId,
    ...(session.codexHome === undefined ? {} : { codexHome: session.codexHome }),
  });
  // The server's `thread.upsert` may land after the route changes; don't flash "not found".
  // An upsert the server sent before this answer may still wait for its frame: it goes first.
  flushServerEvents();
  useThreadsStore.getState().applyEvent({ type: "thread.upsert", thread });
  return thread.id;
}

/** Shows a resumed thread and refreshes `projectRoot`'s listing, which now marks it open. */
function useShowResumed(projectRoot: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (threadId: string) => {
    void queryClient.invalidateQueries({ queryKey: sessionsQueryKey(projectRoot) });
    useLayoutStore.getState().openThread(threadId as never);
    void navigate({ to: "/t/$threadId", params: { threadId } });
  };
}

/** "Continue latest session": resumes `model.agent`'s newest session for `projectRoot` on `model`. */
export function ContinueLatest({
  projectRoot,
  model,
  disabled = false,
}: {
  projectRoot: string;
  model: ModelRef;
  disabled?: boolean;
}) {
  const api = useApi();
  const showResumed = useShowResumed(projectRoot);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<string>();

  const run = async () => {
    setPending(true);
    setNote(undefined);
    try {
      const session = await latestSession(api, model.agent, projectRoot);
      if (session === undefined) {
        setNote(`No past ${agentLabel(model.agent)} sessions in this folder.`);
      } else {
        showResumed(await resumeSession(api, session, projectRoot, model));
      }
    } catch (e) {
      setNote(`Couldn't continue: ${errorMessage(e)}`);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || pending}
        onClick={() => void run()}
      >
        <StepForward data-icon="inline-start" />
        Continue latest session
      </Button>
      {note && (
        <p role="status" className="basis-full text-xs text-muted-foreground">
          {note}
        </p>
      )}
    </>
  );
}

const sessionKey = (session: ResumableSession) => `${session.agent}:${session.agentSessionId}`;

/** The hovered or focused past session's first prompt and last reply. */
function SessionPreviewNote({
  id,
  preview,
}: {
  id: string;
  preview: UseQueryResult<SessionPreview>;
}) {
  if (preview.isPending) {
    return (
      <p id={id} className="px-2 text-xs text-muted-foreground">
        Loading preview…
      </p>
    );
  }
  if (preview.isError || (!preview.data.firstPrompt && !preview.data.lastReply)) return null;
  return (
    <dl
      id={id}
      data-testid="session-preview"
      aria-label="Session preview"
      className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs"
    >
      {preview.data.firstPrompt && (
        <>
          <dt className="text-muted-foreground">You</dt>
          <dd className="line-clamp-2 min-w-0">{preview.data.firstPrompt}</dd>
        </>
      )}
      {preview.data.lastReply && (
        <>
          <dt className="text-muted-foreground">Last reply</dt>
          <dd className="line-clamp-2 min-w-0">{preview.data.lastReply}</dd>
        </>
      )}
    </dl>
  );
}

/**
 * Past sessions of every agent for `projectRoot`, newest first; picking one resumes it into a thread,
 * on `model` when it's that session's agent. Sessions no thread shows can be deleted after an inline
 * confirm.
 */
export function ResumeSessions({
  projectRoot,
  model,
  onPicked,
}: {
  projectRoot: string;
  model?: ModelRef;
  onPicked?: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const showResumed = useShowResumed(projectRoot);
  const query = useResumableSessions(projectRoot);
  const modelFor = useResumeModel();
  const [pending, setPending] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [error, setError] = useState<string>();
  // Only the hovered or focused session is read, never a transcript per row.
  const [focused, setFocused] = useState<string>();
  const previewId = useId();
  const focusedSession = query.data?.sessions.find((session) => sessionKey(session) === focused);
  const preview = useQuery({
    queryKey: [
      "sessions.preview",
      projectRoot,
      focusedSession?.agent,
      focusedSession?.agentSessionId,
    ],
    queryFn: () =>
      api.previewSession(focusedSession!.agent, projectRoot, focusedSession!.agentSessionId),
    enabled: focusedSession !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  const pick = async (session: ResumableSession) => {
    setPending(session.agentSessionId);
    setError(undefined);
    try {
      const threadId = await resumeSession(
        api,
        session,
        projectRoot,
        model?.agent === session.agent ? model : modelFor(session.agent),
      );
      onPicked?.();
      showResumed(threadId);
    } catch (e) {
      setError(`Couldn't resume: ${errorMessage(e)}`);
    } finally {
      setPending(undefined);
    }
  };

  const remove = async (session: ResumableSession) => {
    setDeleting(sessionKey(session));
    setError(undefined);
    try {
      await api.deleteSession(session.agent, projectRoot, session.agentSessionId);
      setConfirming(undefined);
      await queryClient.invalidateQueries({ queryKey: sessionsQueryKey(projectRoot) });
    } catch (e) {
      setError(`Couldn't delete: ${errorMessage(e)}`);
    } finally {
      setDeleting(undefined);
    }
  };

  let body;
  if (query.isPending) {
    body = <p className="text-xs text-muted-foreground">Looking for past sessions…</p>;
  } else if (query.isError) {
    body = (
      <p className="text-xs text-muted-foreground">
        {isNotImplemented(query.error)
          ? "Listing past sessions isn't available yet."
          : `Couldn't list past sessions: ${errorMessage(query.error)}`}
      </p>
    );
  } else if (!query.data.supported && query.data.failures.length === 0) {
    body = (
      <p className="text-xs text-muted-foreground">No agent here can list its past sessions.</p>
    );
  } else if (query.data.sessions.length === 0) {
    body = <p className="text-xs text-muted-foreground">No past sessions in this folder.</p>;
  } else {
    body = (
      <>
        <ul aria-label="Past sessions" className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          {query.data.sessions.map((session) => {
            const key = sessionKey(session);
            if (confirming === key) {
              return (
                <li key={key}>
                  <div
                    role="group"
                    aria-label={`Delete “${session.title}”?`}
                    data-testid="confirm-delete"
                    className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-2 py-1.5 text-xs"
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      // Cancels the confirmation only, not an app shortcut on Escape as well.
                      event.preventDefault();
                      event.stopPropagation();
                      setConfirming(undefined);
                    }}
                  >
                    <span className="min-w-0 flex-1">
                      Delete “<span className="font-medium">{session.title}</span>” from{" "}
                      {agentLabel(session.agent)}&apos;s history? This can&apos;t be undone.
                    </span>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={deleting === key}
                      onClick={() => void remove(session)}
                    >
                      Delete
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirming(undefined)}
                    >
                      Cancel
                    </Button>
                  </div>
                </li>
              );
            }
            return (
              <li key={key} className="group flex items-start gap-0.5">
                <button
                  type="button"
                  data-testid="past-session"
                  data-agent={session.agent}
                  disabled={pending !== undefined}
                  aria-describedby={focused === key ? previewId : undefined}
                  onMouseEnter={() => setFocused(key)}
                  onFocus={() => setFocused(key)}
                  onClick={() => void pick(session)}
                  className={cn(
                    "flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:opacity-60",
                    pending === session.agentSessionId && "bg-muted",
                  )}
                >
                  <span className="truncate text-sm">{session.title}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="flex shrink-0 items-center gap-0.5 rounded-sm bg-muted px-1">
                      <AgentIcon agent={session.agent} className="size-3" />
                      {agentLabel(session.agent)}
                    </span>
                    <time dateTime={new Date(session.updatedAt).toISOString()}>
                      {formatRelative(session.updatedAt)}
                    </time>
                    {session.gitBranch && (
                      <span className="flex min-w-0 items-center gap-0.5 truncate font-mono">
                        <GitBranch aria-hidden className="size-3 shrink-0" />
                        {session.gitBranch}
                      </span>
                    )}
                    {session.threadId && (
                      <span className="shrink-0 rounded-sm border border-border px-1">Open</span>
                    )}
                  </span>
                </button>
                {!session.threadId && (
                  <button
                    type="button"
                    aria-label={`Delete “${session.title}”`}
                    title="Delete session"
                    disabled={pending !== undefined}
                    onClick={() => setConfirming(key)}
                    className="mt-1.5 shrink-0 rounded-sm p-1 text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:bg-accent hover:text-destructive focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {focusedSession && <SessionPreviewNote id={previewId} preview={preview} />}
      </>
    );
  }

  return (
    <section
      data-testid="resume-sessions"
      aria-label="Resume a past session"
      className="flex flex-col gap-2 rounded-lg border border-border p-2"
    >
      <h2 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <History aria-hidden className="size-3.5" />
        Resume a past session
      </h2>
      {body}
      {query.data?.failures.map((failure) => (
        <p key={failure.agent} className="text-xs text-warning">
          Couldn't list {agentLabel(failure.agent)} sessions: {failure.message}
        </p>
      ))}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
