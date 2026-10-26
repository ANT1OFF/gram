// Invented presence/auth probes only. FakeAgent owns turns; this executable cannot run one.
const { basename } = require("node:path");
const agent = basename(process.argv[1]);
const args = process.argv.slice(2);
const auth = process.env.GRAM_REAL_E2E_AGENT_AUTH;
if (auth !== "signed-in" && auth !== "signed-out") process.exit(2);
if (args.length === 1 && args[0] === "--version") {
  console.log(agent === "claude" ? "2.1.273 (Claude Code)" : "codex-cli 0.162.1");
  process.exit(0);
}
if (agent === "claude" && args.join(" ") === "auth status --json") {
  console.log(
    JSON.stringify({
      loggedIn: auth === "signed-in",
      authMethod: "claude.ai",
      apiProvider: "firstParty",
    }),
  );
  process.exit(auth === "signed-in" ? 0 : 1);
}
if (agent === "codex" && args.join(" ") === "login status") {
  console.error(auth === "signed-in" ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(auth === "signed-in" ? 0 : 1);
}
console.error("The readiness fixture refuses execution beyond presence and auth probes.");
process.exit(2);
