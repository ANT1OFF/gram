import { describe, expect, it } from "vitest";
import { isCredentialFolder, isCredentialPath } from "./credential-paths.ts";

describe("isCredentialPath", () => {
  it("refuses env files, keys and login files wherever they are", () => {
    for (const path of [
      "/repo/.env",
      "/repo/.env.local",
      "/repo/.env.example",
      "/repo/.envrc",
      "C:\\repo\\.ENV",
      "/srv/tls/server.pem",
      "/srv/tls/server.key",
      "/tmp/cert.p12",
      "/Users/me/.ssh/id_ed25519",
      "/tmp/id_rsa",
      "/tmp/id_rsa.pub",
      "/Users/me/.npmrc",
      "/Users/me/.netrc",
      "C:\\Users\\me\\_netrc",
      "/Users/me/.git-credentials",
      "/Users/me/.pypirc",
      "/Users/me/vault.kdbx",
      "/Users/me/Library/Keychains/login.keychain-db",
      "/Users/me/.claude/.credentials.json",
      "/srv/claude-config/.credentials.json",
      "/Users/me/.codex/auth.json",
      "/Users/me/.grok/auth.json",
      "C:\\Users\\me\\.grok\\auth.json",
      "C:\\Users\\me\\.codex\\auth.json",
      "/Users/me/.local/share/opencode/auth.json",
      "/tmp/report/secrets.yaml",
    ]) {
      expect(isCredentialPath(path), path).toBe(true);
    }
  });

  it("refuses anything in a credential folder", () => {
    for (const path of [
      "/Users/me/.aws/config",
      "/repo/.AWS/synthetic.png",
      "/repo/.SSH/synthetic.png",
      "/repo/.config/GCloud/synthetic.png",
      "/repo/Library/KEYCHAINS/synthetic.png",
      "C:\\repo\\.CONFIG\\GH\\synthetic.png",
      "/repo/.CODEX/AUTH.JSON",
      "/repo/.LOCAL/SHARE/OpenCode/AUTH.JSON",
      "/Users/me/.aws/sso/cache/token.json",
      "~/.aws/credentials",
      "/Users/me/.ssh/config",
      "/Users/me/.kube/config",
      "/Users/me/.docker/config.json",
      "/Users/me/.config/gh/hosts.yml",
      "/Users/me/.config/gcloud/application_default_credentials.json",
      "C:\\Users\\me\\.azure\\msal_token_cache.json",
      "/home/me/.local/share/keyrings/login.keyring",
      "/home/me/.local/share/kwalletd/kdewallet.kwl",
      "/home/me/.pki/nssdb/cert9.db",
      "/home/me/.claude/.credentials.json",
      "/home/me/.codex/auth.json",
    ]) {
      expect(isCredentialPath(path), path).toBe(true);
    }
  });

  it("lets ordinary files through, even ones whose names come close", () => {
    for (const path of [
      "/tmp/browser-research/REPORT.md",
      "src/env.ts",
      "src/environment/config.ts",
      "src/id_utils.ts",
      "src/keys.ts",
      "docs/keyboard.md",
      "src/credentials.ts",
      "/Users/me/.config/nvim/init.lua",
      "/repo/aws/deploy.ts",
      "/repo/ssh/README.md",
      "/repo/src/auth.json",
      "/repo/.codex/config.toml",
      "/repo/opencode/auth.json",
      "",
      "/",
    ]) {
      expect(isCredentialPath(path), path).toBe(false);
    }
  });
});

describe("isCredentialFolder", () => {
  it("is a credential folder or anything inside one", () => {
    for (const path of [
      "/home/dev/.ssh",
      "/home/dev/.aws/sso",
      "/Users/dev/.config/gh",
      "C:\\Users\\dev\\.ssh",
    ])
      expect(isCredentialFolder(path), path).toBe(true);
  });

  it("is an agent's login folder, while a file there is judged as any other file", () => {
    for (const path of ["/home/dev/.claude", "/home/dev/.codex/sessions", "/Users/dev/.CLAUDE"])
      expect(isCredentialFolder(path), path).toBe(true);
    // Previewing an agent's settings file stays as it was: only its login files are refused.
    expect(isCredentialPath("/home/dev/.claude/settings.json")).toBe(false);
    expect(isCredentialPath("/home/dev/.claude/.credentials.json")).toBe(true);
  });

  it("isn't a home, a project, or a dotfolder that holds none", () => {
    for (const path of [
      "/home/dev",
      "/home/dev/code/ssh-tools",
      "/home/dev/.config",
      "/home/dev/.config/nvim",
    ])
      expect(isCredentialFolder(path), path).toBe(false);
  });
});
