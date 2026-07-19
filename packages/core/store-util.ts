/**
 * Shared L2-store encoding. Tags are stored as one delimited text column
 * (`|tag1|tag2|`), matched with `LIKE '%|tag|%'` — a single mechanism that
 * behaves identically on SQLite, Postgres, and MySQL (the guidelines' one-
 * code-path rule). It is O(rows) per invalidated tag; the L2 is a shared
 * warm-start tier, not the hot path — the hot path is L1's reverse index.
 */

export function serializeTags(tags: readonly string[]): string {
  return tags.length === 0 ? '' : `|${tags.join('|')}|`;
}

export function parseTags(encoded: string): string[] {
  return encoded === '' ? [] : encoded.slice(1, -1).split('|');
}

/**
 * LIKE pattern for one tag. The tag charset allows `_` (a LIKE wildcard
 * matching any single character), so it is escaped and every store query
 * appends `ESCAPE '!'`. `!` is the escape character precisely because it
 * needs no string-literal escaping on any dialect — MySQL backslash-escapes
 * its literals, so `ESCAPE '\'` is a syntax error there while valid on
 * Postgres/SQLite. `%`, `!`, and `\` are all excluded by tag validation.
 */
export function tagLikePattern(tag: string): string {
  return `%|${tag.replaceAll('_', '!_')}|%`;
}
