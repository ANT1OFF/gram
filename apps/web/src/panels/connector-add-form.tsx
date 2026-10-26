import {
  MCP_TARGET_LABEL,
  restartOnMcpChangeOn,
  type McpScope,
  type McpTarget,
  type ThreadId,
} from "@gram/contracts";
import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useApi } from "@/api/context";
import { useServerSettings } from "@/settings-sync/store";
import { errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  configFromDraft,
  configFromJson,
  EMPTY_DRAFT,
  placementHints,
  targetProblem,
  type McpDraft,
  type McpTransport,
} from "./mcp-config";

const TRANSPORTS: { value: McpTransport; label: string }[] = [
  { value: "http", label: "HTTP" },
  { value: "sse", label: "SSE" },
  { value: "stdio", label: "Command" },
];

const SCOPES: { value: McpScope; label: string }[] = [
  { value: "local", label: "Local" },
  { value: "project", label: "Project" },
  { value: "user", label: "User" },
];

const TARGETS: ReadonlyArray<McpTarget> = ["claude", "codex"];

const FIELD =
  "w-full rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";

function Choices<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className="rounded-sm border border-border px-2 py-0.5 text-muted-foreground aria-checked:border-ring aria-checked:bg-accent aria-checked:text-foreground"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground">
        {label}
        {hint && <span className="ml-1 opacity-70">({hint})</span>}
      </span>
      {children}
    </label>
  );
}

/** A captioned radio group; not a `<label>`, which would rename every choice after the caption. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span aria-hidden className="text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * An inline "add an MCP server" form for the Connectors panel and Settings → Connectors: fields
 * per transport or a pasted JSON entry, which agents get it, and where each should keep it. Every
 * agent holds its own copy and its own sign-in, so one server ticked for three agents is signed in
 * to three times. Env and header values stay in the form; after adding, only the server's name is
 * shown.
 */
