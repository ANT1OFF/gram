import {
  gatewayModelUsable,
  helperChoice,
  NO_KEYRING_MESSAGE,
  OPENROUTER_BASE_URL,
  type GatewayProfile,
  ProfileId,
  type SetKeyResult,
  type VaultInfo,
} from "@gram/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ExternalLink,
  KeyRound,
  Pencil,
  Route,
  ShieldCheck,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { openExternalUrl } from "@/api/open-external";
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
const labelCls = "text-meta font-medium text-muted-foreground";
const inputCls =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-reading outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const noteCls = "flex items-start gap-1.5 text-meta text-muted-foreground";
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
  return ProfileId.make(id);
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

interface AddOutcome {
  readonly profileId: ProfileId;
  readonly result?: SetKeyResult;
}

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
        <p role="alert" className="text-reading text-destructive">
          {errorMessage(error)}
        </p>
      )}
      {isPending && <p className="text-reading text-muted-foreground">Loading gateways…</p>}
      {profiles?.length === 0 && !adding && (
        <p className="text-reading text-muted-foreground">No gateways yet.</p>
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
      {profiles !== undefined && !profiles.some((profile) => profile.kind === "openrouter") && (
        <AddOpenRouter taken={taken} noKeyring={vault?.kind === "no-keyring"} onDone={setAdded} />
      )}
      {adding ? (
        <ProfileForm
          taken={taken}
          noKeyring={vault?.kind === "no-keyring"}
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
        <p role="status" className="text-reading text-muted-foreground">
          {seed.data.added === 0
            ? "Nothing to import"
            : `Added ${plural(seed.data.added, "gateway")}`}
        </p>
      )}
      {seed.error && (
        <p role="alert" className="text-reading text-destructive">
          {errorMessage(seed.error)}
        </p>
      )}
      <ShowCostToggle />
    </div>
  );
}

/** Where OpenRouter lets people keep providers from storing or training on their prompts. */
export const OPENROUTER_PRIVACY_URL = "https://openrouter.ai/settings/privacy";

/** Whether a pasted key looks like an OpenRouter one. */
export const openRouterKeyLooksRight = (key: string): boolean => /^sk-or-\S+$/.test(key.trim());

