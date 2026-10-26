import {
  gatewayModelUsable,
  helperChoice,
  type GatewayProfile,
  type ProfileId,
  type SetKeyResult,
  type VaultInfo,
} from "@gram/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { KeyRound, Pencil, ShieldCheck, Star, Trash2, TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion";
import { useShowCost } from "@/usage/cost";

import { ConfirmStrip } from "./confirm-strip";
import { Toggle, WhyDisabled } from "./fields";
import { RowContextMenu, RowMenuButton, type RowAction } from "./row-menu";
import { SettingsGroup } from "./settings-group";
import { useSaveSettings } from "./use-save-settings";

const OPENCODE = "OpenCode";
const labelCls = "text-xs font-medium text-muted-foreground";
const inputCls =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const noteCls = "flex items-start gap-1.5 text-xs text-muted-foreground";
const noteIconCls = "mt-px size-3.5 shrink-0";

/** A url-safe id for a new profile, derived from its name and unique among `taken`. */
export function profileIdFor(name: string, taken: ReadonlySet<string>): ProfileId {
  const base =
    name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "") || "gateway";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id as ProfileId;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** What adding a gateway did with the key typed into the form. */
interface AddOutcome {
  readonly profileId: ProfileId;
  readonly result?: SetKeyResult;
}

/** Profiles and the model lists derived from them. */
function useInvalidateProfiles() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["profiles"] }),
      queryClient.invalidateQueries({ queryKey: ["models"] }),
    ]);
  };
}

/** Settings → Gateways: OpenAI-compatible gateway profiles for non-Claude agents and helper calls. */
export function GatewaysSettings() {
  const api = useApi();
  const invalidate = useInvalidateProfiles();
  const {
    data: profiles,
    error,
    isPending,
  } = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api.listProfiles(),
  });
  const { data: vault } = useQuery({
    queryKey: ["vault-info"],
    queryFn: () => api.vaultInfo(),
    staleTime: Infinity,
  });
  const seed = useMutation({
    mutationFn: () => api.seedProfiles(),
    onSuccess: invalidate,
  });
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<AddOutcome | undefined>();
  const taken = new Set<string>(profiles?.map((p) => p.id) ?? []);

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(error)}
        </p>
      )}
      {isPending && <p className="text-sm text-muted-foreground">Loading gateways…</p>}
      {profiles?.length === 0 && !adding && (
        <p className="text-sm text-muted-foreground">No gateways yet.</p>
      )}
      {profiles && profiles.length > 0 && (
        <ul aria-label="Gateway profiles" className="flex flex-col gap-3">
          {profiles.map((profile) => (
            <li key={profile.id}>
              <ProfileCard
                profile={profile}
                vault={vault}
                added={added?.profileId === profile.id ? added : undefined}
              />
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <ProfileForm
          taken={taken}
          onDone={(outcome) => {
            setAdding(false);
            setAdded(outcome);
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add gateway
          </Button>
          {profiles?.length === 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={seed.isPending}
              onClick={() => seed.mutate()}
            >
              Import gateway profiles from OpenCode and Codex settings
            </Button>
          )}
        </div>
      )}
      {seed.data && (
        <p role="status" className="text-sm text-muted-foreground">
          {seed.data.added === 0
            ? "Nothing to import"
            : `Added ${plural(seed.data.added, "gateway")}`}
        </p>
      )}
      {seed.error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(seed.error)}
        </p>
      )}
      <ShowCostToggle />
    </div>
  );
}

/**
 * Dollars for threads on a gateway's key, off by default: subscription threads are measured by the
 * title bar's usage meter, never in dollars.
 */
function ShowCostToggle() {
  const checked = useShowCost();
  const save = useSaveSettings();
  const [error, setError] = useState<string>();
  return (
    <SettingsGroup label="Cost">
      <Toggle
        label="Show dollar cost"
        description="Gateway threads only."
        keywords={["dollars", "price", "spend", "usd", "api key"]}
        checked={checked}
        error={error}
        onReset={checked ? () => void save({ appearance: { showCost: false } }) : undefined}
        onChange={(showCost) => {
          setError(undefined);
          save({ appearance: { showCost } }).catch((e: unknown) => setError(errorMessage(e)));
        }}
      />
    </SettingsGroup>
  );
}

