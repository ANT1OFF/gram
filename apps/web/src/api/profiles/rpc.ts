import * as Redacted from "effect/Redacted";

import { run, type RpcContext } from "../rpc-client";
import type { ProfilesApi } from "./types";

/** `ProfilesApi` over the RPC client; a key crosses the wire `Redacted`. */
export const profilesRpc = ({ client }: RpcContext): ProfilesApi => ({
  listProfiles: () => run(client["profiles.list"](undefined)),
  upsertProfile: (profile) => run(client["profiles.upsert"]({ profile })),
  setProfileKey: (profileId, key) =>
    run(client["profiles.setKey"]({ profileId, key: Redacted.make(key) })),
  vaultInfo: () => run(client["profiles.vaultInfo"](undefined)),
  seedProfiles: () => run(client["profiles.seed"](undefined)),
  removeProfile: (profileId) => run(client["profiles.remove"]({ profileId })),
  discoverProfileModels: (profileId) => run(client["profiles.discoverModels"]({ profileId })),
  importProfileKey: (profileId) =>
    run(client["profiles.importKey"]({ profileId, source: "opencode" })),
  helperStatus: () => run(client["helper.status"](undefined)),
  helperPresence: (typing) => run(client["helper.presence"]({ typing })),
  composerDrafts: (windowId, threadIds) =>
    run(client["composer.drafts"]({ windowId, threadIds: [...threadIds] })),
  listModels: (agent, profileId) =>
    run(client["models.list"](profileId ? { agent, profileId } : { agent })),
  modelSuggestions: () => run(client["models.suggestions"](undefined)),
});