export function AddConnectorForm({
  threadId,
  cwd,
  agent,
  initial,
  onAdded,
  onCancel,
}: {
  /** The thread whose checkout a per-project scope means. Absent in Settings. */
  threadId?: ThreadId | undefined;
  /** With no thread: the project folder. With neither, only the `user` scope exists. */
  cwd?: string | undefined;
  /** The thread's agent, ticked to begin with; Claude Code when it has no config to write. */
  agent?: McpTarget | undefined;
  /** A server to start from, as when copying one agent's server to another. */
  initial?: Partial<McpDraft> | undefined;
  onAdded: (message: string) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const restartsLive = useServerSettings(
    (s) => s.settings === undefined || restartOnMcpChangeOn(s.settings),
  );
  const placed = threadId !== undefined || cwd !== undefined;
  const [mode, setMode] = useState<"fields" | "json">("fields");
  const [draft, setDraft] = useState<McpDraft>({ ...EMPTY_DRAFT, ...initial });
  const [json, setJson] = useState("");
  const [scope, setScope] = useState<McpScope>(placed ? "local" : "user");
  const [targets, setTargets] = useState<ReadonlyArray<McpTarget>>([agent ?? "claude"]);
  const toggleTarget = (target: McpTarget) =>
    setTargets((current) =>
      TARGETS.filter((t) => (t === target ? !current.includes(t) : current.includes(t))),
    );
  const [problem, setProblem] = useState<string | undefined>();
  const set = (patch: Partial<McpDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const add = useMutation({
    mutationFn: (server: Exclude<ReturnType<typeof configFromDraft>, { error: string }>) =>
      api.addConnector({
        ...(threadId === undefined ? {} : { threadId }),
        ...(threadId === undefined && cwd !== undefined ? { cwd } : {}),
        scope,
        name: server.name,
        config: server.config,
        targets: targets as [McpTarget, ...McpTarget[]],
      }),
    onSuccess: (result) => {
      const where =
        threadId !== undefined && targets.length === 1 && targets[0] === agent
          ? ""
          : ` to ${targets.map((t) => MCP_TARGET_LABEL[t]).join(", ")}`;
      // Only the thread's own agent loads it here; the others pick it up in their own threads.
      const here =
        threadId === undefined
          ? restartsLive
            ? "Running threads that use it load it too."
            : "Threads pick it up when they next start."
          : agent !== undefined && !targets.includes(agent)
            ? "This thread's agent wasn't one of them, so it won't appear here."
            : result.session === "applied"
              ? "The session loaded it."
              : result.session === "reopening"
                ? "The session reopens once it's idle to connect it."
                : "It connects when the thread starts.";
      onAdded(`Added ${result.name}${where}. ${here}`);
    },
  });

  const submit = () => {
    const parsed = mode === "json" ? configFromJson(json, draft.name) : configFromDraft(draft);
    const blocked = "error" in parsed ? parsed.error : targetProblem(targets, parsed.config.type);
    if ("error" in parsed || blocked !== undefined) {
      setProblem(blocked);
      return;
    }
    setProblem(undefined);
    add.mutate(parsed);
  };

  const error = problem ?? (add.error ? errorMessage(add.error) : undefined);

  return (
    <form
      aria-label="Add MCP server"
      data-testid="connector-add-form"
      className="flex flex-col gap-2.5 border-b border-border bg-muted/30 px-3 py-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Add an MCP server</span>
        <Choices
          label="Input"
          value={mode}
          options={[
            { value: "fields", label: "Fields" },
            { value: "json", label: "Paste JSON" },
          ]}
          onChange={setMode}
        />
      </div>

      <Field label="Name" hint={mode === "json" ? "or from mcpServers" : undefined}>
        <input
          aria-label="Server name"
          className={FIELD}
          value={draft.name}
          placeholder="sentry"
          autoComplete="off"
          onChange={(event) => set({ name: event.target.value })}
        />
      </Field>

      {mode === "fields" ? (
        <>
          <Group label="Transport">
            <Choices
              label="Transport"
              value={draft.transport}
              options={TRANSPORTS}
              onChange={(transport) => set({ transport })}
            />
          </Group>
          {draft.transport === "stdio" ? (
            <>
              <Field label="Command">
                <input
                  aria-label="Command"
                  className={FIELD}
                  value={draft.command}
                  placeholder="npx"
                  autoComplete="off"
                  onChange={(event) => set({ command: event.target.value })}
                />
              </Field>
              <Field label="Arguments" hint="one per line">
                <textarea
                  aria-label="Arguments"
                  rows={2}
                  className={FIELD}
                  value={draft.args}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                  spellCheck={false}
                  onChange={(event) => set({ args: event.target.value })}
                />
              </Field>
              <Field label="Environment" hint="KEY=value per line">
                <textarea
                  aria-label="Environment"
                  rows={2}
                  className={FIELD}
                  value={draft.env}
                  placeholder="API_KEY=…"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => set({ env: event.target.value })}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="URL">
                <input
                  aria-label="URL"
                  className={FIELD}
                  value={draft.url}
                  placeholder="https://organization.example.invalid/mcp"
                  autoComplete="off"
                  onChange={(event) => set({ url: event.target.value })}
                />
              </Field>
              <Field label="Headers" hint="Name: value per line">
                <textarea
                  aria-label="Headers"
                  rows={2}
                  className={FIELD}
                  value={draft.headers}
                  placeholder="Authorization: Bearer …"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => set({ headers: event.target.value })}
                />
              </Field>
            </>
          )}
        </>
      ) : (
        <Field label="Server JSON">
          <textarea
            aria-label="Server JSON"
            rows={5}
            className={FIELD}
            value={json}
            placeholder={'{"type": "http", "url": "https://organization.example.invalid/mcp"}'}
            spellCheck={false}
            onChange={(event) => setJson(event.target.value)}
          />
        </Field>
      )}

      <Group label="Add to">
        <div role="group" aria-label="Add to" className="flex flex-wrap gap-1">
          {TARGETS.map((target) => (
            <button
              key={target}
              type="button"
              role="checkbox"
              aria-checked={targets.includes(target)}
              onClick={() => toggleTarget(target)}
              className="flex items-center gap-1 rounded-sm border border-border px-2 py-0.5 text-muted-foreground aria-checked:border-ring aria-checked:bg-accent aria-checked:text-foreground"
            >
              {targets.includes(target) && <Check aria-hidden className="size-3" />}
              {MCP_TARGET_LABEL[target]}
            </button>
          ))}
        </div>
      </Group>
      <Group label="Scope">
        <Choices
          label="Scope"
          value={scope}
          options={placed ? SCOPES : SCOPES.filter((option) => option.value === "user")}
          onChange={setScope}
        />
      </Group>
      <ul className="flex flex-col gap-0.5 text-muted-foreground" data-testid="scope-hint">
        {placementHints(targets, scope).map((hint) => (
          <li key={hint}>{hint}</li>
        ))}
        {targets.length > 1 && (
          <li>Each agent keeps its own sign-in, so you sign in once in each.</li>
        )}
      </ul>

      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className={cn("flex justify-end gap-2")}>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={add.isPending}>
          {add.isPending ? "Adding…" : "Add server"}
        </Button>
      </div>
    </form>
  );
}
