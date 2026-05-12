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
 * Activity / Scoring Rules) and a user chip with logout.
 *
 * The server is the gate (every protected /api/* handler uses requireAuth).
 * This guard is UX, not security — but it removes the flash-of-content
 * problem on the client.
 */

const TABS: Array<{ to: string; label: string; match: (path: string) => boolean }> = [
  { to: "/admin/links", label: "Links", match: (p) => p === "/admin/links" || p === "/admin" },
  { to: "/admin/submissions", label: "Submissions", match: (p) => p.startsWith("/admin/submissions") },
  { to: "/admin/activity", label: "Activity", match: (p) => p.startsWith("/admin/activity") },
  { to: "/admin/scoring-rules", label: "Scoring Rules", match: (p) => p.startsWith("/admin/scoring-rules") },
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
      <div
        className="min-h-screen flex items-center justify-center"
        style={{
          background:
            "linear-gradient(135deg, #8B1A1A 0%, #A82020 40%, #C0282B 100%)",
        }}
      >
        <Loader2 className="w-6 h-6 animate-spin text-white" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {/* Floating tab nav — top-center on wide viewports, full-width on mobile.
          On /admin/links we push the nav down so the hero CJC logo sits above
          it; other admin pages keep the nav at top-4. */}
      <nav
        aria-label="Admin sections"
        className={
          "fixed left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-2rem)] " +
          (location === "/admin/links" || location === "/admin"
            ? "top-32"
            : "top-4")
        }
      >
        <div className="flex items-center gap-1 bg-white/95 backdrop-blur rounded-full px-1.5 py-1.5 shadow-lg border border-slate-200 overflow-x-auto no-scrollbar">
          {TABS.map((tab) => {
            const isActive = tab.match(location);
            return (
              <Link
                key={tab.to}
                href={tab.to}
                aria-current={isActive ? "page" : undefined}
                data-testid={`admin-tab-${tab.to.split("/").pop()}`}
                className={
                  "shrink-0 text-sm font-medium px-3.5 py-1.5 rounded-full transition-colors whitespace-nowrap " +
                  (isActive
                    ? "bg-[#A82020] text-white shadow-sm"
                    : "text-slate-700 hover:bg-slate-100")
                }
              >
                {tab.label}
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
