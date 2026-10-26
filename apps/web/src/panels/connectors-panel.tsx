import {
  CONNECTOR_HEALTH_LABEL,
  connectorHealth,
  effectiveCheckout,
  MCP_TARGET_LABEL,
  mcpTargetOf,
  type ConfiguredServer,
  type Connector,
  type ConnectorHealth,
  type McpScope,
  type McpTarget,
  type ThreadId,
} from "@gram/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleMinus,
  CircleOff,
  KeyRound,
  Plus,
  RefreshCw,
  Share,
  type LucideIcon,
} from "lucide-react";
import { useId, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { openExternalUrl } from "@/api/open-external";
import { QueryError } from "@/components/not-available";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agoText, formatMessageTime } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { CommandText } from "@/launch-checks/command-text";
import { spin, Spinner } from "@/motion";
import { useThreadsStore } from "@/stores/threads";

import { AddConnectorForm } from "./connector-add-form";
import { ClaudeAiMarks, ConnectorTools } from "./connector-details";
import {
  listConnectorsSettling,
  SIGN_IN_POLL_MS,
  startConnectorSignIn,
  useThreadSignIns,
  type PendingSignIn,
} from "./connector-sign-ins";
import {
  anyChecking,
  elsewhereDraft,
  FILTER_FROM,
  freshServersOf,
  groupConnectors,
  isClaudeHosted,
  SIGNED_OUT_OPEN_UP_TO,
} from "./connectors-model";
import { useSessionStart, type SessionStart } from "./connectors-start";
import type { McpDraft } from "./mcp-config";
import { PanelMessage } from "./panel-message";

/** Scopes Gram can remove from; `claudeai`, plugin and managed servers are configured elsewhere. */
const REMOVABLE: ReadonlySet<string> = new Set<McpScope>(["local", "project", "user"]);

/**
 * Glyph and tone per health; the words are the contract's (`CONNECTOR_HEALTH_LABEL`), the same in
 * Settings, so state never relies on colour alone and no two views word it differently.
 */
export const CONNECTOR_HEALTH: Record<ConnectorHealth, { icon: LucideIcon; tone: string }> = {
  connected: { icon: CircleCheck, tone: "text-success" },
  connecting: { icon: CircleDashed, tone: "text-muted-foreground" },
  failed: { icon: CircleAlert, tone: "text-destructive" },
  disabled: { icon: CircleOff, tone: "text-muted-foreground" },
  // Unused configured servers do not need to interrupt a coding session.
  "needs-auth": { icon: KeyRound, tone: "text-muted-foreground" },
  "not-given": { icon: CircleMinus, tone: "text-muted-foreground" },
};

/** How often the panel looks again while a server is still being checked. */
const CHECKING_POLL_MS = 3_000;

const CLAUDE_HOSTED_NOTE = "A claude.ai connector: it works in Claude threads only.";

/** Why a Codex thread lists none of the user's claude.ai connectors, and what to do. */
export const claudeHostedElsewhere = (agentLabel: string) =>
  `claude.ai connectors reach Claude threads only. To use a server with ${agentLabel}, add it here by its URL.`;

/** The agents a claude.ai connector's server can be given by its address. */
const ELSEWHERE: ReadonlyArray<McpTarget> = ["codex"];

/**
 * The form, open: blank from "Add server…" for this thread, or a claude.ai connector's server for
 * another agent, which is written user-wide and leaves this thread's session alone.
 */
interface Adding {
  readonly target?: McpTarget;
  readonly draft?: Partial<McpDraft>;
  readonly note?: string;
}

/**
 * The live session's MCP connectors, with sign-in, reconnect and enable/disable. Refreshes on
 * demand, after every action, when the thread starts or stops its session, and every couple of
 * seconds while a sign-in is under way. Signing in is the agent's own OAuth flow: this only opens
 * the page, and the agent keeps the token. A cold thread's session is started as the tab opens
 * (`useSessionStart`), with what its agent's config holds shown until it reports.
 */