/** Name and base URL for a new profile, or for `existing`; a new one can take its key too. */
function ProfileForm({
  existing,
  taken,
  onDone,
}: {
  existing?: GatewayProfile;
  taken: ReadonlySet<string>;
  onDone: (outcome?: AddOutcome) => void;
}) {
  const api = useApi();
  const invalidate = useInvalidateProfiles();
  const keyId = useId();
  const [name, setName] = useState(existing?.name ?? "");
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? "");
  const [catalog, setCatalog] = useState(existing?.modelCatalogURL ?? "");
  const [key, setKey] = useState("");
  // Once saved, a retry after a failed key save updates the same profile rather than adding another.
  const [savedId, setSavedId] = useState<ProfileId | undefined>();
  // The key is read from state, never passed as a mutation variable, so it stays out of the cache.
  const save = useMutation({
    mutationFn: async (): Promise<AddOutcome> => {
      const previous = existing === undefined ? undefined : { ...existing };
      if (previous) delete previous.modelCatalogURL;
      const metadata = catalog.trim() === "" ? {} : { modelCatalogURL: catalog.trim() };
      const saved = await api.upsertProfile(
        existing
          ? {
              ...previous!,
              name: name.trim(),
              baseURL: baseURL.trim(),
              ...metadata,
            }
          : {
              id: savedId ?? profileIdFor(name, taken),
              name: name.trim(),
              baseURL: baseURL.trim(),
              ...metadata,
              keyRef: "",
              models: [],
            },
      );
      setSavedId(saved.id);
      if (existing || key === "") return { profileId: saved.id };
      return { profileId: saved.id, result: await api.setProfileKey(saved.id, key) };
    },
    onSuccess: async (outcome) => {
      setKey("");
      await invalidate();
      onDone(outcome);
    },
    onError: invalidate,
  });
  const valid = name.trim() !== "" && /^https?:\/\/\S+$/.test(baseURL.trim());
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate();
  };

  return (
    <form
      aria-label={existing ? `Edit ${existing.name}` : "Add gateway"}
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
    >
      <label className="flex flex-col gap-1">
        <span className={labelCls}>Name</span>
        <input
          className={inputCls}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelCls}>Base URL</span>
        <input
          className={cn(inputCls, "font-mono text-xs")}
          placeholder="https://gateway.example.com/v1"
          value={baseURL}
          onChange={(event) => setBaseURL(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelCls}>Model metadata URL (optional)</span>
        <input
          className={inputCls}
          value={catalog}
          onChange={(event) => setCatalog(event.target.value)}
          placeholder="https://gateway.example.com/model-info"
        />
        <span className="text-xs text-muted-foreground">
          Only if your gateway documents a public metadata endpoint. Gram sends no key to this URL.
        </span>
      </label>
      {!existing && (
        <div className="flex flex-col gap-1">
          <label htmlFor={keyId} className={labelCls}>
            API key (optional)
          </label>
          <input
            id={keyId}
            type="password"
            autoComplete="off"
            className={inputCls}
            placeholder="Paste an API key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <span className="text-xs text-muted-foreground">
            Gram stores it once and never shows it again.
          </span>
        </div>
      )}
      {save.error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(save.error)}
        </p>
      )}
      <div className="flex gap-2">
        <WhyDisabled reason={valid ? undefined : "Give it a name and an http(s) base URL first."}>
          <Button type="submit" size="sm" disabled={!valid || save.isPending}>
            Save gateway
          </Button>
        </WhyDisabled>
        <Button type="button" size="sm" variant="ghost" onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ProfileCard({
  profile,
  vault,
  added,
}: {
  profile: GatewayProfile;
  vault: VaultInfo | undefined;
  /** What the add form did with this profile's key, when it was just added. */
  added: AddOutcome | undefined;
}) {
  const api = useApi();
  const invalidate = useInvalidateProfiles();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const setDefault = useMutation({
    mutationFn: () => api.upsertProfile({ ...profile, default: true }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api.removeProfile(profile.id),
    onSuccess: invalidate,
  });
  const error = setDefault.error ?? remove.error;
  const actions: RowAction[] = [
    ...(profile.default
      ? []
      : [{ label: "Set as default", icon: Star, onSelect: () => setDefault.mutate() }]),
    {
      label: editing ? "Close editor" : "Edit",
      icon: Pencil,
      onSelect: () => setEditing((open) => !open),
    },
    { label: "Remove…", icon: Trash2, danger: true, onSelect: () => setRemoving(true) },
  ];

  return (
    <article
      aria-label={profile.name}
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
    >
      <RowContextMenu
        actions={actions}
        render={<header className="flex flex-wrap items-center gap-2" />}
      >
        <h3 className="text-sm font-medium">{profile.name}</h3>
        {profile.default && <Badge variant="secondary">Default</Badge>}
        <span className="ml-auto">
          <RowMenuButton label={`Gateway ${profile.name} actions`} actions={actions} />
        </span>
      </RowContextMenu>
      <p className="font-mono text-xs text-muted-foreground">{profile.baseURL}</p>
      {removing && (
        <ConfirmStrip
          label={`Remove ${profile.name}`}
          message={`Remove ${profile.name}? Its stored key is deleted too.`}
          confirm="Remove gateway"
          busy={remove.isPending}
          onConfirm={() => remove.mutate()}
          onKeep={() => setRemoving(false)}
        />
      )}
      {editing && (
        <ProfileForm existing={profile} taken={new Set()} onDone={() => setEditing(false)} />
      )}
      <KeyField profile={profile} vault={vault} addedResult={added?.result} />
      <ImportKey profile={profile} vault={vault} />
      <Models profile={profile} />
      <HelperModel profile={profile} />
      {error !== undefined && error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(error)}
        </p>
      )}
    </article>
  );
}

