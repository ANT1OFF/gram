import {
  MCP_TARGET_LABEL,
  type AgentConfiguredServers,
  type ClaudeAiSource,
  type ConfiguredServer,
  type ConnectorSignIn,
  type McpScope,
  type McpTarget,
} from "@gram/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  CircleCheck,
  CircleOff,
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { openExternalUrl } from "@/api/open-external";
import { QueryError } from "@/components/not-available";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agoText, formatMessageTime } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { CommandText } from "@/launch-checks/command-text";
import { cn } from "@/lib/utils";
import { spin, Spinner } from "@/motion";
import { AddConnectorForm } from "@/panels/connector-add-form";
import { ClaudeAiMarks, ConnectorTools } from "@/panels/connector-details";
import {
  connectorMatrix,
  copyTo,
  FILTER_FROM,
  freshServersOf,
  isRemovable,
  MCP_TARGETS,
  SIGNED_OUT_OPEN_UP_TO,
  withSignIns,
  type ConnectorMatrixRow,
} from "@/panels/connectors-model";
import type { McpDraft } from "@/panels/mcp-config";

import { ConfirmStrip } from "./confirm-strip";
import { nextConfiguredRead } from "./connectors-refresh";
import { RowContextMenu, RowMenuButton, type RowAction } from "./row-menu";
import { useFeature } from "./use-diagnostics";

const EVERY_PROJECT = "user-wide";

/** A removal confirmation belongs to the agents' configuration table. */
type Shelf = "table";

/**
 * How long the page keeps looking for a sign-in the user started, and how often: longer than
 * `claude mcp login` may run (six minutes), so its outcome still arrives.
 */
const SIGN_IN_WAIT_MS = 7 * 60_000;
const SIGN_IN_POLL_MS = 2_000;

/** What each agent's column says about how its sign-ins are known. */
const SIGN_IN_NOTE: Readonly<Record<AgentConfiguredServers["signIn"], string | undefined>> = {
  reported: undefined,
  onRequest: "Codex learns its sign-ins only by starting every server, so it checks when you ask.",
  liveOnly:
    "Claude Code's sign-ins show while a Claude thread is running, and it signs in through that thread.",
};

/** `liveOnly`'s note when Claude Code can sign in with no thread running. */
const LIVE_ONLY_THREADLESS_NOTE =
  "Claude Code's sign-ins show while a Claude thread is running. Sign in works without one.";

const signInNote = (agent: AgentConfiguredServers) =>
  agent.signIn === "liveOnly" && agent.threadlessSignIn === true
    ? LIVE_ONLY_THREADLESS_NOTE
    : SIGN_IN_NOTE[agent.signIn];

/** Where the claude.ai connectors listed come from, when no running Claude thread has them. */
const claudeAiNote = (agent: AgentConfiguredServers, now: number): string | undefined => {
  if (agent.claudeAiFrom === "lastSeen") {
    const latest = agent.servers
      .flatMap((server) => (server.seenAt === undefined ? [] : [server.seenAt]))
      .toSorted()
      .at(-1);
    return `claude.ai connectors are as a Claude thread last reported them${
      latest === undefined ? "" : `, ${agoText(latest, now)}`
    }. A running one shows them live.`;
  }
  return agent.claudeAiFrom === "history"
    ? "claude.ai connectors you've used before are listed. A running Claude thread lists all of them, live."
    : undefined;
};

const signInKey = (target: McpTarget, name: string) => `${target}:${name}`;

/** A claude.ai connector's cell when claude.ai turned down Claude Code's own sign-in. */
const CLAUDE_SIGN_IN_AGAIN = "Sign in to Claude again. Run `claude /login`.";

/** A sign-in under way: its page again in case the browser tab got lost. */
interface SignIn {
  readonly url?: string;
}

/** The form, open: blank from "Add server…", or started from another agent's copy of a server. */
interface Adding {
  readonly target?: McpTarget;
  readonly draft?: Partial<McpDraft>;
  readonly note?: string;
}

/**
 * Settings → Connectors: every agent's MCP servers side by side. A view, not a registry: each read
 * is fresh from the agents' own configs, each agent keeps its own servers and its own sign-ins, and
 * opening the page connects to nothing. Unused configured servers are folded away; signing in
 * always stays an explicit action in the chosen agent.
 */
