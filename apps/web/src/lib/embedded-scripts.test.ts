import { describe, expect, it } from "vitest";

import { embeddedScripts, type EmbeddedScript } from "./embedded-scripts";

/** Each script with what its characters spell in the command, which must read the same. */
const scripts = (command: string) =>
  embeddedScripts(command).map((script) => ({ language: script.language, text: script.text }));

const spelled = (command: string, script: EmbeddedScript) =>
  [...script.text].map((_, index) => command.slice(script.starts[index], script.ends[index]));

describe("embeddedScripts", () => {
  it("finds a python here-doc read from standard input", () => {
    const command = "python3 - <<'PY'\nimport os\nprint(os.getcwd())\nPY\necho done";
    expect(scripts(command)).toEqual([
      { language: "python", text: "import os\nprint(os.getcwd())\n" },
    ]);
  });

  it("reads `-c` code of shells and interpreters, through quotes and escapes", () => {
    const command = `bash -lc "cd /tmp && python3 -c \\"print('hi')\\""`;
    const found = embeddedScripts(command);
    expect(found.map(({ language, text }) => ({ language, text }))).toEqual([
      { language: "shellscript", text: `cd /tmp && python3 -c "print('hi')"` },
      { language: "python", text: "print('hi')" },
    ]);
    // Every character maps back to its spelling: `"` is spelled `\\"` in the command.
    const shell = found[0]!;
    expect(spelled(command, shell).join("")).toBe(`cd /tmp && python3 -c \\"print('hi')\\"`);
  });

  it("follows a shell, then ssh, to the remote program a here-doc feeds", () => {
    const command = [
      `/bin/zsh -lc "ssh -o BatchMode=yes host 'export PATH=/opt/bin:"'$HOME/.local/bin:$PATH; python3 -'"' <<'PY'`,
      "from pathlib import Path",
      "print(Path.home())",
      `PY"`,
    ].join("\n");
    expect(scripts(command)).toEqual([
      {
        language: "shellscript",
        text: [
          "ssh -o BatchMode=yes host 'export PATH=/opt/bin:$HOME/.local/bin:$PATH; python3 -' <<'PY'",
          "from pathlib import Path",
          "print(Path.home())",
          "PY",
        ].join("\n"),
      },
      { language: "shellscript", text: "export PATH=/opt/bin:$HOME/.local/bin:$PATH; python3 -" },
      { language: "python", text: "from pathlib import Path\nprint(Path.home())\n" },
    ]);
    const python = embeddedScripts(command).at(-1)!;
    expect(spelled(command, python).join("")).toBe(python.text);
  });

  it("names a written file's language, and a delimiter's when nothing else says", () => {
    expect(scripts("cat > src/app.ts <<'EOF'\nexport const a = 1;\nEOF")).toEqual([
      { language: "typescript", text: "export const a = 1;\n" },
    ]);
    expect(scripts("some-tool <<-SQL\n\tselect 1;\n\tSQL")).toEqual([
      { language: "sql", text: "\tselect 1;\n" },
    ]);
    expect(scripts("git apply <<'EOF'\n--- a/x\n+++ b/x\nEOF")).toEqual([
      { language: "diff", text: "--- a/x\n+++ b/x\n" },
    ]);
  });

  it("reads SQL, JavaScript and awk arguments", () => {
    expect(scripts(`psql -U app -c 'select 1' -c "select 2"`)).toEqual([
      { language: "sql", text: "select 1" },
      { language: "sql", text: "select 2" },
    ]);
    expect(scripts(`sqlite3 db.sqlite 'select * from t'`)).toEqual([
      { language: "sql", text: "select * from t" },
    ]);
    expect(scripts(`env FOO=1 sudo -u app node --eval 'console.log(1)'`)).toEqual([
      { language: "javascript", text: "console.log(1)" },
    ]);
    expect(scripts(`ls | awk -F, '{ print $1 }'`)).toEqual([
      { language: "awk", text: "{ print $1 }" },
    ]);
  });

  it("looks inside command substitutions", () => {
    expect(scripts(`echo "$(python3 -c 'print(1)')"`)).toEqual([
      { language: "python", text: "print(1)" },
    ]);
  });

  it("leaves files, unmappable spellings and plain commands alone", () => {
    expect(scripts("python3 script.py <<'EOF'\nnot code\nEOF")).toEqual([]);
    expect(scripts("python3 -m http.server")).toEqual([]);
    expect(scripts(`bash -c $'echo\\tone'`)).toEqual([]);
    expect(scripts("git status && ls -la")).toEqual([]);
    expect(scripts("")).toEqual([]);
    expect(scripts(`unterminated "quote <<'PY`)).toEqual([]);
  });
});
