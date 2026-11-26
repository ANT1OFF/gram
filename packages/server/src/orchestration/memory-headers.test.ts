// Worker memory headers, fuzzed: a worker reads a memory file only when it has no header, or a
// closed `---` block that is a flat map of plain scalars with no `private` anywhere. Every unusual
// YAML feature, alone or mixed into otherwise plain headers, must be denied; plain ones allowed.
import { describe, expect, it } from "vitest";
import { workerMayEnter, workerMayRead, workerView } from "./memory.ts";

/** A small seeded PRNG (mulberry32), so a failure names a seed that reproduces it. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const KEYS = ["title", "updated", "owner", "status", "repo", "topic"];
const VALUES = ["Plans", "2026-11-07", "3", "true", "null", "'ops'", '"a b"', "1.5"];

/** One feature a plain header never has, as a line or block to splice in. */
const UNUSUAL: ReadonlyArray<(pick: <T>(items: ReadonlyArray<T>) => T) => string> = [
  () => "private: true",
  () => "Private: no",
  () => "# private",
  (pick) => `${pick(KEYS)}: !!str ${pick(VALUES)}`,
  (pick) => `${pick(KEYS)}: !custom ${pick(VALUES)}`,
  (pick) => `${pick(KEYS)}: &anchor ${pick(VALUES)}`,
  () => "alias: *anchor",
  (pick) => `${pick(KEYS)}:\n  nested: ${pick(VALUES)}`,
  (pick) => `${pick(KEYS)}:\n  - ${pick(VALUES)}`,
  (pick) => `${pick(KEYS)}: [a, b]`,
  (pick) => `${pick(KEYS)}: {a: b}`,
  () => "note: |\n  text",
  () => "note: >\n  text",
  () => "<<: {title: x}",
  () => "? complex\n: key",
  () => "!!omap",
  () => "!!set",
  () => "%YAML 1.2",
];

const header = (lines: ReadonlyArray<string>) => `---\n${lines.join("\n")}\n---\nThe body.`;

describe("workerMayRead, by header", () => {
  it("allows no header, an empty one, and a flat map of plain scalars", () => {
    expect(workerMayRead("a.md", "Just a body.")).toBe(true);
    expect(workerMayRead("a.md", "---\n---\nBody.")).toBe(true);
    expect(workerMayRead("a.md", header(["title: Plans", "count: 3", "owner: 'ops'"]))).toBe(true);
  });

  it("denies the reviewer's cases: !!omap, !!set and private nested past eight levels", () => {
    expect(workerMayRead("a.md", header(["!!omap", "- title: x", "- private: true"]))).toBe(false);
    expect(workerMayRead("a.md", header(["!!set", "? private", "? title"]))).toBe(false);
    const deep = Array.from({ length: 12 }, (_, n) => `${"  ".repeat(n)}l${n}:`);
    expect(workerMayRead("a.md", header([...deep, `${"  ".repeat(12)}private: true`]))).toBe(false);
  });

  it("denies every unusual feature, alone or mixed into plain headers (fuzzed, 3,000 headers)", () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const random = prng(seed);
      const pick = <T>(items: ReadonlyArray<T>): T => items[Math.floor(random() * items.length)]!;
      const used = new Set<string>();
      const plain: Array<string> = [];
      for (let n = Math.floor(random() * 4); n > 0; n--) {
        const key = pick(KEYS);
        if (used.has(key)) continue;
        used.add(key);
        plain.push(`${key}: ${pick(VALUES)}`);
      }
      const unusual = Array.from({ length: 1 + Math.floor(random() * 2) }, () =>
        pick(UNUSUAL)(pick),
      );
      const lines = [...plain];
      for (const line of unusual) lines.splice(Math.floor(random() * (lines.length + 1)), 0, line);
      expect(workerMayRead("a.md", header(lines)), `seed ${seed}:\n${header(lines)}`).toBe(false);
      // The same plain lines alone are fine.
      expect(workerMayRead("a.md", header(plain)), `seed ${seed} plain`).toBe(true);
    }
  });

  it("denies headers it can't take as plain: unclosed, TOML, a leading comment, broken YAML", () => {
    for (const text of [
      "---\ntitle: Plans\nBody.",
      "+++\ntitle = 'Plans'\n+++\nBody.",
      "<!-- note -->\nBody.",
      "---\ntitle: [unclosed\n---\nBody.",
      "---\ntitle: a\ntitle: b\n---\nBody.",
      "---\njust a scalar\n---\nBody.",
      "----\nBody.",
    ]) {
      expect(workerMayRead("a.md", text), text).toBe(false);
    }
  });
});

// Synthetic credential shapes, joined from parts so no credential-shaped literal sits in the source.
const GH = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789AB"].join("_");
const PEM_BEGIN = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "OPENSSH PRIVATE KEY-----"].join(" ");
const SLACK = ["xoxb", "123456789012", "abcdefghijkl"].join("-");
const escaped = [...GH]
  .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
  .join("");
