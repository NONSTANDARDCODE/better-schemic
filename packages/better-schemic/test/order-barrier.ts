/**
 * No-op empty spread used as a lint partition barrier by golden-SQL fixtures.
 *
 * `perfectionist/sort-objects` treats a spread as a partition boundary, so a barrier lets a fixture
 * keep the author order that its expected serialized SQL depends on — without a suppression comment.
 */
export const KEEP_ORDER = {} as const