export function ConnectorsPanel({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const session = useThreadsStore((s) => {
    const status = s.byId[threadId]?.status;
    return status === "cold" || status === "starting" ? status : "up";
  });
  const wake = useSessionStart(threadId);
  const target = useThreadsStore((s) => mcpTargetOf(s.byId[threadId]?.thread.model.agent));
  const agentLabel = target === undefined ? "The agent" : MCP_TARGET_LABEL[target];
  const signIns = useThreadSignIns(threadId);
  const signingIn = Object.keys(signIns).length > 0;
  const [notice, setNotice] = useState<string | undefined>();
  const query = useQuery({
    queryKey: ["connectors", threadId, session],
    queryFn: async () => {
      const { list, connected } = await listConnectorsSettling(api, threadId);
      if (connected.length > 0) setNotice(`Signed in to ${connected.join(", ")}.`);
      return list;
    },
    retry: false,
    // The answer from before the session started or stopped stands until the new one lands.
    placeholderData: keepPreviousData,
    // "Checking…" is never the last word: the panel looks again until every server is known.
    refetchInterval: (current) =>
      signingIn
        ? SIGN_IN_POLL_MS
        : current.state.data?.live === true && anyChecking(current.state.data.connectors)
          ? CHECKING_POLL_MS
          : false,
  });
  const asleep = query.data?.live === false && query.data.reason === "noSession";
  /** Set by a refresh or a config write, so the next read of the configs is afresh. */
  const freshConfigured = useRef(false);
  // Under the thread's key, so every refresh and action reads it again too.
  const configured = useQuery({
    queryKey: ["connectors", threadId, "configured"],
    queryFn: () => {
      const fresh = freshConfigured.current;
      freshConfigured.current = false;
      const thread = useThreadsStore.getState().byId[threadId]?.thread;
      const folder = thread === undefined ? undefined : effectiveCheckout(thread).path;
      return api.listConfiguredConnectors({
        ...(folder === undefined ? {} : { cwd: folder }),
        ...(fresh ? { fresh } : {}),
      });
    },
    enabled: asleep && target !== undefined,
    retry: false,
  });
  const refresh = () => {
    freshConfigured.current = true;
    return queryClient.invalidateQueries({ queryKey: ["connectors", threadId] });
  };
  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSettled: refresh,
  });
  const [adding, setAdding] = useState<Adding | undefined>();
  const [filter, setFilter] = useState("");
  /** The user's own choice for the not-signed-in group; until they make one, its size decides. */
  const [signedOutOpen, setSignedOutOpen] = useState<boolean | undefined>();
  const signedOutId = useId();

  const connectors = query.data?.live ? query.data.connectors : undefined;

  const signIn = (name: string) =>
    action.mutate(async () => {
      await startConnectorSignIn(api, threadId, name, () =>
        setNotice(
          `Finish signing in to ${name} in your browser. ${agentLabel} keeps the sign-in; Gram never sees it.`,
        ),
      );
    });

  const toggle = (connector: Connector) =>
    action.mutate(async () => {
      const enabling = connector.status === "disabled";
      const result = await api.setConnectorEnabled(threadId, connector.name, enabling);
      const sentences = [
        result.session === "reopening"
          ? "The session reopens once it's idle to apply it."
          : undefined,
        connector.toggleNote,
      ].filter((sentence): sentence is string => sentence !== undefined);
      if (sentences.length > 0) {
        setNotice(`${enabling ? "Enabled" : "Disabled"} ${connector.name}. ${sentences.join(" ")}`);
      }
    });

  const remove = (connector: Connector) =>
    action.mutate(async () => {
      const result = await api.removeConnector({
        threadId,
        name: connector.name,
        scope: connector.scope as McpScope,
        ...(target === undefined ? {} : { target }),
      });
      setNotice(
        result.session === "reopening"
          ? `Removed ${result.name}. The session reopens once it's idle.`
          : `Removed ${result.name}.`,
      );
    });

  /**
   * Opens the form for `other` with the connector's address, after reading afresh what that agent
   * has user-wide (a config read, which connects nothing): its writers replace a server of the
   * same name, so the name filled in is a free one, and one already at the address is said so.
   */
  const giveTo = (name: string, other: McpTarget, url: string) =>
    action.mutate(async () => {
      setNotice(undefined);
      const taken = await freshServersOf((payload) => api.listConfiguredConnectors(payload), other);
      const copy = elsewhereDraft(name, url, taken, other);
      if (copy.kind === "present") {
        setNotice(`${MCP_TARGET_LABEL[other]} already has it, as ${copy.name}.`);
        return;
      }
      setAdding({ target: other, draft: copy.draft, note: copy.note });
    });

  const rows = (label: string, listed: ReadonlyArray<Connector>) =>
    listed.length === 0 ? null : (
      <ul aria-label={label} className="divide-y divide-border">
        {listed.map((connector) => (
          <ConnectorRow
            key={connector.name}
            connector={connector}
            busy={action.isPending}
            signIn={signIns[connector.name]}
            onSignIn={() => signIn(connector.name)}
            onOpenSignIn={(url) => void openExternalUrl(api, url)}
            onReconnect={() =>
              action.mutate(() => api.reconnectConnector(threadId, connector.name))
            }
            onToggle={() => toggle(connector)}
            onRemove={
              connector.scope !== undefined && REMOVABLE.has(connector.scope)
                ? () => remove(connector)
                : undefined
            }
            onUseWith={
              isClaudeHosted(connector) && connector.url !== undefined
                ? (other, url) => giveTo(connector.name, other, url)
                : undefined
            }
          />
        ))}
      </ul>
    );

  const groups = groupConnectors(connectors ?? [], filter);
  // Said once for the group: every row of a Claude thread would repeat the same sentence.
  const signInHints = [
    ...new Set(
      groups.signedOut.flatMap((c) =>
        c.signInUnavailable === undefined ? [] : [c.signInUnavailable],
      ),
    ),
  ];
  const showSignedOut =
    signedOutOpen ??
    (filter.trim() !== "" || signingIn || groups.signedOut.length <= SIGNED_OUT_OPEN_UP_TO);

  return (
    <div data-testid="connectors-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span>MCP connectors</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-expanded={adding !== undefined}
          onClick={() => {
            setAdding((open) => (open === undefined ? {} : undefined));
            setNotice(undefined);
          }}
        >
          <Plus data-icon="inline-start" />
          Add server…
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh connectors"
          disabled={query.isFetching}
          onClick={() => void refresh()}
        >
          <RefreshCw aria-hidden ref={query.isFetching ? spin : undefined} />
        </Button>
      </div>
      {adding !== undefined && (
        <>
          {adding.note !== undefined && (
            <p className="border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {adding.note}
            </p>
          )}
          <AddConnectorForm
            key={`${adding.target ?? "new"}:${adding.draft?.name ?? ""}`}
            {...(adding.target === undefined
              ? { threadId, agent: target }
              : { agent: adding.target, initial: adding.draft })}
            onCancel={() => setAdding(undefined)}
            onAdded={(message) => {
              setAdding(undefined);
              setNotice(message);
              void refresh();
            }}
          />
        </>
      )}
      {notice && (
        <p role="status" className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {action.error && (
        <p role="alert" className="border-b border-border px-3 py-2 text-xs text-destructive">
          {errorMessage(action.error)}
        </p>
      )}
      {connectors !== undefined && connectors.length > FILTER_FROM && (
        <input
          type="search"
          aria-label="Filter connectors"
          placeholder="Filter by name"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="shrink-0 border-b border-border bg-transparent px-3 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:bg-accent/40"
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending ? (
          <PanelMessage loading>Loading connectors…</PanelMessage>
        ) : query.isError ? (
          <QueryError error={query.error} feature="Connectors" />
        ) : !query.data.live ? (
          query.data.reason === "noSession" ? (
            <SessionAsleep
              target={target}
              servers={configured.data?.agents.find((a) => a.target === target)?.servers ?? []}
              wake={wake}
              // The session is up, and its list is on the way.
              starting={wake.starting || (session === "up" && query.isPlaceholderData)}
            />
          ) : (
            <PanelMessage>This agent doesn't report its connectors.</PanelMessage>
          )
        ) : query.data.connectors.length === 0 ? (
          <PanelMessage>No MCP servers yet. “Add server…” sets one up.</PanelMessage>
        ) : groups.inUse.length + groups.signedOut.length === 0 ? (
          <PanelMessage>No connector matches “{filter.trim()}”.</PanelMessage>
        ) : (
          <>
            {rows("Connectors", groups.inUse)}
            {groups.signedOut.length > 0 && (
              <section
                aria-label="Not signed in"
                className={cn(groups.inUse.length > 0 && "border-t border-border")}
              >
                <button
                  type="button"
                  aria-expanded={showSignedOut}
                  aria-controls={signedOutId}
                  onClick={() => setSignedOutOpen(!showSignedOut)}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
                >
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0 motion-safe:transition-transform",
                      showSignedOut && "rotate-90",
                    )}
                  />
                  <span>Not signed in</span>
                  <span className="tabular-nums">· {groups.signedOut.length}</span>
                  <span className="ml-auto truncate opacity-70">Sign in to the ones you need</span>
                </button>
                <div id={signedOutId} hidden={!showSignedOut} className="border-t border-border">
                  {signInHints.map((hint) => (
                    <p
                      key={hint}
                      className="border-b border-border px-3 py-2 text-xs text-muted-foreground"
                    >
                      <CommandText text={hint} />
                    </p>
                  ))}
                  {rows("Connectors not signed in", groups.signedOut)}
                </div>
              </section>
            )}
          </>
        )}
        {connectors !== undefined && target !== undefined && target !== "claude" && (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            {claudeHostedElsewhere(agentLabel)}
          </p>
        )}
        {query.data?.live === true && query.data.claudeAiUnavailable !== undefined && (
          <p
            data-testid="claude-ai-unavailable"
            className="border-t border-border px-3 py-2 text-xs text-muted-foreground"
          >
            {query.data.claudeAiUnavailable}
          </p>
        )}
      </div>
    </div>
  );
}

