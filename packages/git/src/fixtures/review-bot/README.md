# Synthetic review scenarios

These GraphQL responses use invented IDs, commit hashes, timestamps, paths, and
review text. They model changes requested (two blockers, four suggestions, one
untagged finding, five outdated unresolved threads), a resolved comment-only
round, an approval after changes requested, and untagged findings with a code
suggestion. They preserve review-state semantics without retaining private prose
or recorded source IDs. Keep tags, metadata, head relationships, resolution flags,
and suggestion fences consistent with the assertions when changing them.