/** A stored key's status line, per vault kind. */
const SAVED_IN: Record<VaultInfo["kind"], string> = {
  keychain: "Saved securely in the macOS Keychain",
  dpapi: "Encrypted with Windows data protection for your account",
  libsecret: "Saved securely in the system keyring",
  unencrypted:
    "Stored unencrypted: no system keyring is available, so anyone who can read your files can read the key",
  memory: "Not saved: the key is kept only while the server runs",
};

/** Whether the profile has a key, and where it's kept; never by colour alone. */
function KeyStatus({ profile, vault }: { profile: GatewayProfile; vault: VaultInfo | undefined }) {
  if (profile.keyRef === "") {
    return (
      <p className={noteCls}>
        <KeyRound aria-hidden className={noteIconCls} />
        No API key yet
      </p>
    );
  }
  const Icon =
    vault && (!vault.persisted || vault.kind === "unencrypted") ? TriangleAlert : ShieldCheck;
  return (
    <p className={noteCls}>
      <Icon aria-hidden className={noteIconCls} />
      {vault ? SAVED_IN[vault.kind] : "API key saved"}
    </p>
  );
}

/** What saving a key set off: the models found, or why listing them failed, and a new default. */
function KeyResultNote({ result }: { result: SetKeyResult }) {
  const failed = result.discoveryError !== undefined;
  const sentences = [
    ...(failed ? [`The key is saved, but listing models failed: ${result.discoveryError}`] : []),
    ...(!failed && result.discovered !== undefined
      ? [`Found ${plural(result.discovered, "model")}.`]
      : []),
    ...(result.madeDefault ? ["This is now the default gateway."] : []),
  ];
  if (sentences.length === 0) return null;
  const Icon = failed ? TriangleAlert : ShieldCheck;
  return (
    <p role="status" className={noteCls}>
      <Icon aria-hidden className={noteIconCls} />
      {sentences.join(" ")}
    </p>
  );
}

/**
 * The profile's API key, write-only: a typed key is sent to the server and cleared from the field,
 * and nothing ever reads it back.
 */
function KeyField({
  profile,
  vault,
  addedResult,
}: {
  profile: GatewayProfile;
  vault: VaultInfo | undefined;
  addedResult: SetKeyResult | undefined;
}) {
  const api = useApi();
  const invalidate = useInvalidateProfiles();
  const keyId = useId();
  const [key, setKey] = useState("");
  const keySet = profile.keyRef !== "";
  // The mutation's variable is only "clear or not", so the key never lands in the query cache.
  const save = useMutation({
    mutationFn: (clear: boolean) => api.setProfileKey(profile.id, clear ? "" : key),
    onSuccess: async () => {
      setKey("");
      await invalidate();
    },
  });
  const result = save.isIdle ? addedResult : save.variables === false ? save.data : undefined;

  return (
    <form
      aria-label={`API key for ${profile.name}`}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (key !== "") save.mutate(false);
      }}
    >
      <KeyStatus profile={profile} vault={vault} />
      <label htmlFor={keyId} className={labelCls}>
        API key
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={keyId}
          type="password"
          autoComplete="off"
          className={cn(inputCls, "max-w-xs")}
          placeholder={keySet ? "Enter a new key to replace it" : "Paste an API key"}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <WhyDisabled reason={key === "" ? "Paste a key first." : undefined}>
          <Button type="submit" size="sm" variant="outline" disabled={key === "" || save.isPending}>
            {keySet ? "Replace key" : "Save key"}
          </Button>
        </WhyDisabled>
        {keySet && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => save.mutate(true)}
          >
            Remove key
          </Button>
        )}
      </div>
      {result && <KeyResultNote result={result} />}
      {save.error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(save.error)}
        </p>
      )}
    </form>
  );
}

