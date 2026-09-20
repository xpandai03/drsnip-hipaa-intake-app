import {
  Component,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Link, useLocation } from "wouter";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Inbox,
  BarChart3,
  Link2,
  Sparkles,
  Settings,
  LogOut,
  Loader2,
  ChevronRight,
  AlertTriangle,
  RotateCcw,
  FlaskConical,
  type LucideIcon,
} from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/lib/auth-context";
import {
  PRIMARY_NAV,
  activeLabel,
  isItemActive,
  isRouteActive,
  opensSheet,
  type NavEntry,
  type NavIcon,
} from "./admin-nav";
import "./admin-shell.css";

/**
 * The admin shell. Wraps every /admin/* page except /admin/signin.
 *
 * Replaces the floating-pill layout with a proper console chrome: a fixed
 * 256px sidebar on desktop, a top bar + five-slot bottom bar on mobile, a
 * per-route page transition, and an error boundary INSIDE the shell.
 *
 * Four things this adds that the previous layout did not have:
 *
 *   1. A mobile nav that fits. The old strip scrolled horizontally because six
 *      tabs would not fit; its own comment said so. Five slots with grouping
 *      replace it — see admin-nav.ts.
 *   2. An error boundary below the chrome, keyed on the route, so a page that
 *      throws leaves the navigation usable instead of blanking the console.
 *   3. A place for sign-out on mobile. The old `fixed top-4 right-4` user chip
 *      overlaid page content and was the only logout affordance; it is now the
 *      sidebar's user block on desktop and the Settings sheet on mobile.
 *   4. Visible focus on everything focusable (admin-shell.css), and a skip link.
 *
 * The server is still the gate — every protected /api/* handler calls
 * requireAuth. This guard is UX: it removes the flash of content.
 */

const ICON: Record<NavIcon, LucideIcon> = {
  inbox: Inbox,
  chart: BarChart3,
  link: Link2,
  sparkles: Sparkles,
  settings: Settings,
};

function DemoChip() {
  return (
    <span
      className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
      style={{
        background: "var(--sh-demo-bg)",
        borderColor: "var(--sh-demo-border)",
        color: "var(--sh-demo-fg)",
      }}
    >
      <FlaskConical className="h-2.5 w-2.5" />
      Demo
    </span>
  );
}

function NavRow({
  to,
  label,
  Icon,
  active,
  demo,
  indent,
  onNavigate,
}: {
  to: string;
  label: string;
  Icon?: LucideIcon;
  active: boolean;
  demo?: boolean;
  indent?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={to}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      data-testid={`admin-nav-${to.split("/").pop()}`}
      className={
        "relative flex items-center gap-3 py-2.5 pr-3 text-sm transition-colors " +
        (indent ? "pl-7 " : "pl-3 ") +
        (active
          ? "bg-[var(--sh-accent-active)] font-medium text-[var(--sh-accent-fg)]"
          : "text-[var(--sh-muted)] hover:bg-[var(--sh-surface-hover)] hover:text-[var(--sh-fg)]")
      }
    >
      {active && (
        <span className="admin-nav-active-bar absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 bg-[var(--sh-accent)]" />
      )}
      {Icon && <Icon className="h-4 w-4 shrink-0" />}
      <span className="truncate">{label}</span>
      {/* The chip is redundant when the label already begins "Demo:" — and in a
          256px sidebar the two together truncate the label, which is worse than
          either alone. The words win: they are read aloud, they survive a
          screenshot, and they cannot be mistaken for decoration. */}
      {demo && !active && !/^demo\b/i.test(label) && <DemoChip />}
    </Link>
  );
}

