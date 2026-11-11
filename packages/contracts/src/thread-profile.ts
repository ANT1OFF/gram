/**
 * A thread profile: everything a thread is started with when something other than a person at the
 * composer starts it (`thread.createFromProfile`). Its charter, the files and skills laid into its
 * folder, its agent and model, its one MCP server, how much it does without asking, and where it
 * works. A profile is supplied whole and applied once; what the thread keeps of it is its
 * `ThreadProfileBinding`.
 *
 * A profile never carries a credential. The model's key is a gateway profile's, named by id, and
 * the MCP server is an address alone.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  AgentKind,
  PROFILE_CHARTER_MAX,
  ProfileAutonomy,
  ProfileConnectorServer,
  ReasoningVariant,
  type ThreadProfileBinding,
} from "./domain.ts";
import { HostId, ProfileId, ThreadId } from "./ids.ts";
import { connectorEntryProblem } from "./workspaces.ts";

/** The most files a profile lays, its skills' own among them. */
export const PROFILE_FILES_MAX = 200;
/** The most a profile's files hold together, in UTF-8 bytes. */
export const PROFILE_FILES_MAX_BYTES = 1_000_000;
/** The most skills a profile carries. */
export const PROFILE_SKILLS_MAX = 50;
/** The most repositories a profile's workplace names. */
export const PROFILE_REPOSITORIES_MAX = 8;

/** A text file laid into the thread's folder: `path` is relative to it, with `/` between names. */
export const ProfileFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});
export type ProfileFile = typeof ProfileFile.Type;

/**
 * A skill, written where the thread's agent reads a folder's skills (`PROFILE_SKILLS_DIR`), so a
 * supplier needs no layout per agent. `body` is the skill's instructions, without front matter.
 */
export const ProfileSkill = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)),
  description: Schema.String.check(Schema.isMaxLength(1024)),
  body: Schema.String,
  /** Further files of the skill, each `path` relative to the skill's own folder. */
  files: Schema.optionalKey(Schema.Array(ProfileFile)),
});
export type ProfileSkill = typeof ProfileSkill.Type;

const ProfileModelChoice = Schema.Struct({
  model: Schema.NonEmptyString,
  effort: Schema.optionalKey(ReasoningVariant),
});

/** What the thread runs on. */
export const ProfileModel = Schema.Struct({
  ...ProfileModelChoice.fields,
  /**
   * The gateway profile the model is served by, by its id here; absent runs on the agent's own
   * login. Named, never supplied: its address and key are this Gram's settings.
   */
  gatewayProfile: Schema.optionalKey(ProfileId),
  /** Models to fall back to, in order (`ThreadProfileBinding.fallbacks`). */
  fallbacks: Schema.optionalKey(Schema.Array(ProfileModelChoice)),
});
export type ProfileModel = typeof ProfileModel.Type;

/** One repository of a workplace. */
export const ProfileRepository = Schema.Struct({
  /** An https or ssh remote, with no credentials in it. */
  url: Schema.String.check(Schema.isMaxLength(512)),
  /** The branch, tag or commit the work starts from; absent is the remote's default branch. */
  ref: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255))),
  /** The new branch the thread works on; absent, one is named for the thread. */
  branch: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255))),
});
export type ProfileRepository = typeof ProfileRepository.Type;

/**
 * Where the thread works. `none` and `scratch` both get a new, empty folder of the thread's own,
 * since an agent session always has one: `none` says nothing in it is meant to be kept. With
 * `repositories` the first is the thread's folder and the rest sit beside it.
 */
export const ProfileWorkplace = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("scratch") }),
  Schema.Struct({
    kind: Schema.Literal("repositories"),
    repositories: Schema.Array(ProfileRepository),
  }),
]);
export type ProfileWorkplace = typeof ProfileWorkplace.Type;

export const ThreadProfile = Schema.Struct({
  /** The shape's version. A profile of another version is refused, never guessed at. */
  version: Schema.Literal(1),
  /** The profile's name; the thread's title until it gets one of its own. */
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  /** What the profile was made from, opaque here (`ThreadProfileBinding.source`). */
  source: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String.check(Schema.isMaxLength(200)),
      version: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
    }),
  ),
  agent: AgentKind,
  /** Standing instructions, added to the agent's system prompt at every session open. */
  charter: Schema.String.check(Schema.isMaxLength(PROFILE_CHARTER_MAX)),
  /** Laid into the thread's folder before its first session opens. */
  files: Schema.optionalKey(Schema.Array(ProfileFile)),
  skills: Schema.optionalKey(Schema.Array(ProfileSkill)),
  model: ProfileModel,
  /**
   * The thread's MCP servers beside Gram's own: the one named, or none. Its sessions are held to
   * that whatever the agent is configured with where it runs.
   */
  connectors: Schema.Struct({ server: Schema.optionalKey(ProfileConnectorServer) }),
  /** Absent is `publish`. */
  autonomy: Schema.optionalKey(ProfileAutonomy),
  workplace: ProfileWorkplace,
  /** The first message; absent opens the thread's session and waits. */
  input: Schema.optionalKey(Schema.String),
});
export type ThreadProfile = typeof ThreadProfile.Type;