const percent = [...GH].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("");
const html = [...GH].map((char) => `&#${char.charCodeAt(0)};`).join("");
const base64 = Buffer.from(`token=${GH}`).toString("base64");
const AWS_ASSIGNMENT = `${["AWS", "SECRET", "ACCESS", "KEY"].join("_")}=${"abcdefghijklmnopqrstuv"}0123456789ABCDxyz`;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ACCESS = ["access", "Key"].join("");
const CLIENT_SECRET = ["client", "Secret"].join("");
/** `GH` in base64, as the reviewer split it: four characters a piece. */
const PIECES =
  Buffer.from(GH)
    .toString("base64")
    .match(/.{1,4}/g) ?? [];
const HEX_BYTES = [...Buffer.from(GH)].map((byte) => byte.toString(16).padStart(2, "0"));
const SLACK_LONG = ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-");
const USERINFO = ["amy", "orchard-willow"].join(":");
const HEX_TEXT = Buffer.from(["pass", "word=abcdefgh"].join("")).toString("hex");
const SPACED_BASE64 = (
  Buffer.from(GH)
    .toString("base64")
    .match(/.{1,3}/g) ?? []
).join(" ");
const WRAPPED_BY_4 = (
  Buffer.from(GH)
    .toString("base64")
    .match(/.{1,4}/g) ?? []
).join("\n");
const ARN = "arn:aws:eks:eu-north-1:123456789012:cluster/trading-main";
const OPENAI = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789ABCD"].join("-");
const GITLAB = ["glpat", "abcdefghij0123456789"].join("-");
const AWS_ID = ["AKIA", "ABCDEFGHIJ012345"].join("");
const HUGGING = ["hf", "abcdefghijklmnopqrstuvwxyzABCDEFGH"].join("_");
const ANTHROPIC = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"].join("-");
const GH_OAUTH = ["gho", "abcdefghijklmnopqrstuvwxyz0123456789AB"].join("_");
const GH_PAT = [
  "github",
  "pat",
  "11ABCDEFG0123456789",
  "abcdefghijklmnopqrstuvwxyz0123456789",
].join("_");
const AWS_SECRET = ["Zq8Lr2Vx9Tn4Wp7Ks1Hd6Fj3", "m5Gc0Ya8Ue2Io4Rt"].join("/");
/** An AWS key id of pronounceable letters, which a plain-word check alone would pass. */
const AWS_ID_WORDS = ["AKIA", "BABEBIBOBUBABEBI"].join("");
const PEM_BODY = (
  Buffer.from(Array.from({ length: 144 }, (_, at) => (at * 37 + 11) % 256))
    .toString("base64")
    .match(/.{1,64}/g) ?? []
).join("\n");
const PEM_REAL = `${PEM_BEGIN}\n${PEM_BODY}\n${PEM_END}`;
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlLXZhbHVl"].join(
  ".",
);
/** `GH` in base64, wrapped every 12 characters as the reviewer sent it. */
const WRAPPED_BASE64 = (
  Buffer.from(GH)
    .toString("base64")
    .match(/.{1,12}/g) ?? []
).join("\n");

/**
 * Every case from the reviews of #198, rounds 3 to 13, as one table: the path and text a worker would
 * read, and whether it may. A file a worker may not read is dropped whole: nothing in it is shown.
 */