function SidebarNav({
  location,
  onNavigate,
}: {
  location: string;
  onNavigate?: () => void;
}) {
  return (
    <nav
      aria-label="Console sections"
      className="flex-1 space-y-1 overflow-y-auto p-3"
    >
      {PRIMARY_NAV.map((entry: NavEntry) => {
        const Icon = ICON[entry.icon];
        const children = entry.children ?? [];
        // Children are ALWAYS shown on desktop, where there is room for them.
        //
        // They used to appear only once the group's subtree was active, which
        // meant the only way to discover "Patient journeys" was to already be
        // looking at it. A sidebar that hides its destinations until you have
        // found them is not navigation. The mobile sheet is unchanged — there
        // the group opens on tap, which is the same one-tap reveal.
        const expanded = children.length > 0;
        return (
          <div key={entry.id}>
            <NavRow
              to={entry.to}
              label={entry.label}
              Icon={Icon}
              active={isRouteActive(location, entry.to)}
              onNavigate={onNavigate}
            />
            {children.length > 0 && expanded && (
              <div className="mt-0.5 space-y-0.5">
                {children.map((c) => (
                  <NavRow
                    key={c.to}
                    to={c.to}
                    label={c.label}
                    active={isRouteActive(location, c.to)}
                    demo={c.demo}
                    indent
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <img
        src="/images/drsnip-logo.png"
        alt=""
        aria-hidden="true"
        className="h-7 w-7 shrink-0 object-contain"
      />
      <div className="leading-tight">
        <div className="text-sm font-semibold tracking-tight text-[var(--sh-fg)]">
          DrSnip Console
        </div>
        <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--sh-muted)]">
          Intake &amp; Reporting
        </div>
      </div>
    </div>
  );
}

function UserBlock({
  name,
  role,
  onLogout,
}: {
  name: string;
  role: string;
  onLogout: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-[var(--sh-border)] p-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-[var(--sh-surface)] text-xs font-semibold text-[var(--sh-muted)]">
        {name.slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-sm font-medium text-[var(--sh-fg)]"
          data-testid="admin-user-chip"
        >
          {name}
        </p>
        <p className="truncate text-xs capitalize text-[var(--sh-muted)]">
          {role === "viewer" ? "Viewer · read-only" : role}
        </p>
      </div>
      <button
        type="button"
        onClick={onLogout}
        data-testid="admin-logout-btn"
        aria-label="Sign out"
        title="Sign out"
        className="flex h-8 w-8 shrink-0 items-center justify-center text-[var(--sh-muted)] hover:bg-[var(--sh-surface-hover)] hover:text-[var(--sh-fg)]"
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}

// One error boundary for every admin page. It lives INSIDE the shell (below the
// sidebar and bars) so a page that throws never takes the navigation down with
// it. Keyed on the route by the caller, so changing page clears a prior error.
type BoundaryProps = { title: string; children: ReactNode };
type BoundaryState = { error: Error | null };

class AdminErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Left in the browser console for triage; the shell itself stays usable.
    // No PHI: React error messages carry component stacks, not record values.
    console.error("Admin page crashed:", error.name, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div
          className="mx-auto max-w-2xl px-4 py-16 text-center"
          data-testid="admin-error-boundary"
        >
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-rose-100">
            <AlertTriangle className="h-6 w-6 text-rose-600" />
          </div>
          <h1 className="text-xl font-semibold text-[var(--sh-fg)]">
            {this.props.title} didn&rsquo;t load
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--sh-muted)]">
            Something on this page threw an error. The rest of the console still
            works, so use the navigation to move on, or try again.
          </p>
          <p
            className="mx-auto mt-3 max-w-md truncate bg-slate-100 px-3 py-2 font-mono text-xs text-slate-600"
            title={this.state.error.message}
          >
            {this.state.error.message}
          </p>
          <button
            type="button"
            onClick={this.reset}
            data-testid="admin-error-retry"
            className="mt-4 inline-flex items-center gap-2 bg-[var(--sh-accent)] px-4 py-2 text-sm font-medium text-[var(--sh-accent-fg)]"
          >
            <RotateCcw className="h-4 w-4" /> Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function AdminLayout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { status, user, logout } = useAuth();
  const reduce = useReducedMotion();
  const [sheetFor, setSheetFor] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") {
      const next = encodeURIComponent(location);
      setLocation(`/admin/signin?next=${next}`, { replace: true });
    }
  }, [status, location, setLocation]);

  if (status !== "authenticated" || !user) {
    return (
      <div
        data-admin-shell
        className="flex min-h-screen items-center justify-center font-sans"
        style={{ background: "var(--sh-bg)" }}
      >
        <Loader2 className="h-6 w-6 animate-spin text-[var(--sh-muted)]" />
        <span className="sr-only">Checking your session</span>
      </div>
    );
  }

  const pageTitle = activeLabel(location);
  const openEntry = PRIMARY_NAV.find((e) => e.id === sheetFor) ?? null;

  return (
    <div
      data-admin-shell
      className="min-h-screen font-sans text-[var(--sh-fg)]"
      style={{ background: "var(--sh-bg)" }}
    >
      <a href="#admin-main" className="admin-skip-link">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside
        data-testid="admin-sidebar"
        className="fixed left-0 top-0 z-40 hidden h-screen w-64 flex-col border-r border-[var(--sh-border)] bg-[var(--sh-sidebar)] md:flex"
      >
        <div className="border-b border-[var(--sh-border)] p-4">
          <Brand />
        </div>
        <SidebarNav location={location} />
        <UserBlock
          name={user.name}
          role={user.role}
          onLogout={() => void logout()}
        />
      </aside>

      {/* Mobile top bar */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-[var(--sh-border)] bg-[var(--sh-sidebar)] px-4 md:hidden">
        <Brand />
        <span className="truncate text-sm font-medium text-[var(--sh-muted)]">
          {pageTitle}
        </span>
      </header>

      {/* Mobile bottom bar — exactly five slots, no horizontal scroll. */}
      <nav
        data-testid="admin-bottom-bar"
        aria-label="Console sections"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[var(--sh-border)] bg-[var(--sh-sidebar)] md:hidden"
      >
        {PRIMARY_NAV.map((entry) => {
          const Icon = ICON[entry.icon];
          const active = isItemActive(location, entry);
          const cls =
            "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 py-2 text-[10px] font-medium " +
            (active ? "text-[var(--sh-accent)]" : "text-[var(--sh-muted)]");
          // A slot with children — or Settings, which carries sign-out — opens a
          // sheet listing the parent first, so the main page is never hidden
          // behind its own children.
          if (opensSheet(entry)) {
            return (
              <button
                key={entry.id}
                type="button"
                className={cls}
                aria-haspopup="dialog"
                aria-expanded={sheetFor === entry.id}
                data-testid={`admin-bottom-${entry.id}`}
                onClick={() => setSheetFor(entry.id)}
              >
                <Icon className="h-5 w-5" />
                <span className="truncate">{entry.label}</span>
              </button>
            );
          }
          return (
            <Link
              key={entry.id}
              href={entry.to}
              className={cls}
              aria-current={active ? "page" : undefined}
              data-testid={`admin-bottom-${entry.id}`}
            >
              <Icon className="h-5 w-5" />
              <span className="truncate">{entry.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Mobile sheet for a grouped slot. One instance, driven by sheetFor. */}
      <Sheet
        open={openEntry !== null}
        onOpenChange={(o) => setSheetFor(o ? sheetFor : null)}
      >
        <SheetContent
          side="bottom"
          data-testid={`admin-group-sheet-${openEntry?.id ?? "none"}`}
          className="rounded-t-xl"
        >
          <SheetTitle className="mb-2 text-base">
            {openEntry?.label ?? ""}
          </SheetTitle>
          <div className="space-y-1 pb-4">
            {openEntry && (
              <NavRow
                to={openEntry.to}
                label={openEntry.selfLabel ?? openEntry.label}
                active={isRouteActive(location, openEntry.to)}
                onNavigate={() => setSheetFor(null)}
              />
            )}
            {(openEntry?.children ?? []).map((c) => (
              <NavRow
                key={c.to}
                to={c.to}
                label={c.label}
                active={isRouteActive(location, c.to)}
                demo={c.demo}
                onNavigate={() => setSheetFor(null)}
              />
            ))}
            {/* Sign-out lives here on mobile: the only logout affordance used
                to be a fixed chip overlaying page content. */}
            {openEntry?.id === "settings" && (
              <div className="mt-2 border-t border-[var(--sh-border)] pt-2">
                <div className="px-3 pb-2 text-xs text-[var(--sh-muted)]">
                  Signed in as{" "}
                  <span className="font-medium text-[var(--sh-fg)]">
                    {user.name}
                  </span>
                  {user.role === "viewer" && " · viewer, read-only"}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSheetFor(null);
                    void logout();
                  }}
                  data-testid="admin-logout-mobile"
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-[var(--sh-muted)] hover:bg-[var(--sh-surface-hover)] hover:text-[var(--sh-fg)]"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                  <ChevronRight className="ml-auto h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Main content. pb-20 clears the fixed bottom bar and is dropped at md. */}
      <main
        id="admin-main"
        className="min-h-screen min-w-0 overflow-x-hidden px-4 pb-20 pt-[4.5rem] sm:px-6 md:pb-8 md:pl-[17.5rem] md:pr-6 md:pt-8"
      >
        <div className="mx-auto min-w-0 max-w-[1400px]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location}
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              <AdminErrorBoundary key={location} title={pageTitle}>
                {children}
              </AdminErrorBoundary>
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

export default AdminLayout;