/** How a configured server reads while the session that would report it live isn't up. */
const configuredState = (server: ConfiguredServer) =>
  server.disabled === true
    ? "Disabled"
    : server.signedIn === true
      ? "Signed in"
      : server.signedIn === false
        ? "Not signed in"
        : "Configured";

/**
 * A cold thread's tab: the session starting, or why it wasn't and a button to start it, over what
 * the agent's own config holds, read without connecting anything, and the claude.ai connectors as
 * a Claude thread last reported them, each "as of" then.
 */
function SessionAsleep({
  target,
  servers: listed,
  wake,
  starting,
}: {
  target: McpTarget | undefined;
  /** What the thread's agent's config holds, read without connecting anything. */
  servers: ReadonlyArray<ConfiguredServer>;
  wake: SessionStart;
  starting: boolean;
}) {
  const now = useNow(true, undefined, 30_000);
  // Put configured servers awaiting sign-in after the usable ones.
  const servers = listed.toSorted(
    (a, b) => Number(a.signedIn === false) - Number(b.signedIn === false),
  );
  const why = wake.problem ?? wake.hold?.reason;

  return (
    <>
      {starting ? (
        <PanelMessage loading>Starting the session…</PanelMessage>
      ) : (
        <div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <p role="status">{why ?? "The session isn't running."}</p>
          {(wake.hold === undefined || wake.hold.button) && (
            <Button size="sm" variant="outline" onClick={wake.start}>
              {wake.problem === undefined ? "Start session" : "Try again"}
            </Button>
          )}
        </div>
      )}
      {servers.length > 0 && (
        <section
          aria-label="Configured connectors"
          data-testid="connectors-snapshot"
          className="border-t border-border"
        >
          <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
            What {target === undefined ? "the agent" : MCP_TARGET_LABEL[target]} has configured. The
            live list shows once the session is up.
          </p>
          <ul className="divide-y divide-border">
            {servers.map((server) => (
              <li
                key={`${server.scope}:${server.name}`}
                data-testid="configured-connector"
                aria-label={server.name}
                className="flex items-center gap-2 px-3 py-2 text-xs"
              >
                <span className="min-w-0 truncate font-mono">{server.name}</span>
                <Badge variant="outline">
                  {server.scope === "claudeai" ? "claude.ai" : server.scope}
                </Badge>
                <span className="ml-auto shrink-0 text-muted-foreground">
                  {configuredState(server)}
                  {server.seenAt !== undefined && (
                    <span
                      title={`As a Claude thread reported it at ${formatMessageTime(Date.parse(server.seenAt))}`}
                    >
                      {" "}
                      · as of {agoText(server.seenAt, now)}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function ConnectorRow({
  connector,
  busy,
  signIn,
  onSignIn,
  onOpenSignIn,
  onReconnect,
  onToggle,
  onRemove,
  onUseWith,
}: {
  connector: Connector;
  busy: boolean;
  /** Present while the user is signing in to this one in their browser. */
  signIn: PendingSignIn | undefined;
  onSignIn: () => void;
  onOpenSignIn: (url: string) => void;
  onReconnect: () => void;
  onToggle: () => void;
  /** Absent for servers Gram can't remove (claude.ai, plugins, managed). */
  onRemove: (() => void) | undefined;
  /** For a claude.ai connector with an address: give its server to another agent. */
  onUseWith: ((target: McpTarget, url: string) => void) | undefined;
}) {
  const waiting = signIn !== undefined && connector.status === "needs-auth";
  const health = connectorHealth(connector);
  const state = { ...CONNECTOR_HEALTH[health], label: CONNECTOR_HEALTH_LABEL[health] };
  const disabled = connector.status === "disabled";
  const signedOut = health === "needs-auth";
  // Nothing here changes these: Settings → Workspaces lists an orchestrator's servers, and a
  // server still loading has no session entry to act on yet.
  const settledElsewhere = health === "not-given" || connector.unconfirmed === true;
  const reasonsId = useId();
  const noteId = useId();
  const reasons = [connector.reconnectUnavailable, connector.toggleUnavailable].filter(
    (reason, i, all): reason is string => reason !== undefined && all.indexOf(reason) === i,
  );
  const toggleDescribedBy =
    [
      connector.toggleUnavailable === undefined ? undefined : reasonsId,
      connector.toggleNote === undefined ? undefined : noteId,
    ]
      .filter((id): id is string => id !== undefined)
      .join(" ") || undefined;
  const scopeBadge = isClaudeHosted(connector) ? (
    <Badge variant="outline" title={CLAUDE_HOSTED_NOTE}>
      claude.ai
    </Badge>
  ) : (
    connector.scope && <Badge variant="outline">{connector.scope}</Badge>
  );
  const blocked = connector.claudeAi?.blocked;
  const rejected = connector.claudeAi?.claudeSignInRejected === true;
  const [elsewhereOpen, setElsewhereOpen] = useState(false);
  const elsewhereId = useId();
  // Keep the optional action compact when many servers are configured.
  const elsewhereToggle = onUseWith !== undefined && connector.url !== undefined && (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={`Use ${connector.name} with another agent`}
      title="Use with Codex, which sign in themselves"
      aria-expanded={elsewhereOpen}
      aria-controls={elsewhereId}
      onClick={() => setElsewhereOpen(!elsewhereOpen)}
    >
      <Share aria-hidden />
    </Button>
  );
  const elsewhere = elsewhereOpen && onUseWith !== undefined && connector.url !== undefined && (
    <div id={elsewhereId} className="flex flex-wrap items-center gap-1">
      {ELSEWHERE.map((other) => (
        <Button
          key={other}
          size="sm"
          variant="ghost"
          disabled={busy}
          title={`Add ${connector.url} to ${MCP_TARGET_LABEL[other]}, which signs in itself`}
          onClick={() => onUseWith(other, connector.url!)}
        >
          Use with {MCP_TARGET_LABEL[other]}
        </Button>
      ))}
    </div>
  );
  const details = (connector.tools !== undefined || elsewhere) && (
    <div className="flex flex-col gap-1 pl-5.5 text-muted-foreground">
      {connector.tools !== undefined && (
        <ConnectorTools name={connector.name} tools={connector.tools} />
      )}
      {elsewhere}
    </div>
  );
  const removeButton = onRemove && (
    <Button
      size="sm"
      variant="ghost"
      className="text-destructive"
      disabled={busy}
      onClick={onRemove}
    >
      Remove
    </Button>
  );

  // One line each: a catalogue leaves dozens of these, and the group's heading already says what
  // they are. Reconnect stays for an agent whose sign-in happens elsewhere, as the step after it.
  if (signedOut) {
    return (
      <li
        data-testid="connector"
        aria-label={connector.name}
        className="flex flex-col gap-1 px-3 py-1.5 text-xs"
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {waiting ? (
            <Spinner aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <state.icon aria-hidden className={cn("size-3.5 shrink-0", state.tone)} />
          )}
          <span className="min-w-0 truncate font-mono">{connector.name}</span>
          {scopeBadge}
          <ClaudeAiMarks claudeAi={connector.claudeAi} />
          <span className="sr-only">{state.label}</span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {waiting ? (
              <>
                <span className="text-muted-foreground">Waiting for sign-in…</span>
                {signIn.url !== undefined && (
                  <Button size="sm" variant="ghost" onClick={() => onOpenSignIn(signIn.url!)}>
                    Open page again
                  </Button>
                )}
              </>
            ) : blocked !== undefined ? null : connector.signInUnavailable === undefined ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={onSignIn}>
                Sign in
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || connector.reconnectUnavailable !== undefined}
                title={connector.reconnectUnavailable}
                onClick={onReconnect}
              >
                Reconnect
              </Button>
            )}
            {!waiting && removeButton}
            {elsewhereToggle}
          </div>
        </div>
        {connector.error && (
          <p className="pl-5.5 break-words text-muted-foreground">{connector.error}</p>
        )}
        {details}
      </li>
    );
  }

  return (
    <li
      data-testid="connector"
      aria-label={connector.name}
      className="flex flex-col gap-1 px-3 py-2 text-xs"
    >
      <div className="flex items-center gap-2">
        <state.icon aria-hidden className={cn("size-3.5 shrink-0", state.tone)} />
        <span className="min-w-0 truncate font-mono">{connector.name}</span>
        {connector.builtIn && <Badge variant="secondary">built-in</Badge>}
        {scopeBadge}
        <ClaudeAiMarks claudeAi={connector.claudeAi} />
        <span className={cn("ml-auto shrink-0", state.tone)}>{state.label}</span>
      </div>
      {connector.error && <p className="pl-5.5 break-words text-destructive">{connector.error}</p>}
      {rejected && connector.signInUnavailable !== undefined && (
        <p className="pl-5.5 break-words text-muted-foreground">
          <CommandText text={connector.signInUnavailable} />
        </p>
      )}
      {blocked !== undefined && (
        <p className="pl-5.5 break-words text-muted-foreground">Blocked by policy: {blocked}</p>
      )}
      {settledElsewhere ? (
        connector.toggleUnavailable && (
          <p className="pl-5.5 text-muted-foreground">{connector.toggleUnavailable}</p>
        )
      ) : (
        <div className="flex flex-wrap gap-1 pl-4">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || disabled || connector.reconnectUnavailable !== undefined}
            title={connector.reconnectUnavailable}
            aria-describedby={connector.reconnectUnavailable ? reasonsId : undefined}
            onClick={onReconnect}
          >
            Reconnect
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || connector.toggleUnavailable !== undefined}
            title={connector.toggleUnavailable ?? connector.toggleNote}
            aria-describedby={toggleDescribedBy}
            onClick={onToggle}
          >
            {disabled ? "Enable" : "Disable"}
          </Button>
          {removeButton}
          {elsewhereToggle}
        </div>
      )}
      {!settledElsewhere && reasons.length > 0 && (
        <p id={reasonsId} className="pl-5.5 text-muted-foreground">
          {reasons.join(" ")}
        </p>
      )}
      {connector.toggleNote && (
        <p id={noteId} className="pl-5.5 text-muted-foreground">
          {connector.toggleNote}
        </p>
      )}
      {details}
    </li>
  );
}