export function ConnectorsSettings() {
  const api = useApi();
  const queryClient = useQueryClient();
  const connectorSignIn = useFeature("claudeAiConnectorSignIn", { settled: true });
  const [folder, setFolder] = useState(EVERY_PROJECT);
  const cwd = folder === EVERY_PROJECT ? undefined : folder;
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  const [signIns, setSignIns] = useState<Readonly<Record<string, SignIn>>>({});
  const [notice, setNotice] = useState<string | undefined>();
  const [adding, setAdding] = useState<Adding | undefined>();
  /** The server a Remove was asked for, confirmed under its row before anything is removed. */
  const [removing, setRemoving] = useState<{
    target: McpTarget;
    server: ConfiguredServer;
    /** The project it was asked for, which a later project switch doesn't change. */
    cwd: string | undefined;
    /** The list it was asked from, which shows the confirmation under that row. */
    from: Shelf;
  }>();
  const [filter, setFilter] = useState("");
  const [signedOutOpen, setSignedOutOpen] = useState<boolean | undefined>();
  const signedOutId = useId();

  const signInsRef = useRef(signIns);
  useEffect(() => {
    signInsRef.current = signIns;
  }, [signIns]);
  /** A sign-in is over once the agent says it holds one, or that the one started here failed. */
  const settleSignIns = (listed: ReadonlyArray<AgentConfiguredServers>) => {
    const over = listed.flatMap(({ target, servers }) =>
      servers.flatMap((server) =>
        (server.signedIn === true || server.signInFailed !== undefined) &&
        signInKey(target, server.name) in signInsRef.current
          ? [{ key: signInKey(target, server.name), target, server }]
          : [],
      ),
    );
    if (over.length === 0) return;
    setSignIns((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([key]) => !over.some((ended) => ended.key === key)),
      ),
    );
    const done = over.filter(({ server }) => server.signedIn === true);
    const failed = over.find(({ server }) => server.signedIn !== true);
    setNotice(
      failed === undefined
        ? `Signed in to ${[...new Set(done.map(({ server }) => server.name))].join(", ")}.`
        : `${MCP_TARGET_LABEL[failed.target]} didn't finish signing in to ${failed.server.name}: ${failed.server.signInFailed}`,
    );
  };

  const waitingOn = (target: McpTarget) =>
    Object.keys(signIns).some((key) => key.startsWith(`${target}:`));
  /**
   * The next read is to be fresh: the user asked to refresh, or acted. Otherwise the server answers
   * with its last read at once and reads again behind it.
   */
  const freshNext = useRef(false);
  const read = async (checkSignIn?: ReadonlyArray<McpTarget>) => {
    // A sign-in under way is watched as it lands, not as of the last read. Asking for sign-ins
    // reads afresh anyway.
    const fresh =
      checkSignIn === undefined &&
      (freshNext.current || Object.keys(signInsRef.current).length > 0);
    freshNext.current = false;
    const listed = await api.listConfiguredConnectors({
      ...(cwd === undefined ? {} : { cwd }),
      ...(checkSignIn === undefined ? {} : { checkSignIn }),
      ...(fresh ? { fresh } : {}),
    });
    settleSignIns(listed.agents);
    return listed;
  };
  const query = useQuery({
    queryKey: ["connectors-configured", cwd],
    queryFn: () => read(),
    retry: false,
    // Codex's sign-in is requested explicitly and Claude Code's comes from a running thread, so both
    // can be watched; asking Codex never is polled. Otherwise the page asks again for the read
    // behind an answer.
    refetchInterval: (current) =>
      waitingOn("claude") ? SIGN_IN_POLL_MS : nextConfiguredRead(current.state.data),
  });
  // Answering makes Codex start and connect every server it has, so this never runs on its own:
  // not on mount, not on a refresh or a project switch, only from `checkCodex`.
  const codexSignIns = useQuery({
    queryKey: ["connectors-codex-sign-ins", cwd],
    queryFn: () => read(["codex"]),
    enabled: false,
    retry: false,
  });
  const { refetch: checkCodex } = codexSignIns;
  const refresh = () => {
    freshNext.current = true;
    return queryClient.invalidateQueries({ queryKey: ["connectors-configured"] });
  };

  const agents = withSignIns(query.data?.agents ?? [], codexSignIns.data?.agents);
  // Ticks only while a row is as of some time, so its age moves on without a read.
  const now = useNow(
    agents.some((agent) => agent.claudeAiFrom === "lastSeen"),
    undefined,
    30_000,
  );
  const agentOf = (target: McpTarget) => agents.find((agent) => agent.target === target);

  // Codex can't be watched, so it's asked once when the user comes back from the browser.
  const waitingOnCodex = waitingOn("codex");
  useEffect(() => {
    if (!waitingOnCodex) return;
    const check = () => void checkCodex();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [waitingOnCodex, checkCodex]);

  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSettled: refresh,
  });

  /** Starts `target`'s own sign-in to its server `name` and opens the page it hands back. */
  const startSignIn = async (target: McpTarget, name: string, scope: string) => {
    const started = await api.signInConnector({
      target,
      name,
      // Picks the Claude session whose server this is, when another of the name shadows it.
      scope,
      ...(cwd === undefined ? {} : { cwd }),
    });
    // claude.ai tells nobody when the user finishes there, so that one isn't waited for.
    if (started.kind !== "onClaudeAi") {
      const key = signInKey(target, name);
      setSignIns((current) => ({
        ...current,
        [key]: started.kind === "open" ? { url: started.authorizationUrl } : {},
      }));
      // The user may never finish; the cell goes back to offering a sign-in.
      setTimeout(
        () =>
          setSignIns((current) =>
            Object.fromEntries(Object.entries(current).filter(([k]) => k !== key)),
          ),
        SIGN_IN_WAIT_MS,
      );
    }
    if (started.kind !== "started") await openExternalUrl(api, started.authorizationUrl);
    return started;
  };

  const signIn = (target: McpTarget, server: ConfiguredServer) =>
    action.mutate(async () => {
      const started: ConnectorSignIn = await startSignIn(target, server.name, server.scope);
      setNotice(
        started.kind === "onClaudeAi"
          ? `Finish signing in to ${server.name} on claude.ai. Claude threads take it up as they start, and it shows here once one reports it.`
          : `Finish signing in to ${server.name} in your browser. ${MCP_TARGET_LABEL[target]} keeps the sign-in; Gram never sees it.`,
      );
    });

  const remove = (target: McpTarget, server: ConfiguredServer, folderCwd: string | undefined) =>
    action.mutate(async () => {
      setRemoving(undefined);
      await api.removeConnector({
        ...(folderCwd === undefined ? {} : { cwd: folderCwd }),
        name: server.name,
        scope: server.scope as McpScope,
        target,
      });
      setNotice(`Removed ${server.name} from ${MCP_TARGET_LABEL[target]}.`);
    });

  /**
   * Copies a server to `target` after reading afresh what it has: the table may be a last read,
   * and a name it has since taken would be replaced, credentials and all.
   */
  const addTo = (row: ConnectorMatrixRow, target: McpTarget) =>
    action.mutate(async () => {
      setNotice(undefined);
      const label = MCP_TARGET_LABEL[target];
      const taken = await freshServersOf(
        (payload) => api.listConfiguredConnectors(payload),
        target,
        cwd,
      );
      const copy = copyTo(row, target, cwd !== undefined, taken);
      if (copy.kind === "present") {
        setNotice(`${label} already has it, as ${copy.name}.`);
        return;
      }
      const name = copy.kind === "form" ? copy.draft.name : row.name;
      if (taken.some((server) => server.name === name)) {
        throw new Error(
          `${label} already has a server called ${name}, which adding this one would replace. Remove that one first, or add this under another name with Add server….`,
        );
      }
      if (copy.kind === "form") {
        setAdding({ target, draft: copy.draft, note: copy.note });
        return;
      }
      await api.addConnector({
        ...(cwd === undefined ? {} : { cwd }),
        scope: copy.scope,
        name: row.name,
        config: copy.config,
        targets: [target],
      });
      setNotice(
        `Added ${row.name} to ${label}. It keeps its own sign-in, so sign in there too if you use it.`,
      );
    });

  const matrix = connectorMatrix(agents, filter);
  const showSignedOut =
    signedOutOpen ??
    (filter.trim() !== "" ||
      Object.keys(signIns).length > 0 ||
      matrix.signedOut.length <= SIGNED_OUT_OPEN_UP_TO);

  const cellFor = (target: McpTarget, row: ConnectorMatrixRow, from: Shelf = "table") => (
    <Cell
      key={target}
      target={target}
      row={row}
      busy={action.isPending}
      signInsUnknown={
        agentOf(target)?.signIn === "onRequest" || agentOf(target)?.threadlessSignIn === true
      }
      signIn={signIns[signInKey(target, row.cells[target]?.name ?? row.name)]}
      claudeAiFrom={agentOf(target)?.claudeAiFrom}
      connectorSignIn={connectorSignIn}
      now={now}
      onSignIn={(server) => signIn(target, server)}
      onOpenSignIn={(url) => void openExternalUrl(api, url)}
      onAdd={() => addTo(row, target)}
      onRemove={(server) => {
        setNotice(undefined);
        setRemoving({ target, server, cwd, from });
      }}
    />
  );

  /** The confirmation of a Remove asked for from `row` in `from`; nothing for any other row. */
  const confirmFor = (row: ConnectorMatrixRow, from: Shelf) =>
    removing !== undefined &&
    removing.from === from &&
    row.cells[removing.target]?.name === removing.server.name &&
    row.cells[removing.target]?.scope === removing.server.scope && (
      <div role="cell" className="col-span-full pt-2">
        <ConfirmStrip
          label={`Remove ${removing.server.name} from ${MCP_TARGET_LABEL[removing.target]}`}
          message={`Remove ${removing.server.name} from ${MCP_TARGET_LABEL[removing.target]}? It comes out of that agent's config, and the other agents keep theirs. A sign-in it had isn't revoked.`}
          confirm="Remove server"
          busy={action.isPending}
          onConfirm={() => remove(removing.target, removing.server, removing.cwd)}
          onKeep={() => setRemoving(undefined)}
        />
      </div>
    );

  const rows = (label: string, listed: ReadonlyArray<ConnectorMatrixRow>) => (
    <div role="rowgroup" aria-label={label}>
      {listed.map((row) => (
        <div
          key={row.name}
          role="row"
          aria-label={row.name}
          data-testid="configured-connector"
          className="grid grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))] items-start gap-x-3 border-t border-border px-3 py-2 text-xs"
        >
          <div role="rowheader" className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-mono">{row.name}</span>
            {row.address !== undefined && (
              <span className="truncate text-muted-foreground" title={row.address}>
                {row.address}
              </span>
            )}
            {row.cells.claude?.tools !== undefined && (
              <ConnectorTools name={row.name} tools={row.cells.claude.tools} />
            )}
          </div>
          {MCP_TARGETS.map((target) => cellFor(target, row))}
          {confirmFor(row, "table")}
        </div>
      ))}
    </div>
  );

  return (
    <div data-testid="connectors-settings" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={folder}
          items={[
            { value: EVERY_PROJECT, label: "Every project" },
            ...projects.map((project) => ({ value: project.root, label: project.name })),
          ]}
          onValueChange={(value) => {
            setFolder(value ?? EVERY_PROJECT);
            setRemoving(undefined);
            setAdding(undefined);
          }}
        >
          <SelectTrigger aria-label="Show servers for" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={EVERY_PROJECT}>Every project</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.root}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {cwd === undefined
            ? "Servers you have in every project. Pick a project to see its own as well."
            : "With this project's own servers."}
        </span>
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
        <div className="overflow-hidden rounded-lg border border-border">
          {adding.note !== undefined && (
            <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
              {adding.note}
            </p>
          )}
          <AddConnectorForm
            key={`${adding.target ?? "new"}:${adding.draft?.name ?? ""}`}
            cwd={cwd}
            agent={adding.target}
            initial={adding.draft}
            onCancel={() => setAdding(undefined)}
            onAdded={(message) => {
              setAdding(undefined);
              setNotice(message);
              void refresh();
            }}
          />
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {action.error && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(action.error)}
        </p>
      )}
      {matrix.total > FILTER_FROM && (
        <input
          type="search"
          aria-label="Filter connectors"
          placeholder="Filter by name"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      )}

      {query.isPending ? (
        <p className="text-sm text-muted-foreground">Reading each agent&rsquo;s config…</p>
      ) : query.isError ? (
        <QueryError error={query.error} feature="Connectors" />
      ) : (
        <div
          role="table"
          aria-label="MCP servers by agent"
          className="overflow-hidden rounded-lg border border-border"
        >
          <div role="rowgroup">
            <div
              role="row"
              className="grid grid-cols-[minmax(0,1.4fr)_repeat(2,minmax(0,1fr))] items-center gap-x-3 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground"
            >
              <span role="columnheader">Server</span>
              {MCP_TARGETS.map((target) => {
                const agent = agentOf(target);
                return (
                  <span
                    key={target}
                    role="columnheader"
                    className="flex min-w-0 flex-wrap items-center gap-x-1.5"
                    title={agent === undefined ? undefined : signInNote(agent)}
                  >
                    {MCP_TARGET_LABEL[target]}
                    {agent?.signIn === "onRequest" && agent.servers.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 px-1 text-xs"
                        disabled={codexSignIns.isFetching}
                        title={SIGN_IN_NOTE.onRequest}
                        onClick={() => void checkCodex()}
                      >
                        {codexSignIns.isFetching ? "Checking…" : "Check sign-ins"}
                      </Button>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
          {agents.flatMap((agent) =>
            agent.error === undefined
              ? []
              : [
                  <p
                    key={agent.target}
                    className="border-t border-border px-3 py-2 text-xs text-muted-foreground"
                  >
                    Couldn&rsquo;t read {MCP_TARGET_LABEL[agent.target]}&rsquo;s config:{" "}
                    {agent.error}
                  </p>,
                ],
          )}
          {matrix.total === 0 ? (
            <p className="border-t border-border px-3 py-3 text-xs text-muted-foreground">
              No agent has an MCP server yet. “Add server…” sets one up.
            </p>
          ) : matrix.inUse.length + matrix.signedOut.length === 0 ? (
            <p className="border-t border-border px-3 py-3 text-xs text-muted-foreground">
              No server matches “{filter.trim()}”.
            </p>
          ) : (
            <>
              {rows("Servers", matrix.inUse)}
              {matrix.signedOut.length > 0 && (
                <>
                  <button
                    type="button"
                    aria-expanded={showSignedOut}
                    aria-controls={signedOutId}
                    onClick={() => setSignedOutOpen(!showSignedOut)}
                    className="flex w-full items-center gap-1.5 border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
                  >
                    <ChevronRight
                      aria-hidden
                      className={cn(
                        "size-3.5 shrink-0 motion-safe:transition-transform",
                        showSignedOut && "rotate-90",
                      )}
                    />
                    <span>Not signed in</span>
                    <span className="tabular-nums">· {matrix.signedOut.length}</span>
                    <span className="ml-auto truncate opacity-70">
                      Sign in to the ones you need
                    </span>
                  </button>
                  <div id={signedOutId} hidden={!showSignedOut}>
                    {rows("Servers not signed in", matrix.signedOut)}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
        {agents.flatMap((agent) =>
          [signInNote(agent), claudeAiNote(agent, now), agent.claudeAiUnavailable].flatMap(
            (note, i) => (note === undefined ? [] : [<li key={`${agent.target}-${i}`}>{note}</li>]),
          ),
        )}
      </ul>
    </div>
  );
}

function Cell({
  target,
  row,
  busy,
  signInsUnknown,
  signIn,
  claudeAiFrom,
  connectorSignIn,
  now,
  onSignIn,
  onOpenSignIn,
  onAdd,
  onRemove,
}: {
  target: McpTarget;
  row: ConnectorMatrixRow;
  busy: boolean;
  /**
   * The agent can sign in to a server whose state it hasn't said: Codex until it's asked, Claude
   * Code with no thread running. "Unknown" may well mean "not signed in" there.
   */
  signInsUnknown: boolean;
  /** Present while the user is signing this agent in to the server in their browser. */
  signIn: SignIn | undefined;
  /** Where the agent's claude.ai connectors come from (`AgentConfiguredServers.claudeAiFrom`). */
  claudeAiFrom: ClaudeAiSource | undefined;
  /** A claude.ai connector can be signed in to with no Claude thread running. */
  connectorSignIn: boolean;
  /** The time a row's "as of" is counted from (`useNow`). */
  now: number;
  onSignIn: (server: ConfiguredServer) => void;
  onOpenSignIn: (url: string) => void;
  onAdd: () => void;
  onRemove: (server: ConfiguredServer) => void;
}) {
  const label = MCP_TARGET_LABEL[target];
  const server = row.cells[target];
  if (server === undefined) {
    return (
      <div role="cell" className="flex min-w-0 items-center">
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={busy}
          aria-label={`Add ${row.name} to ${label}`}
          onClick={onAdd}
        >
          <Plus data-icon="inline-start" />
          Add
        </Button>
      </div>
    );
  }

  const hosted = server.scope === "claudeai";
  // No running Claude thread has it: the row is what one last said, or that it was used before.
  const threadless = hosted && claudeAiFrom !== undefined && claudeAiFrom !== "thread";
  // A connector sign-in cannot fix the agent's login or the server's access policy.
  const signInWontHelp =
    server.claudeAi?.claudeSignInRejected === true || server.claudeAi?.blocked !== undefined;
  const waiting = signIn !== undefined && server.signedIn !== true;
  const mayNeedSignIn =
    !signInWontHelp &&
    (server.signedIn === false ||
      (server.signedIn === undefined && threadless) ||
      (server.signedIn === undefined &&
        signInsUnknown &&
        !hosted &&
        server.url !== undefined &&
        !server.carriesValues));
  const signInHere = !threadless || connectorSignIn;
  // Glyph and words together, and "not signed in" in the same muted tone as everything else here.
  const signedIn = server.signedIn === true;
  const state = server.disabled
    ? { icon: CircleOff, text: "Disabled", tone: "text-muted-foreground" }
    : server.signedIn === true
      ? { icon: CircleCheck, text: "Signed in", tone: "text-success" }
      : server.signedIn === false
        ? {
            icon: KeyRound,
            // Signed in once, so its sign-in lapsed, rather than one never used.
            text: hosted && server.everConnected === true ? "Signed out" : "Not signed in",
            tone: "text-muted-foreground",
          }
        : threadless && server.everConnected === true
          ? { icon: Check, text: "Used before", tone: "text-muted-foreground" }
          : { icon: Check, text: "Configured", tone: "text-muted-foreground" };
  const actions: RowAction[] =
    !waiting && isRemovable(target, server)
      ? [
          {
            label: `Remove from ${label}…`,
            icon: Trash2,
            danger: true,
            disabled: busy,
            onSelect: () => onRemove(server),
          },
        ]
      : [];
  return (
    <RowContextMenu
      actions={actions}
      render={<div role="cell" className="flex min-w-0 flex-col items-start gap-1" />}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {waiting ? (
          <Spinner aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <state.icon aria-hidden className={cn("size-3.5 shrink-0", state.tone)} />
        )}
        <span className={cn(!signedIn && "text-muted-foreground")}>
          {waiting ? "Waiting for sign-in…" : state.text}
        </span>
        {server.seenAt !== undefined && !waiting && (
          <span
            className="text-muted-foreground"
            title={`As a Claude thread reported it at ${formatMessageTime(Date.parse(server.seenAt))}`}
          >
            as of {agoText(server.seenAt, now)}
          </span>
        )}
        <Badge
          variant="outline"
          title={hosted ? "A claude.ai connector: it works in Claude threads only." : undefined}
        >
          {hosted ? "claude.ai" : server.scope}
        </Badge>
        <ClaudeAiMarks claudeAi={server.claudeAi} />
      </div>
      {server.claudeAi?.claudeSignInRejected === true && (
        <span className="text-muted-foreground">
          <CommandText text={CLAUDE_SIGN_IN_AGAIN} />
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1 empty:hidden">
        {waiting && signIn.url !== undefined && (
          <Button size="sm" variant="ghost" onClick={() => onOpenSignIn(signIn.url!)}>
            Open page again
          </Button>
        )}
        {!waiting && mayNeedSignIn && !server.disabled && !signInHere && (
          <span className="text-muted-foreground">Open a Claude thread to sign in</span>
        )}
        {!waiting && mayNeedSignIn && !server.disabled && signInHere && (
          <Button
            size="sm"
            variant={server.signedIn === false ? "outline" : "ghost"}
            disabled={busy}
            aria-label={`Sign in to ${row.name} in ${label}`}
            onClick={() => onSignIn(server)}
          >
            Sign in
          </Button>
        )}
        <RowMenuButton label={`${row.name} in ${label} actions`} actions={actions} />
      </div>
    </RowContextMenu>
  );
}