const CASES: ReadonlyArray<readonly [label: string, path: string, text: string, allowed: boolean]> =
  [
    // Allowed: no header, an empty one, a flat plain one; ordinary prose.
    ["no header", "a.md", "Tabs, not spaces.", true],
    ["empty header", "a.md", "---\n---\nBody.", true],
    ["flat plain header", "a.md", "---\ntitle: Plans\nupdated: 2026-11-07\n---\nBody.", true],
    // Round 3: private names and folders, credential-shaped names, private front matter.
    ["private folder", "private/plans.md", "Body.", false],
    ["*.private.md", "people.private.md", "Body.", false],
    ["token-named", "deploy-token.md", "Body.", false],
    ["api-keys-named", "api-keys.md", "Body.", false],
    ["private: true", "a.md", "---\nprivate: true\n---\nBody.", false],
    // Round 4: more credential names, credential text.
    ["key-named", "deploy-key.md", "Body.", false],
    ["auth dotfile", ".npmrc", "Body.", false],
    ["auth-named", "github-auth.md", "Body.", false],
    ["PEM block", "a.md", `${PEM_BEGIN}\nb3Blbg==\n${PEM_END}`, false],
    ["Slack token", "a.md", `Webhook ${SLACK}`, false],
    // Round 5: private front matter inside a comment, or in another form.
    ["commented front matter", "a.md", "<!--\n---\nprivate: true\n---\n-->\nBody.", false],
    ["inline comment", "a.md", "<!-- private: true -->\nBody.", false],
    ["YAML comment", "a.md", "---\ntitle: Plans\n# private: true\n---\nBody.", false],
    ["TOML", "a.md", '+++\nprivate = "yes"\n+++\nBody.', false],
    ["bare private", "a.md", "---\nprivate\n---\nBody.", false],
    // Round 6: flow style, nesting, broken YAML.
    ["flow map", "a.md", "---\n{private: true}\n---\nBody.", false],
    ["nested", "a.md", "---\nmeta:\n  private: true\n---\nBody.", false],
    ["broken", "a.md", "---\ntitle: [unclosed\n---\nBody.", false],
    ["private: false", "a.md", "---\nprivate: false\n---\nBody.", false],
    // Round 7: tags and deep nesting.
    ["!!omap", "a.md", "---\n!!omap\n- private: true\n---\nBody.", false],
    ["!!set", "a.md", "---\n!!set\n? private\n---\nBody.", false],
    ["explicit key", "a.md", "---\n? title\n: Plans\n---\nBody.", false],
    // Round 8: a `...` close, auth headers and cookies, escaped and encoded tokens.
    ["... close hides private", "a.md", "---\ntitle: Plans\n...\nprivate: true\n---\nBody.", false],
    ["... close alone", "a.md", "---\ntitle: Plans\n...\nBody.", false],
    ["authorization header", "a.md", "authorization: bearer abc", false],
    ["Authorization in prose", "a.md", "Send Authorization: Basic with the build.", false],
    ["cookie", "a.md", "cookie: session=abc123", false],
    ["set-cookie", "a.md", "Set-Cookie: id=1", false],
    ["unicode-escaped token", "a.md", `"${escaped}"`, false],
    ["percent-encoded token", "a.md", `see ${percent}`, false],
    ["HTML-encoded token", "a.md", `see ${html}`, false],
    ["base64-encoded token", "a.md", `blob ${base64}`, false],
    // Round 8: delimiters left open, behind which a credential could hide.
    ["truncated PEM", "a.md", `${PEM_BEGIN}\nb3Blbg==`, false],
    ["unclosed code fence", "a.md", "```\nsomething\n", false],
    ["unbalanced quote around a run", "a.md", `value: "${"A".repeat(24)}`, false],
    // Round 9: `_` as a separator, names, nested and mixed encodings, short base64, escapes,
    // entities, Unicode lookalikes and zero-width characters.
    ["AWS_SECRET_ACCESS_KEY=", "a.md", "AWS_SECRET_ACCESS_KEY=abc", false],
    ["session header", "a.md", "x-session: 1", false],
    ["short Basic", "a.md", "Basic dXNlcjpw", false],
    ["short padded base64", "a.md", "blob dG9rZW4=", false],
    ["wrapped base64", "a.md", "Z2hwX2FiY2RlZmdo\naWprbG1ub3BxcnN0", false],
    ["mixed run of 16", "a.md", "id a1b2c3d4e5f6g7h8", false],
    ["uncited hex run of 20", "a.md", "id 0123456789abcdef0123", false],
    ["nested encoding", "a.md", "see %5Cu0067hp", false],
    ["greedy unicode escape", "a.md", "see \\u{67}hp", false],
    ["bad percent before a good one", "a.md", "see %zz%67hp", false],
    ["uppercase HTML hex", "a.md", "see &#X67;hp", false],
    ["named entity", "a.md", "a &amp; b", false],
    ["lookalike letter", "a.md", "see \u1E6Doken", false],
    ["zero-width inside a word", "a.md", "see to\u200Bken", false],
    ["fullwidth letters", "a.md", "\uFF54\uFF4F\uFF4B\uFF45\uFF4E", false],
    ["MEMORY.md, the index", "MEMORY.md", "The index.", true],
    ["memory.md, lowercase but plain", "memory.md", "Body.", true],
    ["another capitalised name", "NOTES.md", "Body.", false],
    ["underscore name", "notes_v2.md", "Body.", false],
    ["keyword in a name", "aws-secret.md", "Body.", false],
    ["keyword in a folder", "session/notes.md", "Body.", false],
    // Round 9, the reviewer's exact payloads (findings 1 to 8).
    ["1: AWS key assignment", "a.md", AWS_ASSIGNMENT, false],
    ["2: token as a filename", `${GH}.md`, "Ordinary prose.", false],
    ["3: nested percent", "a.md", "%2563ookie: sid=abc123", false],
    ["3: mixed percent and HTML", "a.md", "author%69zat&#105;on: abc123", false],
    ["4: short base64", "a.md", "cGFzc3dvcmQ9YWJj", false],
    ["4: short Basic", "a.md", "Basic YTpi", false],
    ["5: four-digit escape", "a.md", "\\u0062earer abcdefghijklmnop", false],
    ["6: bad percent shields a good one", "a.md", "%FF%63ookie: sid=abc123", false],
    ["7: uppercase HTML hex", "a.md", "&#X63;ookie: sid=abc123", false],
    ["8: fullwidth label", "a.md", "\uFF43\uFF4F\uFF4F\uFF4B\uFF49\uFF45: sid=abc123", false],
    ["8: zero-width label", "a.md", `coo${String.fromCharCode(0x200b)}kie: sid=abc123`, false],
    ["letters-only base64 of text", "a.md", "see YWJjZGVm", false],
    // Round 10, the reviewer's exact payloads (findings 1 to 5), and their class.
    ["10.1: wrapped base64, as sent", "a.md", WRAPPED_BASE64, false],
    ["10.1: base64 split by spaces", "a.md", `blob ${SPACED_BASE64} done`, false],
    ["10.1: base64 split every 4 over lines", "a.md", WRAPPED_BY_4, false],
    ["10.2: Slack token as a name", `${SLACK}.md`, "Ordinary prose.", false],
    ["10.2: longer Slack token as a name", `${SLACK_LONG}.md`, "Ordinary prose.", false],
    ["10.2: token in a folder name", `${SLACK}/notes.md`, "Ordinary prose.", false],
    ["10.3: URL userinfo", "url.md", `https://${USERINFO}@example.test/`, false],
    ["10.3: connection string", "url.md", `postgresql://${USERINFO}@db.example.test/app`, false],
    [
      "10.4: 40 mixed past hex, after at",
      "a.md",
      `Landed at ${"0123456789abcdefghij".repeat(2)}.`,
      false,
    ],
    ["10.4: hex-encoded text, after at", "a.md", `Landed at ${HEX_TEXT}.`, false],
    // Round 11, the reviewer's exact payloads (findings 1 to 4 and 7), and their class.
    ["11.1: accessKey= before a SHA", "sha.md", `${ACCESS}=${SHA}...`, false],
    ["11.1: clientSecret at a SHA", "at.md", `${CLIENT_SECRET} at ${SHA}`, false],
    ["11.1: encryptionKey=", "a.md", `encryptionKey=${SHA}...`, false],
    ["11.1: signingKey=", "a.md", `signingKey=${SHA}...`, false],
    ["11.1: authToken at", "a.md", `authToken at ${SHA}`, false],
    ["11.1: client_secret at", "a.md", `client_secret at ${SHA}`, false],
    ["11.1: KEY=", "a.md", `KEY=${SHA}...`, false],
    ["11.1: apiKey at", "a.md", `apiKey at ${SHA}`, false],
    ["11.1: an assignment in the clause", "a.md", `id = at ${SHA}`, false],
    ["11.2: base64 split by commas", "split.md", PIECES.join(", "), false],
    [
      "11.2: base64 as a Markdown list",
      "split.md",
      PIECES.map((piece) => `- ${piece}`).join("\n"),
      false,
    ],
    [
      "11.2: base64 in quoted pieces",
      "split.md",
      PIECES.map((piece) => `'${piece}'`).join(" "),
      false,
    ],
    ["11.2: hex bytes split by colons", "split.md", HEX_BYTES.join(":"), false],
    ["11.2: hex bytes split by spaces", "split.md", HEX_BYTES.join(" "), false],
    ["11.3: scheme-relative userinfo", "relative.md", `//${USERINFO}@example.test/`, false],
    ["11.3: bare userinfo", "relative.md", `${USERINFO}@example.test`, false],
    ["11.4: ODBC connection string", "odbc.md", "Server=db;UID=amy;PWD=orchard-willow;", false],
    ["11.4: PWD=", "odbc.md", "PWD=orchard-willow", false],
    ["11.4: PWD:", "odbc.md", "PWD: orchard-willow", false],
    [
      "11.4: a connection string with no keyword",
      "odbc.md",
      "Server=db;Database=app;Uid=amy;",
      false,
    ],
    ["11.4: a DSN", "odbc.md", "The dsn is orchard-willow.", false],
    ["11.7: hex with a NUL before text", "a.md", `at 00${HEX_TEXT}`, false],
    // Round 12, the reviewer's exact payloads (findings 1 and 2), and their class.
    ["12.1: requirepass", "redis.md", "requirepass orchard", false],
    ["12.1: masterauth", "replica.md", "masterauth orchard", false],
    ["12.1: AUTH user password", "command.md", "AUTH amy orchard", false],
    ["12.1: AUTH password", "command.md", "AUTH orchard", false],
    ["12.1: ACL rule", "acl.md", "user amy on >orchard ~* +@all", false],
    ["12.1: ACL SETUSER", "acl.md", "ACL SETUSER amy on >orchard", false],
    ["12.1: requirepass as JSON", "redis.md", '{"requirepass":"orchard"}', false],
    ["12.1: requirepass as YAML", "redis.md", "requirepass: orchard", false],
    ["12.1: redis-cli -a", "redis.md", "Connect with redis-cli -a orchard.", false],
    ["12.1: a stem in a compound", "a.md", "PGPASSWORD=orchard", false],
    ["12.1: a directive in a list", "a.md", "- pass orchard", false],
    ["12.2: pgpass record", "database.md", "db.example.test:5432:app:amy:orchard", false],
    ["12.2: pgpass with wildcards", "database.md", "*:*:*:amy:orchard", false],
    ["12.2: a record in prose", "database.md", "The line is db:5432:app:amy:orchard here.", false],
    ["12.2: a pgpass name", "pgpass.md", "Ordinary prose.", false],
    ["12.2: a netrc name", "netrc.md", "Ordinary prose.", false],
    ["12.2: a dotted pgpass name", ".pgpass", "Ordinary prose.", false],
    ["12.2: a dotted netrc name", ".netrc", "Ordinary prose.", false],
    // Round 13, the reviewer's exact payloads (findings 1 to 4), and their class.
    ["13.1: curl -u user:pass", "curl.md", "curl -u amy:orchard https://example.test/", false],
    [
      "13.1: curl --user",
      "smtp.md",
      "curl --url smtp://mail.example.test --user amy:orchard",
      false,
    ],
    [
      "13.1: docker login",
      "docker.md",
      "docker login registry.example.test -u amy -p orchard",
      false,
    ],
    ["13.1: mariadb -p attached", "maria.md", "mariadb -u amy -porchard app", false],
    ["13.1: mongosh", "mongo.md", "mongosh --username amy -p orchard", false],
    [
      "13.1: ldapsearch -w",
      "directory.md",
      "ldapsearch -x -D cn=amy,dc=example,dc=test -w orchard",
      false,
    ],
    ["13.2: bindpw", "bind.md", "bindpw orchard", false],
    ["13.2: rootpw", "root.md", "rootpw orchard", false],
    ["13.2: rootpwmodpw", "directory.md", "rootpwmodpw orchard", false],
    ["13.3: Postfix sasl_passwd", "relay.md", "[smtp.example.test]:587 amy:orchard", false],
    [
      "13.3: Squid login=",
      "proxy.md",
      "cache_peer proxy.example.test parent 3128 0 login=amy:orchard",
      false,
    ],
    [
      "13.3: Exim client_send list",
      "exim.md",
      "fixed_login:\n  driver = plaintext\n  public_name = LOGIN\n  client_send = : amy : orchard",
      false,
    ],
    [
      "13.3: Exim client_send carets",
      "mail.md",
      "fixed_plain:\n  driver = plaintext\n  public_name = PLAIN\n  client_send = ^amy^orchard",
      false,
    ],
    ["13.4: Redis prompt transcript", "console.md", "127.0.0.1:6379> AUTH amy orchard", false],
    ["13.4: AUTH in a sentence", "command.md", "Run AUTH amy orchard to connect.", false],
    ["13.4: a shell prompt", "console.md", "$ requirepass orchard", false],
    ["13.4: lowercase auth after a prompt", "console.md", "redis> auth orchard", false],
    ["accented credential word", "a.md", "P\u00e4ssw\u00f6rd: orchard", false],
    ["a weak word with a value", "a.md", "The session is orchard-willow.", false],
    ["a weak word in an assignment", "a.md", "env: staging", false],
    ["a random letter name", "abcdefghijklmnopqrstuvwxyz.md", "Ordinary prose.", false],
    ["an alternating name", "a1b2c3d4.md", "Ordinary prose.", false],
    ["a token-shaped folder", `${SLACK}/notes.md`, "Ordinary prose.", false],
    // Identifiers that once hid a whole workspace's memory from its workers, and real secrets
    // written beside them, which still don't read.
    ["an ARN as a kubectl context", "infra.md", `- kubectl context ${ARN}.`, true],
    ["an ARN as a value", "infra.md", `- Run kubectl --context=${ARN} get pods.`, true],
    ["a code span closing after login", "infra.md", "Run `aws sso login` first.", true],
    [
      "a profile in a code span",
      "infra.md",
      "Sign in with `aws --profile trading-prod sso login` first.",
      true,
    ],
    ["an env var naming a profile", "infra.md", "Set AWS_PROFILE=trading-prod first.", true],
    ["an account id in a bucket name", "infra.md", "Bucket trading-builds-123456789012.", true],
    ["an instance id", "infra.md", "Instance i-0abc123def4567890 runs the bot.", true],
    [
      "a thread id, capitalised",
      "MEMORY.md",
      "- Thread 6b4c4c3d-7cb9-585e-aa23-6b2705f071cf: we squash-merge.",
      true,
    ],
    [
      "a SHA after its PR number",
      "MEMORY.md",
      "- 2026-11-24 (#1067, 25cdc1e4b43fe1e8): no module mocking.",
      true,
    ],
    ["a SHA a PR merged as", "decisions.md", `PR #1067 merged as ${SHA}.`, true],
    ["an arrow", "MEMORY.md", "- Squash merges \u2192 always, \u2265 2 reviews \u2713", true],
    ["a token after an ARN", "infra.md", `${ARN} ${GH}`, false],
    ["a token as an ARN's resource", "infra.md", `arn:aws:s3:::${GH}`, false],
    ["a record in an ARN's resource", "infra.md", "arn:aws:iam::123456789012:user/a:b:c:d", false],
    [
      "a secret in an ARN",
      "infra.md",
      `arn:aws:secretsmanager:eu-north-1:123456789012:secret:db`,
      false,
    ],
    ["a token in an env var", "infra.md", `DEPLOY_HOOK=${GH}`, false],
    ["a mixed run in an env var", "infra.md", "AWS_PROFILE=a1b2c3d4e5f6g7h8i9", false],
    ["text in hex a PR merged as", "decisions.md", `PR #1067 merged as ${HEX_TEXT}.`, false],
    ["a SHA beside a credential word", "decisions.md", `Merged as ${SHA}, the api key.`, false],
    ["an instance id as a session", "infra.md", "The session is i-0abc123def4567890.", false],
    ["an OpenAI key", "a.md", `Use ${OPENAI} for the evals.`, false],
    ["a GitLab token", "a.md", `Use ${GITLAB} for the mirror.`, false],
    ["an AWS access key id", "a.md", `The bot runs as ${AWS_ID}.`, false],
    ["a Hugging Face token", "a.md", `Pull with ${HUGGING}.`, false],
    ["a bearer JWT", "a.md", `Authorization: Bearer ${JWT}`, false],
    ["a bare JWT", "a.md", `Use ${JWT} for the call.`, false],
    // The security review of #1072: shapes the identifier allowances must not let through.
    ["an Anthropic key", "a.md", `Evals use ${ANTHROPIC}.`, false],
    ["a GitHub OAuth token", "a.md", `The app holds ${GH_OAUTH}.`, false],
    ["a fine-grained GitHub token", "a.md", `CI uses ${GH_PAT}.`, false],
    ["a bare AWS secret key", "a.md", `It signs with ${AWS_SECRET} today.`, false],
    [
      "a pronounceable AWS key id after an ARN",
      "a.md",
      `arn:aws:s3:::builds/${AWS_ID_WORDS}`,
      false,
    ],
    [
      "a pronounceable AWS key id in a slug",
      "a.md",
      `Bucket trading-123456789012-${AWS_ID_WORDS}.`,
      false,
    ],
    ["a short password as an env var", "a.md", "Set GRAFANA_ADMIN=Orchard7Lantern first.", false],
    ["a short password, short name", "a.md", "ADMIN=Orchard7Lantern", false],
    ["a short mixed code as an env var", "a.md", "DEPLOY_CODE=Ab3dE5gH7jK9mN1", false],
    ["a pair after an ARN", "a.md", `${ARN} appuser:Orchard7Lantern`, false],
    ["a key with full-length lines", "a.md", PEM_REAL, false],
    ["a key with full-length lines, fenced", "a.md", `\`\`\`\n${PEM_REAL}\n\`\`\``, false],
    [
      "a key with full-length lines, in a list item",
      "a.md",
      `- The key:\n  ${PEM_REAL.split("\n").join("\n  ")}`,
      false,
    ],
    [
      "JSON over lines",
      "a.md",
      `{\n  "type": "service_account",\n  "client_email": "bot@example.test",\n  "private_key_id": "${SHA}"\n}`,
      false,
    ],
    // Plain prose a worker still reads: not over-blocked.
    ["a word on each line", "days.md", "Mondays\nTuesdays\nWednesdays\nrelease-notes", true],
    [
      "10.4: a decision with its commit",
      "decisions.md",
      "2026-11-07: PR #198 landed at 0123456789abcdef0123456789abcdef01234567.",
      true,
    ],
    ["10.4: a short head", "decisions.md", "Reviewed at head e0d0a61, then fixed.", true],
    ["10.4: a SHA with an ellipsis", "decisions.md", "Merged as 3b64ac47\u2026 on Friday.", true],
    ["10.4: commit and sha", "decisions.md", "See commit 720331533d7451d6 and sha abc1234.", true],
    [
      "10.5: a file in a folder",
      "repos/api.md",
      "2026-11-07: PR #198 uses the daily schedule.",
      true,
    ],
    ["10.5: a nested folder", "repos/gram/notes.md", "Ordinary prose.", true],
    ["plain names with numbers", "release-notes-2026-11-07.md", "Ordinary prose.", true],
    ["a word that starts like a prefix", "github-actions.md", "Ordinary prose.", true],
    ["a URL with no userinfo", "links.md", "Docs live at https://example.test/docs/start.", true],
    [
      // The body reads; a file named `auth.md` stays hidden by the name rule (rounds 4 and 9).
      "11.5: a security decision",
      "decisions.md",
      "2026-11-07: PR #198 keeps authentication in the CLI.",
      true,
    ],
    [
      "11.5: a source location",
      "location.md",
      "The coordinator lives in packages/server/src/orchestration/service/spawning.ts.",
      true,
    ],
    ["11.5: accented prose", "style.md", "Pr\u00e9f\u00e9rer les petits changements.", true],
    ["11.6: a long topic name", "internationalization.md", "Ordinary prose.", true],
    ["11.6: a year suffix", "test2026.md", "Ordinary prose.", true],
    ["11.6: a long topic folder", "internationalization/notes.md", "Ordinary prose.", true],
    ["11.7 (accepted): an uncited-looking SHA", "a.md", `Use the value at ${SHA}.`, true],
    ["a short alternation in a name", "e2e-notes.md", "Ordinary prose.", true],
    [
      "12.3: provenance beside a weak word",
      "dated.md",
      "2026-11-07: owner/repo#198 keeps authentication in the CLI.",
      true,
    ],
    [
      "12.3: a flag beside a weak word",
      "notes.md",
      "Use retry=false in the CLI authentication flow.",
      true,
    ],
    ["12.3: a weak word alone", "notes.md", "Authentication stays in the CLI.", true],
    ["12.3: a flag", "flags.md", "Use maxWorkers=4 for the daily schedule.", true],
    [
      "12.3: provenance with a SHA",
      "dated.md",
      "2026-11-07: PR owner/repo#198 landed at 0123456789abcdef0123456789abcdef01234567.",
      true,
    ],
    ["times are no record", "schedule.md", "It ran 07:49:20 and again at 09:00.", true],
    // G-SS-04: a dated entry naming its source, which hid the whole index from every worker.
    [
      "a long hyphenated name",
      "MEMORY.md",
      "- 2026-11-19 (qa-2026-11-19-use-cases): we squash-merge.",
      true,
    ],
    [
      "a long branch name",
      "decisions.md",
      "Branch fix-memory-filter-false-positives landed.",
      true,
    ],
    [
      "a cited thread id before the entry's colon",
      "MEMORY.md",
      "- 2026-11-19 (thread 6b4c4c3d-7cb9-585e-aa23-6b2705f071cf): we squash-merge.",
      true,
    ],
    ["an uncited uuid", "a.md", "Use 6b4c4c3d-7cb9-585e-aa23-6b2705f071cf here.", false],
    [
      "a cited id beside a credential word",
      "a.md",
      "From thread 6b4c4c3d-7cb9-585e-aa23-6b2705f071cf, the api key.",
      false,
    ],
    ["mixed-case pieces", "a.md", "Use xK9q-Lm3p-Zz8r-Qw2e-Rt5y here.", false],
    ["consonant clusters joined", "a.md", "Use abqz-xkcd-mnop-wert-yuio here.", false],
    ["random letters joined", "a.md", "Use qwrtzp-xvbnmk-plkjhg-fdsazx here.", false],
    ["base64 joined by dashes", "a.md", "Use aGVsbG8-d29ybGQ-aGVsbG8-d29ybGQ here.", false],
    ["13.5: a short sentence", "short.md", "Authentication works.", true],
    ["13.5: a short private sentence", "people.md", "Private repositories work.", true],
    ["13.6: IPv6 loopback", "sockets.md", "The service binds to [::1]:8080.", true],
    ["13.6: a Rust path", "rust.md", "Use std::sync::Arc for sharing.", true],
    ["13.6: a full IPv6 address", "sockets.md", "It listens on 2001:db8:0:0:0:0:0:1 too.", true],
    ["13.7: a flag after a weak word", "flags.md", "We use authentication with retry=false.", true],
    ["a port in prose", "ports.md", "Vite serves on localhost:5173 during dev.", true],
    ["an AUTH sentence", "redis-notes.md", "AUTH is required on the shared cache.", true],
    ["mkdir -p", "setup.md", "Run mkdir -p dist before the build.", true],
    ["a login page", "web.md", "The login page lives in apps/web.", true],
    ["a GitHub search", "search.md", "Search with is:open label:bug in the tracker.", true],
    ["a user in prose", "people.md", "The user amy owns the release checklist.", true],
    ["a weak word as a verb", "ci.md", "The tests pass on main.", true],
    ["a private repo", "repos.md", "The site repo is private and lives under the team.", true],
    [
      "a camelCase name in prose",
      "code.md",
      "Routines save through editCharter, not writeCharter.",
      true,
    ],
    ["tabs, not spaces", "conventions.md", "Use tabs, not spaces.", true],
    [
      "typographic punctuation",
      "style/voice.md",
      "\u201CShip small\u201D \u2014 never rebase\u2026 \u2022 squash merges.",
      true,
    ],
    ["paths and versions", "release.md", "Release notes go in CHANGELOG.md before 1.10.1.", true],
    ["a short path", "repo-layout.md", "Server tests live in packages/server/src.", true],
    [
      "dates and times",
      "schedule.md",
      "---\ntitle: Weekly\nupdated: 2026-11-07\n---\nRuns at 09:00 on Mondays.",
      true,
    ],
  ];

