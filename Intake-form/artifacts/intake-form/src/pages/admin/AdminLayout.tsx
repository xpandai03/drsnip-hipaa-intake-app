import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

/**
 * Wraps every /admin/* page (except /admin/signin). Reads the auth status
 * from AuthProvider; on unauthenticated, redirects to /admin/signin with a
 * `?next=` pointing at the current path so the user lands back here after
 * a successful login. Shows a floating tab nav (Links / Submissions /
 * Activity / Sources) and a user chip with logout.
 *
 * The server is the gate (every protected /api/* handler uses requireAuth).
 * This guard is UX, not security — but it removes the flash-of-content
 * problem on the client.
 *
 * Phase 1 (DrSnip): the "Held Leads" and "Scoring Rules" tabs were removed
 * along with the hold-valve and scoring subsystems.
 */

const TABS: Array<{
  to: string;
  label: string;
  match: (path: string) => boolean;
}> = [
  { to: "/admin/links", label: "Links", match: (p) => p === "/admin/links" || p === "/admin" },
  { to: "/admin/submissions", label: "Submissions", match: (p) => p.startsWith("/admin/submissions") },
  { to: "/admin/activity", label: "Activity", match: (p) => p.startsWith("/admin/activity") },
  // Phase 2 polish: the "Sources" tab (CJC marketing-source catalog) is hidden
  // — DrSnip's reworked Links page uses free-text campaign names. The
  // /admin/sources route + page code are retained for now (see App.tsx).
];

export function AdminLayout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { status, user, logout } = useAuth();

  useEffect(() => {
    if (status === "unauthenticated") {
      const next = encodeURIComponent(location);
      setLocation(`/admin/signin?next=${next}`, { replace: true });
    }
  }, [status, location, setLocation]);

  if (status !== "authenticated" || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center font-sans bg-primary">
        <Loader2 className="w-6 h-6 animate-spin text-white" />
      </div>
    );
  }

  return (
    <div className="min-h-screen font-sans bg-primary">
      {/* Tab nav — bottom-fixed on mobile (full width, evenly distributed
          tabs visible without horizontal scroll), top-center floating pill
          on md+. On /admin/links the desktop pill drops to top-32 so the
          hero CJC logo sits above it; other admin pages keep top-4. */}
      <nav
        aria-label="Admin sections"
        className={
          "fixed z-50 " +
          // Mobile: stretched along the bottom of the viewport.
          "inset-x-3 bottom-3 " +
          // md+: centered floating pill at the top (reset bottom).
          "md:inset-x-auto md:bottom-auto md:left-1/2 md:-translate-x-1/2 md:max-w-[calc(100vw-2rem)] " +
          (location === "/admin/links" || location === "/admin"
            ? "md:top-32"
            : "md:top-4")
        }
      >
        <div
          className={
            "bg-white/95 backdrop-blur rounded-full px-1.5 py-1.5 shadow-lg border border-slate-200 " +
            // 5 tabs no longer fit equally on mobile — switch to horizontal
            // scroll so labels stay readable. Desktop unchanged.
            "flex items-center gap-0.5 overflow-x-auto no-scrollbar " +
            "md:gap-1"
          }
        >
          {TABS.map((tab) => {
            const isActive = tab.match(location);
            return (
              <Link
                key={tab.to}
                href={tab.to}
                aria-current={isActive ? "page" : undefined}
                data-testid={`admin-tab-${tab.to.split("/").pop()}`}
                className={
                  "shrink-0 inline-flex items-center gap-1.5 text-center text-xs sm:text-sm font-medium px-2 sm:px-3.5 py-1.5 rounded-full transition-colors whitespace-nowrap " +
                  (isActive
                    ? "bg-primary text-white shadow-sm"
                    : "text-slate-700 hover:bg-slate-100")
                }
              >
                <span>{tab.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* User chip — top-right. */}
      <div className="fixed top-4 right-4 z-50 flex items-center gap-3 bg-white/95 backdrop-blur rounded-full pl-4 pr-2 py-2 shadow-lg border border-slate-200">
        <span
          className="text-sm font-medium text-slate-800 hidden sm:inline"
          data-testid="admin-user-chip"
        >
          {user.name}
        </span>
        {user.role === "viewer" && (
          <span
            className="inline-flex items-center rounded-full bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5 text-xs font-medium"
            title="Read-only access — you cannot delete, export, or generate links."
            data-testid="admin-role-chip"
          >
            Viewer · read-only
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void logout();
          }}
          className="h-8 px-2 text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-full"
          data-testid="admin-logout-btn"
        >
          <LogOut className="w-4 h-4" />
          <span className="sr-only">Sign out</span>
        </Button>
      </div>

      {children}
    </div>
  );
}