/** Imports the key from OpenCode's `auth.json`, only after the user agrees to that read. */
function ImportKey({ profile, vault }: { profile: GatewayProfile; vault: VaultInfo | undefined }) {
  const api = useApi();
  const invalidate = useInvalidateProfiles();
  const [consenting, setConsenting] = useState(false);
  const importKey = useMutation({
    mutationFn: () => api.importProfileKey(profile.id),
    onSuccess: async (result) => {
      setConsenting(false);
      if (result.imported) await invalidate();
    },
  });

  return (
    <div className="flex flex-col gap-2">
      {consenting ? (
        <div
          role="group"
          aria-label={`Import key from ${OPENCODE}`}
          className="flex flex-col gap-2 rounded-md border border-border p-2 text-sm"
        >
          <p>
            Gram will read this gateway's API key from{" "}
            <code className="font-mono text-xs">~/.local/share/opencode/auth.json</code> and store
            it in {vault?.label ?? "Gram's key store"}. The key isn't shown here.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={importKey.isPending} onClick={() => importKey.mutate()}>
              Import key
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConsenting(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              importKey.reset();
              setConsenting(true);
            }}
          >
            Import key from {OPENCODE}…
          </Button>
          {importKey.data?.imported === false && (
            <span className="text-xs text-muted-foreground">
              {OPENCODE} has no key for this gateway.
            </span>
          )}
        </div>
      )}
      {importKey.error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(importKey.error)}
        </p>
      )}
    </div>
  );
}

function Models({ profile }: { profile: GatewayProfile }) {
  const api = useApi();
  const invalidate = useInvalidateProfiles();
  const keySet = profile.keyRef !== "";
  const discover = useMutation({
    mutationFn: () => api.discoverProfileModels(profile.id),
    onSuccess: invalidate,
  });
  const count = profile.models.length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{plural(count, "model")}</span>
        <WhyDisabled reason={keySet ? undefined : "Set a key first."}>
          <Button
            size="sm"
            variant="outline"
            disabled={!keySet || discover.isPending}
            onClick={() => discover.mutate()}
          >
            {discover.isPending && <Spinner data-icon="inline-start" />}
            {discover.isPending ? "Discovering…" : "Discover models"}
          </Button>
        </WhyDisabled>
      </div>
      {discover.error && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(discover.error)}
        </p>
      )}
      {count > 0 && (
        <ul aria-label={`Models for ${profile.name}`} className="flex flex-wrap gap-1">
          {profile.models.map((model) => {
            const usable = gatewayModelUsable(model);
            return (
              <li key={model.id}>
                <Badge
                  variant="outline"
                  className={cn("font-mono", !usable && "text-muted-foreground line-through")}
                  title={usable ? undefined : NOT_FOR_AGENTS}
                >
                  {model.name}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Why a discovered model is struck through: the pickers leave it out. */
const NOT_FOR_AGENTS =
  "Not offered to agents: the gateway says it isn't a chat model with tools, or is deprecated or restricted";

/** On the default profile: where its helper models are picked now. */
function HelperModel({ profile }: { profile: GatewayProfile }) {
  if (profile.default !== true || profile.models.length === 0) return null;
  const choice = helperChoice(profile);
  return (
    <p className="text-xs text-muted-foreground">
      Gateway helper model when selected: {choice?.model ?? "none"}. The rest is in{" "}
      <Link to="/settings/ai-helpers" className="underline underline-offset-2">
        AI helpers
      </Link>
      .
    </p>
  );
}