/** Where each agent reads the skills of the folder it runs in, relative to that folder. */
export const PROFILE_SKILLS_DIR: Readonly<Record<AgentKind, string>> = {
  claude: ".claude/skills",
  codex: ".agents/skills",
};

const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

/** Server names a profile can't take: Gram's own app tools go by it in every session. */
const RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set(["gram"]);

/**
 * Why `path` can't be laid, or `undefined`: a relative path of plain names that stays inside the
 * folder it is laid into and out of a repository's own `.git`.
 */
export const profilePathProblem = (path: string): string | undefined => {
  if (path === "" || path.length > 300) return "A file's path is 1 to 300 characters.";
  // Control characters and a backslash have no place in a name that is the same on every system.
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path))
    return `${JSON.stringify(path)} has a backslash or a control character in it.`;
  // Invisible and direction characters make one name read as another (`.g\u200cit` is `.git` on
  // some disks).
  if (/\p{Cf}/u.test(path)) return `${JSON.stringify(path)} has an invisible character in it.`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path))
    return `${path} is absolute; a file's path is relative to the thread's folder.`;
  // What names a drive, a stream or a wildcard somewhere: a path means one file everywhere.
  if (/[:<>"|?*]/.test(path)) return `${path} has one of : < > " | ? * in it.`;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return `${path} has an empty, "." or ".." name in it.`;
  // A trailing dot or space is dropped by some disks, so `.git.` and `a.` would be other names.
  if (segments.some((segment) => /^\s|[.\s]$/.test(segment)))
    return `${path} has a name that starts with a space or ends with a dot or a space.`;
  if (segments.some((segment) => WINDOWS_DEVICE.test(segment)))
    return `${path} has a name some systems keep for a device.`;
  // `.git` itself, and the short name a disk may give it.
  if (segments.some((segment) => /^(?:\.git|git~\d+)$/i.test(segment)))
    return `${path} is inside a .git folder, which is the repository's own.`;
  return undefined;
};

/** One file on every disk: composed the same way and compared without case. */
const pathKey = (path: string): string => path.normalize("NFC").toLowerCase();

/** `---`-fenced front matter Claude Code and Codex both read a skill's name and description from. */
const skillDocument = (skill: ProfileSkill): string =>
  `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.body}${
    skill.body.endsWith("\n") ? "" : "\n"
  }`;

/**
 * Every file the profile lays, its skills written out for its agent: each skill's `SKILL.md` and
 * its other files under `PROFILE_SKILLS_DIR`, after the profile's own files.
 */
export const profileFilesOf = (
  profile: Pick<ThreadProfile, "agent" | "files" | "skills">,
): ReadonlyArray<ProfileFile> => [
  ...(profile.files ?? []),
  ...(profile.skills ?? []).flatMap((skill) => {
    const dir = `${PROFILE_SKILLS_DIR[profile.agent]}/${skill.name}`;
    return [
      { path: `${dir}/SKILL.md`, content: skillDocument(skill) },
      ...(skill.files ?? []).map((file) => ({ ...file, path: `${dir}/${file.path}` })),
    ];
  }),
];

const utf8 = new TextEncoder();

/**
 * What the schema can't say is wrong with a profile, each in a sentence; empty when it can be
 * applied. Checked before anything is made, so a profile that is refused leaves nothing behind.
 */
export const profileProblems = (profile: ThreadProfile): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const skills = profile.skills ?? [];
  if (skills.length > PROFILE_SKILLS_MAX)
    problems.push(`A profile carries at most ${PROFILE_SKILLS_MAX} skills.`);
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name)) problems.push(`Two skills are named ${skill.name}.`);
    names.add(skill.name);
    if ((skill.files ?? []).some((file) => file.path.toLowerCase() === "skill.md"))
      problems.push(`The skill ${skill.name} has a file named SKILL.md; that is its body.`);
  }
  const files = profileFilesOf(profile);
  if (files.length > PROFILE_FILES_MAX)
    problems.push(`A profile lays at most ${PROFILE_FILES_MAX} files, its skills' among them.`);
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    const problem = profilePathProblem(file.path);
    if (problem !== undefined) problems.push(problem);
    // Two names that differ only by case or composition are one file on some disks.
    const key = pathKey(file.path);
    if (paths.has(key)) problems.push(`Two files are laid at ${file.path}.`);
    paths.add(key);
    bytes += utf8.encode(file.content).length;
  }
  for (const key of paths) {
    const parts = key.split("/");
    if (parts.slice(1).some((_, i) => paths.has(parts.slice(0, i + 1).join("/"))))
      problems.push(`${key} is inside a path another file is laid at.`);
  }
  if (bytes > PROFILE_FILES_MAX_BYTES)
    problems.push(`A profile's files hold at most ${PROFILE_FILES_MAX_BYTES} bytes together.`);
  const server = profile.connectors.server;
  if (server !== undefined) {
    if (RESERVED_SERVER_NAMES.has(server.name.toLowerCase()))
      problems.push(`An MCP server can't be named ${server.name}: that is Gram's own.`);
    const entry =
      /^https?:\/\//i.test(server.url) &&
      server.url === server.url.trim() &&
      URL.canParse(server.url)
        ? connectorEntryProblem(server.url)
        : "Give the MCP server's http or https address, and nothing around it.";
    if (entry !== undefined) problems.push(entry);
    else if (server.url.includes("*"))
      problems.push("An MCP server's address is one address, without a wildcard.");
  }
  if (profile.workplace.kind === "repositories") {
    const count = profile.workplace.repositories.length;
    if (count === 0 || count > PROFILE_REPOSITORIES_MAX)
      problems.push(`A workplace of repositories names 1 to ${PROFILE_REPOSITORIES_MAX} of them.`);
    for (const repository of profile.workplace.repositories) {
      for (const name of [repository.ref, repository.branch]) {
        if (name !== undefined && (name === "" || name.startsWith("-") || /[\s\0]/.test(name)))
          problems.push(`${JSON.stringify(name)} isn't a branch, tag or commit.`);
      }
    }
  }
  return problems;
};