function AddOpenRouter({
  taken,
  noKeyring,
  onDone,
}: {
  taken: ReadonlySet<string>;
  noKeyring: boolean;
  onDone: (outcome: AddOutcome) => void;
}) {
  const api = useApi();
  const invalidate = useInvalidateProfiles();
  const keyId = useId();
  const [pasting, setPasting] = useState(false);
  const [key, setKey] = useState("");
  const attempt = useRef(0);
  const signIn = useMutation({
    mutationFn: async (): Promise<AddOutcome | undefined> => {
      const mine = ++attempt.current;
      const started = await api.startOpenRouterSignIn();
      await openExternalUrl(api, started.url);
      const result = await api.finishOpenRouterSignIn(started.attemptId);
      if (mine !== attempt.current) return undefined;
      const { profileId, ...rest } = result;
      return { profileId: ProfileId.make(profileId), result: rest };
    },
    onSuccess: async (outcome) => {
      await invalidate();
      if (outcome) onDone(outcome);
    },
  });
  const paste = useMutation({
    mutationFn: async (): Promise<AddOutcome> => {
      const saved = await api.upsertProfile({
        id: profileIdFor("OpenRouter", taken),
        name: "OpenRouter",
        baseURL: OPENROUTER_BASE_URL,
        kind: "openrouter",
        keyRef: "",
        models: [],
      });
      return { profileId: saved.id, result: await api.setProfileKey(saved.id, key.trim()) };
    },
    onSuccess: async (outcome) => {
      setKey("");
      await invalidate();
      onDone(outcome);
    },
    onError: invalidate,
  });
  const waiting = signIn.isPending;
  const keyOk = openRouterKeyLooksRight(key);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (keyOk) paste.mutate();
  };
  const error = signIn.error ?? paste.error;

  return (
    <section
      aria-label="Add OpenRouter"
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
    >
      <header className="flex items-center gap-2">
        <Route aria-hidden className="size-4 text-muted-foreground" />
        <h3 className="text-reading font-medium">OpenRouter</h3>
      </header>
      <p className="text-reading text-muted-foreground">
        One account for Claude Code and Codex: Claude Code runs Anthropic&apos;s models through it
        and Codex OpenAI&apos;s, paid from your OpenRouter credits.
      </p>
      {noKeyring ? (
        <p role="status" className={noteCls}>
          <TriangleAlert aria-hidden className={noteIconCls} />
          {NO_KEYRING_MESSAGE}
        </p>
      ) : waiting ? (
        <div role="status" className="flex flex-wrap items-center gap-2">
          <Spinner className="size-3.5" />
          <span className="text-reading text-muted-foreground">
            Approve Gram on OpenRouter&apos;s page in your browser…
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              attempt.current++;
              signIn.reset();
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => signIn.mutate()}>
            Sign in with OpenRouter
          </Button>
          {!pasting && (
            <Button size="sm" variant="outline" onClick={() => setPasting(true)}>
              <KeyRound aria-hidden />
              Paste a key
            </Button>
          )}
        </div>
      )}
      {pasting && !waiting && !noKeyring && (
        <form
          aria-label="Paste an OpenRouter key"
          onSubmit={onSubmit}
          className="flex flex-col gap-1"
        >
          <label htmlFor={keyId} className={labelCls}>
            OpenRouter key
          </label>
          <div className="flex gap-2">
            <input
              id={keyId}
              type="password"
              autoComplete="off"
              className={inputCls}
              placeholder="sk-or-…"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <WhyDisabled reason={keyOk ? undefined : "An OpenRouter key starts with sk-or-."}>
              <Button type="submit" size="sm" disabled={!keyOk || paste.isPending}>
                Save
              </Button>
            </WhyDisabled>
            <Button type="button" size="sm" variant="ghost" onClick={() => setPasting(false)}>
              Cancel
            </Button>
          </div>
          <span className="text-meta text-muted-foreground">
            Gram stores it once and never shows it again.
          </span>
        </form>
      )}
      <p className={noteCls}>
        <ShieldCheck aria-hidden className={noteIconCls} />
        <span>
          To keep providers from storing or training on your prompts, turn that off in{" "}
          <button
            type="button"
            className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
            onClick={() => void openExternalUrl(api, OPENROUTER_PRIVACY_URL)}
          >
            OpenRouter&apos;s privacy settings
            <ExternalLink aria-hidden className="size-3" />
          </button>
          .
        </span>
      </p>
      {error !== undefined && error !== null && (
        <p role="alert" className="text-reading text-destructive">
          {errorMessage(error)}
        </p>
      )}
    </section>
  );
}

function ShowCostToggle() {
  const checked = useShowCost();
  const save = useSaveSettings();
  const [error, setError] = useState<string>();
  return (
    <SettingsGroup label="Cost" description="Whether threads show what they cost in dollars.">
      <Toggle
        label="Show dollar cost"
        description="Shown on threads that run through a gateway."
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

function ProfileForm({
  existing,
  taken,
  noKeyring = false,
  onDone,
}: {
  existing?: GatewayProfile;
  taken: ReadonlySet<string>;
  noKeyring?: boolean;
  onDone: (outcome?: AddOutcome) => void;
}) {
  const api = useApi();
  const invalidate = useInvalidateProfiles();
  const keyId = useId();
  const [name, setName] = useState(existing?.name ?? "");
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? "");
  const [catalog, setCatalog] = useState(existing?.modelCatalogURL ?? "");
  const [key, setKey] = useState("");
  const [savedId, setSavedId] = useState<ProfileId | undefined>();
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
      if (existing || key === "" || noKeyring) return { profileId: saved.id };
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
          className={cn(inputCls, "font-mono text-meta")}
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
        <span className="text-meta text-muted-foreground">
          Only if your gateway documents a public metadata endpoint. Gram sends no key to this URL.
        </span>
      </label>
      {!existing && noKeyring && (
        <p role="status" className={noteCls}>
          <TriangleAlert aria-hidden className={noteIconCls} />
          {NO_KEYRING_MESSAGE}
        </p>
      )}
      {!existing && !noKeyring && (
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
          <span className="text-meta text-muted-foreground">
            Gram stores it once and never shows it again.
          </span>
        </div>
      )}
      {save.error && (
        <p role="alert" className="text-reading text-destructive">
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
        <h3 className="text-reading font-medium">{profile.name}</h3>
        {profile.default && <Badge variant="secondary">Default</Badge>}
        <span className="ml-auto">
          <RowMenuButton label={`Gateway ${profile.name} actions`} actions={actions} />
        </span>
      </RowContextMenu>
      <p className="font-mono text-meta text-muted-foreground">{profile.baseURL}</p>
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
        <p role="alert" className="text-reading text-destructive">
          {errorMessage(error)}
        </p>
      )}
    </article>
  );
}

