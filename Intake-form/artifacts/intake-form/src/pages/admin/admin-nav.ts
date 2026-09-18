// The navigation model for the DrSnip admin shell.
//
// PURE and framework-free so it is unit-testable without a DOM: AdminLayout
// maps `icon` keys to lucide components and renders it. Adapted from the CJC
// console's nav model (same helper contract, new entries).
//
// THE SIX-INTO-FIVE PROBLEM. The console has six sections — Links,
// Submissions, Drop-offs, Dashboard, Activity, Ask AI — and the previous
// layout tried to fit them all into one mobile strip. It had already given up:
// the old AdminLayout carried the comment "5 tabs no longer fit equally on
// mobile — switch to horizontal scroll", and then a sixth was added. A
// horizontally-scrolling nav hides destinations behind a gesture with no
// affordance.
//
// The fix is FIVE mobile slots, with grouping rather than scrolling:
//
//   Submissions   -> /admin/submissions   + Drop-offs
//   Reports       -> /admin/dashboard     + Insurance follow-up, Activity
//   Links         -> /admin/links
//   Ask AI        -> /admin/ask-ai
//   Settings      -> /admin/sources       + account / sign out
//
// Five slots, EIGHT destinations, every one reachable in at most two taps. A
// slot with children opens a bottom sheet that lists the PARENT route first, so
// grouping never hides the main page behind its own children — tapping
// "Reports" then "Dashboard" always works, and on desktop the parent is a
// direct link.
//
// ROUTES ARE UNCHANGED. Every path below already existed, so no redirect is
// needed and every bookmark and deep link keeps working — including
// /admin/submissions/:id, which the n8n manual-review emails link to.
// /admin/sources is the one exception in the other direction: the page and route
// already existed but were absent from the nav, so this makes it reachable for
// the first time.

export type NavIcon = "inbox" | "chart" | "link" | "sparkles" | "settings";

export type NavChild = {
  to: string;
  label: string;
  /** Marks a destination whose content is synthetic. Rendered as a chip. */
  demo?: boolean;
};

export type NavEntry = {
  /** Stable id, used for the mobile sheet's open state. */
  id: string;
  /** The slot's own route — where the desktop link and a childless tap go. */
  to: string;
  /** Label shown in the sidebar and under the mobile icon. */
  label: string;
  /** Label for the slot's own route inside the mobile sheet, when it differs. */
  selfLabel?: string;
  icon: NavIcon;
  children?: NavChild[];
  /**
   * Open the mobile sheet for this slot even though it has no children.
   *
   * Settings needs this: its only destination is its own route, but the sheet
   * is also where the signed-in user and SIGN OUT live on mobile. Without it
   * the slot rendered as a plain link and there was no way to sign out on a
   * phone at all — which is exactly the gap the old fixed user chip left.
   */
  sheet?: boolean;
};

export const PRIMARY_NAV: NavEntry[] = [
  {
    id: "submissions",
    to: "/admin/submissions",
    label: "Submissions",
    selfLabel: "All submissions",
    icon: "inbox",
    children: [{ to: "/admin/dropoffs", label: "Drop-offs" }],
  },
  {
    id: "reports",
    to: "/admin/dashboard",
    label: "Reports",
    selfLabel: "Dashboard",
    icon: "chart",
    children: [
      { to: "/admin/insurance-demo", label: "Insurance follow-up", demo: true },
      { to: "/admin/activity", label: "Activity" },
    ],
  },
  { id: "links", to: "/admin/links", label: "Links", icon: "link" },
  { id: "ask-ai", to: "/admin/ask-ai", label: "Ask AI", icon: "sparkles" },
  {
    id: "settings",
    to: "/admin/sources",
    label: "Settings",
    selfLabel: "Marketing sources",
    icon: "settings",
    // Opens a sheet on mobile so sign-out has a home. See `sheet` above.
    sheet: true,
  },
];

/**
 * A route is active when the current path is, or is under, the target.
 *
 * The trailing-slash form matters for /admin/submissions/:id — a submission
 * deep-link must still light up the Submissions entry.
 */
export function isRouteActive(path: string, to: string): boolean {
  return path === to || path.startsWith(to + "/");
}

/** An entry is active if its own route or any child route is active. */
export function isItemActive(path: string, entry: NavEntry): boolean {
  if (isRouteActive(path, entry.to)) return true;
  return (entry.children ?? []).some((c) => isRouteActive(path, c.to));
}

/** True when a child (not the entry's own route) is the active one. */
export function hasActiveChild(path: string, entry: NavEntry): boolean {
  return (entry.children ?? []).some((c) => isRouteActive(path, c.to));
}

/**
 * Every destination the shell can reach — the "nothing unreachable" test.
 * Eight: five slot routes plus three children.
 */
export function allNavRoutes(): string[] {
  const out: string[] = [];
  for (const e of PRIMARY_NAV) {
    out.push(e.to);
    for (const c of e.children ?? []) out.push(c.to);
  }
  return out;
}

/** True when this slot should open the mobile bottom sheet rather than navigate. */
export function opensSheet(entry: NavEntry): boolean {
  return (entry.children ?? []).length > 0 || entry.sheet === true;
}

/** The label to show for the current route, for the mobile top bar. */
export function activeLabel(path: string, fallback = "Admin"): string {
  for (const e of PRIMARY_NAV) {
    for (const c of e.children ?? []) {
      if (isRouteActive(path, c.to)) return c.label;
    }
  }
  for (const e of PRIMARY_NAV) {
    if (isRouteActive(path, e.to)) return e.selfLabel ?? e.label;
  }
  return fallback;
}
