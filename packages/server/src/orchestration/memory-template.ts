/** What a new workspace's `MEMORY.md` starts as. */
export const MEMORY_INDEX_TEMPLATE = `# Memory index

Memory is a folder of short notes, one per subject, and this index, which every session starts
from. Keep this file under 8 KB: one line per note, as \`- [[name]]: what it holds\`, plus the few
facts worth having in every session.

The orchestrator and its workers all read and write memory; the orchestrator keeps it tidy. Read a
note before you change it and keep what you aren't changing. Add an entry with \`memory_append\`,
change one with \`memory_edit\`, and rewrite a whole note with \`memory_write\` and the
\`revision\` its read gave you.

A note starts with front matter: \`name\` (the note's file name without \`.md\`), \`description\`
(one line, what decides whether it is worth reading) and \`type\` (\`goal\`, \`decision\`,
\`repo\`, \`project\`, \`feedback\` or \`reference\`). Date every entry and name its source (a
feature, a PR, a thread): an undated fact can't be judged stale. Nothing derivable belongs here:
worker states, PRs and budgets come from \`list_workers\`, and what a repo's CLAUDE.md already says
stays there. Link related notes with \`[[name]]\`.

New workspaces start with only this index. The names below are suggestions, not an inventory.
Use \`memory_list\` to see which notes exist. Make a note only when there is something to record,
then add it here; a missing suggested note has no recorded content yet.

## Suggested notes (made only when needed)

- goals.md: what the user wants from this workspace, in priority order, dated
- decisions.md: what was decided, why, and which feature or PR it came from
- standing-decisions.md: the user's rulings that hold until they say otherwise, in their words
- map.md: how the repos relate: who calls whom, where contracts live, merge and deploy order
- questions.md: open questions for the user; each has an id and is closed, not deleted
- repos/<name>.md: what was learned about working in one repo that its CLAUDE.md doesn't say
- one note per other subject, such as a system, a trap or how the user likes something done
`;