describe("workerMayRead, every review's cases", () => {
  it.each(CASES)("%s", (_label, path, text, allowed) => {
    expect(workerMayRead(path, text)).toBe(allowed);
  });
});

const PLAIN = [
  "# Notes",
  "## Conventions",
  "- We squash-merge.",
  "- Tabs, not spaces.",
  "## Staging",
];

/** `text` in its own section of a note, after a plain one, as a note with headings has it. */
const inNote = (text: string) =>
  [PLAIN[0], "", PLAIN[1], "", PLAIN[2], PLAIN[3], "", PLAIN[4], "", text, ""].join("\n");

const MARKER = /^(?:[-*+] |\d{1,3}[.)] |#{1,6} )?\[lines? [\d–]+ withheld from workers\]$/;

/** A worker's view of `text` shows nothing but lines of `plain` and markers, or nothing at all. */
const showsOnly = (path: string, text: string, plain: ReadonlyArray<string>) => {
  const view = workerView(path, text);
  if (view.kind === "hidden") return;
  for (const line of view.text.split("\n")) {
    if (line.trim() === "" || MARKER.test(line)) continue;
    expect(plain, `${JSON.stringify(line)} shown`).toContain(line);
  }
  expect(workerMayRead(path, view.text)).toBe(true);
};

const SECRETS = CASES.filter(([, , , allowed]) => !allowed);

