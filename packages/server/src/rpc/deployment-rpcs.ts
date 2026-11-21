/**
 * What only the deployment sets up on a server people sign in to: a member's call is refused, and
 * the deployment supplies these from outside (`docs/EMBEDDING.md`, settings supplied from outside)
 * instead. Each acts on the server itself rather than on a person's work: the agent CLIs it
 * installs, its gateway keys and connectors, its own settings, keybindings and palettes, the agent
 * sessions in its own accounts, its diagnostics and logs, and programs it would start for a local
 * user. A headless server's disk holds nobody's work either (`memberMay` in `actor-guard.ts`).
 */
export const DEPLOYMENT_RPCS: ReadonlySet<string> = new Set([
  "agentRuntime.cancel",
  "agentRuntime.cancelUpdate",
  "agentRuntime.install",
  "agentRuntime.rollback",
  "agentRuntime.update",
  "agentRuntime.useSource",
  "app.diagnostics",
  "app.diagnosticsReport",
  "app.keptHostStop",
  "app.openExternal",
  "app.openLogsFolder",
  "connectors.add",
  "connectors.authenticate",
  "connectors.reconnect",
  "connectors.remove",
  "connectors.setEnabled",
  "connectors.signIn",
  "editor.open",
  "fs.reveal",
  "issues.file",
  "issues.preview",
  "keybindings.set",
  "palettes.remove",
  "palettes.upsert",
  "profiles.discoverModels",
  "profiles.importKey",
  "profiles.openRouterFinish",
  "profiles.openRouterSignIn",
  "profiles.remove",
  "profiles.seed",
  "profiles.setKey",
  "profiles.upsert",
  "profiles.vaultInfo",
  "projects.setFolderTrust",
  "sessions.delete",
  "sessions.list",
  "sessions.preview",
  "settings.set",
]);
