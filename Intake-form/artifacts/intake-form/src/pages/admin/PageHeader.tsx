// PageHeader — eyebrow / title / subtitle / actions, plus the scope line.
//
// Adapted from the CJC console's PageHeader, with one addition that matters
// more here than there: `scope`.
//
// THE SCOPE LINE. Every reporting page states, in one plain sentence and
// BEFORE any chart, what it is counting: the window, the timezone, the unit and
// the deduplication posture. It is the cheapest element in the whole design and
// the one that stops a number being misread. DrSnip's version has to carry the
// unit and the dedup posture as well as the window, because "submissions" and
// "patients" are exactly what its figures get confused for.

import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  children,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6" data-testid="page-header">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && (
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--sh-muted)]">
              {eyebrow}
            </div>
          )}
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--sh-fg)]">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1 max-w-2xl text-sm text-[var(--sh-muted)]">{subtitle}</p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * One sentence naming what every number below it counts. Renders nothing when
 * given nothing, so a page cannot ship a half-built scope line.
 */
export function ScopeLine({ parts }: { parts: Array<string | null | undefined> }) {
  const shown = parts.filter((p): p is string => Boolean(p && p.trim()));
  if (shown.length === 0) return null;
  return (
    <p
      className="mt-3 text-xs text-[var(--sh-muted)]"
      data-testid="scope-line"
    >
      {shown.join(" · ")}
    </p>
  );
}

export default PageHeader;
