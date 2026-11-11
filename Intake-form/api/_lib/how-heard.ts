// Read-time normalisation of Consultation how-heard values.
//
// The option label is the stored value, so a renamed option leaves historical
// rows on the old string. Rather than rewrite raw_payload, reporting maps each
// retired value onto the option that replaced it, so one channel stays one
// bucket. Every target must be a live option in
// artifacts/intake-form/src/lib/how-heard.ts (asserted in api/_test/how-heard.test.ts).

import { sql } from "@workspace/db";

type SQL = ReturnType<typeof sql>;

export const HOW_HEARD_LEGACY_ALIASES: Readonly<Record<string, string>> = {
  // 2026-11-12: "Radio" renamed to "Podcast / Radio" on the consultation form.
  Radio: "Podcast / Radio",
};

export function canonicalHowHeard(value: string): string {
  return Object.prototype.hasOwnProperty.call(HOW_HEARD_LEGACY_ALIASES, value)
    ? HOW_HEARD_LEGACY_ALIASES[value]
    : value;
}

/** Canonicalise and de-duplicate one submission's selections, keeping order. */
export function canonicalHowHeardList(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const c = canonicalHowHeard(v);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** SQL expression mapping a text column/expression through the alias table (values bound, never inlined). */
export function canonicalHowHeardSql(expr: SQL): SQL {
  const entries = Object.entries(HOW_HEARD_LEGACY_ALIASES);
  if (entries.length === 0) return expr;
  const whens = sql.join(
    entries.map(([from, to]) => sql`WHEN ${from}::text THEN ${to}::text`),
    sql` `,
  );
  return sql`(CASE ${expr} ${whens} ELSE ${expr} END)`;
}

/**
 * The how-heard tile's GROUP BY over consultation submissions. `where` is the
 * buildWhere() fragment and must reference the UNALIASED `submissions` table
 * (the location filter correlates on `submissions.<col>`). Each submission's
 * selections are canonicalised and DISTINCT-ed before counting, so a legacy
 * "Radio" lands in "Podcast / Radio" and a row holding both counts once.
 */
export function howHeardCountsSql(where: SQL, limit: number): SQL {
  return sql`
      SELECT hh.value, count(*)::int AS count
      FROM (
        SELECT DISTINCT submissions.id, ${canonicalHowHeardSql(sql`elem`)} AS value
        FROM submissions
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(submissions.raw_payload->'howHeard') = 'array'
               THEN submissions.raw_payload->'howHeard' ELSE '[]'::jsonb END
        ) AS elem
        ${where}
      ) AS hh
      GROUP BY 1
      ORDER BY 2 DESC, 1 ASC
      LIMIT ${limit}
    `;
}