describe("workerView, each secret a worker may not read", () => {
  it.each(SECRETS)("%s: alone, it shows nothing of it", (_label, path, text) => {
    expect(workerMayRead(path, text)).toBe(false);
    expect(workerView(path, text).kind).toBe("hidden");
  });

  it.each(SECRETS.filter(([, , text]) => !/^(?:---|\+\+\+|<!--)/.test(text)))(
    "%s: between plain blocks, it shows only them",
    (_label, path, text) => {
      const note = inNote(text);
      expect(workerMayRead(path, note)).toBe(false);
      showsOnly(path, note, PLAIN);
    },
  );
});

describe("workerView, a value split from what names it", () => {
  const BASE64 = Buffer.from(GH).toString("base64");
  const SPLIT: ReadonlyArray<readonly [label: string, text: string]> = [
    ["after a blank line", "- The staging password is:\n\norchard-willow"],
    ["under a heading", "## Password\n\norchard-willow"],
    ["as the next list item", "- Bearer\n- orchard-willow"],
    ["as a paragraph's next line", "The dsn\norchard-willow"],
    ["before what names it", "orchard willow\n\nis the staging password."],
    ["before a list item naming it", "- orchard willow\n- = the staging password"],
    // The security review of #1072, finding 1: low-entropy values a block away from their name.
    [
      "a list under a heading that names it",
      "## Test accounts (passwords)\n\n- amy / Orchard7Lantern\n- bob / Willow3Harbor",
    ],
    [
      "under a heading naming it mid-way",
      "## Passwords for the staging box\n\ndeploy / Orchard7Lantern",
    ],
    [
      "fenced after a sentence naming it",
      "Use this password for the staging admin (ask before rotating).\n\n```\nOrchard7Lantern\n```",
    ],
    ["a nested list item", "- Staging admin password (shared with ops)\n  - orchard lantern seven"],
    [
      "the third item after a lead-in",
      "The staging passwords:\n\n- amy Orchard7Lantern\n- bob Willow3Harbor\n- cy Harbor9Orchard",
    ],
    ["before a sentence naming it", "orchard lantern seven\n\nThat is the staging password."],
    [
      "as the heading over a sentence naming it",
      "### Orchard7Lantern\n\nThat is the staging password.",
    ],
    [
      "a table split by a blank line",
      "| user | password |\n| --- | --- |\n\n| amy | Orchard7Lantern |",
    ],
    ["JSON split by a blank line", '{"user": "amy",\n\n"password": "Orchard7Lantern"}'],
    ["under a subsection", "Passwords are below.\n\n### Admin\n\nOrchard7Lantern"],
    [
      "base64 as list items",
      [BASE64.slice(0, 16), ...(BASE64.slice(16).match(/.{1,4}/g) ?? [])]
        .map((piece) => `- ${piece}`)
        .join("\n"),
    ],
    [
      "base64 over blank lines",
      [BASE64.slice(0, 16), ...(BASE64.slice(16).match(/.{1,4}/g) ?? [])].join("\n\n"),
    ],
    [
      "an encrypted key's body after its header",
      `${PEM_BEGIN}\nProc-Type: 4,ENCRYPTED\n\nb3Blbg==\n${PEM_END}`,
    ],
  ];

  it.each(SPLIT)("%s: shows none of it, and the plain section still", (_label, text) => {
    const note = inNote(text);
    expect(workerMayRead("notes.md", note)).toBe(false);
    showsOnly("notes.md", note, PLAIN);
    const view = workerView("notes.md", note);
    expect(view.kind === "shown" && view.text.includes(PLAIN[2]!)).toBe(true);
  });

  it("withholds a credential's section, and shows the sections around it", () => {
    const note = [
      "# Notes",
      "",
      "## Conventions",
      "",
      "- We squash-merge.",
      "",
      "## Staging",
      "",
      "- Keep the API key out of logs.",
      "- Deploys go through the pipeline.",
      "",
      "## Style",
      "",
      "- Tabs, not spaces.",
      "",
    ].join("\n");
    expect(workerView("notes.md", note)).toEqual({
      kind: "shown",
      text: [
        "# Notes",
        "",
        "## Conventions",
        "",
        "- We squash-merge.",
        "",
        "## Staging",
        "",
        "- [lines 9–10 withheld from workers]",
        "",
        "## Style",
        "",
        "- Tabs, not spaces.",
        "",
      ].join("\n"),
      withheld: [{ from: 9, to: 10, problem: "something shaped like a credential" }],
    });
  });

  it("withholds a note with no heading whole when it names a credential", () => {
    const note = "- We squash-merge.\n- Keep the API key out of logs.\n";
    expect(workerView("notes.md", note).kind).toBe("hidden");
  });

  it("withholds only the block a self-delimited token is in", () => {
    const note = inNote(`- Webhook ${SLACK}\n- Deploys go through the pipeline.`);
    const view = workerView("notes.md", note);
    expect(view.kind === "shown" && view.text.includes("Deploys go through the pipeline.")).toBe(
      true,
    );
  });
});

describe("workerMayEnter", () => {
  it("goes into plain folders only, none named for a credential", () => {
    for (const path of ["repos", "repos/shop", "release-notes"]) {
      expect(workerMayEnter(path), path).toBe(true);
    }
    for (const path of [".git", "Repos", "private", "session", "repos/api_keys", "a b", "ok.md"]) {
      expect(workerMayEnter(path), path).toBe(false);
    }
  });
});