const SAVED_IN: Record<VaultInfo["kind"], string> = {
  keychain: "Saved securely in the macOS Keychain",
  dpapi: "Encrypted with Windows data protection for your account",
  libsecret: "Saved securely in the system keyring",
  "no-keyring": NO_KEYRING_MESSAGE,
  memory: "Not saved: the key is kept only while the server runs",
};

function KeyStatus({ profile, vault }: { profile: GatewayProfile; vault: VaultInfo | undefined }) {
  if (vault?.kind === "no-keyring") {
    return (
      <p role="status" className={noteCls}>
        <TriangleAlert aria-hidden className={noteIconCls} />
        {NO_KEYRING_MESSAGE}
      </p>
    );
  }
  if (profile.keyRef === "") {
    return (
      <p className={noteCls}>
        <KeyRound aria-hidden className={noteIconCls} />
        No API key yet
      </p>
    );
  }
  const Icon = vault && !vault.persisted ? TriangleAlert : ShieldCheck;
  return (
    <p className={noteCls}>
      <Icon aria-hidden className={noteIconCls} />
      {vault ? SAVED_IN[vault.kind] : "API key saved"}
    </p>
  );
}

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
  const noKeyring = vault?.kind === "no-keyring";
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
        if (key !== "" && !noKeyring) save.mutate(false);
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
        <WhyDisabled
          reason={noKeyring ? NO_KEYRING_MESSAGE : key === "" ? "Paste a key first." : undefined}
        >
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={noKeyring || key === "" || save.isPending}
          >
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
        <p role="alert" className="text-reading text-destructive">
          {errorMessage(save.error)}
        </p>
      )}
    </form>
  );
}

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
          className="flex flex-col gap-2 rounded-md border border-border p-2 text-reading"
        >
          <p>
            Gram will read this gateway's API key from{" "}
            <code className="font-mono text-meta">~/.local/share/opencode/auth.json</code> and store
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
          <WhyDisabled reason={vault?.kind === "no-keyring" ? NO_KEYRING_MESSAGE : undefined}>
            <Button
              size="sm"
              variant="ghost"
              disabled={vault?.kind === "no-keyring"}
              onClick={() => {
                importKey.reset();
                setConsenting(true);
              }}
            >
              Import key from {OPENCODE}…
            </Button>
          </WhyDisabled>
          {importKey.data?.imported === false && (
            <span className="text-meta text-muted-foreground">
              {OPENCODE} has no key for this gateway.
            </span>
          )}
        </div>
      )}
      {importKey.error && (
        <p role="alert" className="text-reading text-destructive">
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
        <span className="text-meta text-muted-foreground">{plural(count, "model")}</span>
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
        <p role="alert" className="text-reading text-destructive">
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

const NOT_FOR_AGENTS =
  "Not offered to agents: the gateway says it isn't a chat model with tools, or is deprecated or restricted";

function HelperModel({ profile }: { profile: GatewayProfile }) {
  if (profile.default !== true || profile.models.length === 0) return null;
  const choice = helperChoice(profile);
  return (
    <p className="text-meta text-muted-foreground">
      Gateway helper model when selected: {choice?.model ?? "none"}. The rest is in{" "}
      <Link to="/settings/ai-helpers" className="underline underline-offset-2">
        AI helpers
      </Link>
      .
    </p>
  );
}