/** The start of a decode failure as one line: what was expected and where, never the value. */
const firstLines = (message: string) =>
  message.split("\n").slice(0, 3).join(" ").replace(/\s+/g, " ").trim();

/**
 * `value` as a profile, or why it isn't one. Strict: a key the shape doesn't name is refused
 * rather than dropped, so a supplier never believes something was applied that this version
 * doesn't know.
 */
export const decodeThreadProfile = (
  value: unknown,
):
  | { readonly ok: true; readonly profile: ThreadProfile }
  | { readonly ok: false; readonly problems: ReadonlyArray<string> } => {
  const decoded = Schema.decodeUnknownResult(ThreadProfile, { onExcessProperty: "error" })(value);
  if (Result.isFailure(decoded))
    return { ok: false, problems: [firstLines(decoded.failure.message)] };
  const problems = profileProblems(decoded.success);
  return problems.length === 0 ? { ok: true, profile: decoded.success } : { ok: false, problems };
};

/** What a thread started from `profile` keeps of it. */
export const profileBindingOf = (profile: ThreadProfile): ThreadProfileBinding => ({
  ...(profile.name === undefined ? {} : { name: profile.name }),
  ...(profile.source === undefined ? {} : { source: profile.source }),
  charter: profile.charter,
  ...(profile.autonomy === undefined ? {} : { autonomy: profile.autonomy }),
  ...(profile.connectors.server === undefined ? {} : { server: profile.connectors.server }),
  ...(profile.model.fallbacks === undefined || profile.model.fallbacks.length === 0
    ? {}
    : { fallbacks: profile.model.fallbacks }),
});

/**
 * Where a fronting platform's own service starts a thread from a profile, over HTTP rather than
 * the RPC: `POST`, with a `ProfileStartRequest` as JSON, answered with a `ProfileStartResponse`.
 * One of the hosted features; a person's sign-in never reaches it.
 */
export const PROFILE_START_PATH = "/threads/from-profile";

export const ProfileStartRequest = Schema.Struct({
  /** A `ThreadProfile`, decoded strictly by the server. */
  profile: Schema.Unknown,
  /** The caller's own id for the thread, a lowercase UUID: asked for again, the same thread. */
  threadId: ThreadId,
  /** The joined machine the thread goes on, by the id it was provisioned or joined with. */
  hostId: Schema.optionalKey(HostId),
});
export type ProfileStartRequest = typeof ProfileStartRequest.Type;

export const ProfileStartResponse = Schema.Struct({
  threadId: ThreadId,
  /** False when an earlier ask under the same id made the thread, and this one made nothing. */
  created: Schema.Boolean,
});
export type ProfileStartResponse = typeof ProfileStartResponse.Type;
